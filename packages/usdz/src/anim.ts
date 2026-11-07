// Time samples on transforms and visibility, as channels of the stage's clip. Attribute values follow the Value Resolution
// section of the AOUSD USD Core Specification v1.1.0: held past both ends and linear between samples. The rest was observed
// on a test stage through OpenUSD's public API: matrices blend element by element, quaternions take the short arc, a sample
// before a block holds, and an op with a blocked value drops out of the transform until its next sample.
import { decomposeAffine, type AffineDecomposition } from '@margoengine/math/affine';
import { bracket, clipOf, flat, slerp } from './clip.js';
import type { TimeSamples } from './crate.js';
import type { ExtensionHooks, SceneRead, USDExtension } from './extension.js';

/** Most keys added in one gap between samples. A longer gap gets evenly spaced keys instead of every time code. */
const MOST_BETWEEN = 4096;
/** A channel turns the short way between keys, so keys stay this close, in degrees, when an op's angle sweeps further. */
const WIDEST_TURN = 45;
/** How far before a jump the value still holds, in time codes: a clip has no two keys at one time. */
const JUST_BEFORE = 1e-3;

type Value = number | number[] | undefined;
type Parts = Omit<AffineDecomposition, 'rotation'> & { rotation: number[] };

/** An xformOp over time. */
class Op {
  private readonly samples?: TimeSamples;
  private readonly fixed: unknown;
  private readonly kind: string;
  constructor(read: SceneRead, path: string, name: string) {
    const fields = read.specs[path + '.' + name]?.fields,
      samples = fields?.timeSamples as TimeSamples | undefined;
    if (samples?.times.length) this.samples = samples;
    this.fixed = fields?.default;
    this.kind = name.split(':')[1] ?? '';
  }
  get times(): readonly number[] {
    return this.samples?.times ?? [];
  }
  /** Times the value jumps at, because a sample around them is blocked. */
  get jumps(): number[] {
    const { samples } = this;
    if (!samples) return [];
    const blocked = (i: number) => samples.values[i] === null || samples.values[i] === undefined;
    return samples.times.filter((_, i) => i > 0 && (blocked(i) || blocked(i - 1)));
  }
  at(time: number): Value {
    const { samples } = this;
    if (!samples) return this.fixed as Value;
    const [a, b, f] = bracket(samples.times, time),
      from = samples.values[a] as unknown,
      to = samples.values[b] as unknown;
    if (from === null || from === undefined) return undefined;
    if (typeof from === 'number') return typeof to === 'number' ? from + (to - from) * f : from;
    const first = flat(from);
    if (!f || to === null || to === undefined) return first;
    const last = flat(to);
    if (this.kind === 'orient') {
      // The arc is taken over unit quaternions, as the specification assumes; files do round theirs.
      const unit = (q: number[]) => q.map((x) => x / (Math.hypot(...q) || 1)),
        out = [0, 0, 0, 0];
      slerp(unit(first), unit(last), f, out, 0);
      return out;
    }
    return first.map((x, i) => x + (last[i] - x) * f);
  }
  /** The widest sweep of its angles between two times, in degrees. */
  sweep(a: number, b: number): number {
    if (!this.kind.startsWith('rotate')) return 0;
    const from = this.at(a),
      to = this.at(b);
    if (typeof from === 'number') return typeof to === 'number' ? Math.abs(to - from) : 0;
    if (!from || !Array.isArray(to)) return 0;
    return Math.max(...from.map((x, i) => Math.abs(to[i] - x)));
  }
}

/** What a clip plays at `f` between two keys, as translation, scale and rotation in one list. */
function played(a: Parts, b: Parts, f: number): number[] {
  const rotation = [0, 0, 0, 0];
  slerp(a.rotation, b.rotation, f, rotation, 0);
  return [...a.translation.map((x, i) => x + (b.translation[i] - x) * f), ...a.scale.map((x, i) => x + (b.scale[i] - x) * f), ...rotation];
}
const listed = ({ translation, scale, rotation }: Parts) => [...translation, ...scale, ...rotation];
const near = (a: number[], b: number[]) => {
  // A quaternion and its negative are one turn.
  const dot = a[6] * b[6] + a[7] * b[7] + a[8] * b[8] + a[9] * b[9],
    sign = dot < 0 ? -1 : 1;
  return a.every((x, i) => Math.abs(x - (i > 5 ? sign * b[i] : b[i])) <= 1e-5 * Math.max(1, Math.abs(x)));
};

function transforms(read: SceneRead): void {
  const clip = clipOf(read),
    shared = new Map<string, number[]>(),
    /** One seconds list per list of times, so prims keyed alike share an input. */
    secondsOf = (times: number[]) => {
      const key = times.join();
      let seconds = shared.get(key);
      if (!seconds) shared.set(key, (seconds = clip.seconds(times)));
      return seconds;
    };
  for (const [path, id] of read.nodes) {
    const order = read.opOrder(path);
    if (!order) continue;
    const ops = new Map<string, Op>();
    for (const entry of order) {
      const name = entry.replace('!invert!', '');
      if (name.startsWith('xformOp:')) ops.set(name, new Op(read, path, name));
    }
    const list = [...ops.values()],
      keys = [...new Set(list.flatMap((op) => [...op.times, ...op.jumps.map((t) => t - JUST_BEFORE)]))].sort((a, b) => a - b);
    if (keys.length < 2) continue;
    const parts = (time: number) => decomposeAffine(read.transform(path, (name) => ops.get(name)?.at(time))) as Parts,
      times: number[] = [];
    keys.forEach((time, i) => {
      times.push(time);
      const next = keys[i + 1];
      if (next === undefined || next - time <= JUST_BEFORE * 1.5) return;
      const from = parts(time),
        to = parts(next),
        sweep = Math.max(...list.map((op) => op.sweep(time, next))),
        straight =
          sweep <= WIDEST_TURN &&
          [0.25, 0.5, 0.75].every((f) => near(played(from, to, f), listed(parts(time + (next - time) * f))));
      if (straight) return;
      // What a clip plays between these keys differs from what the stage computes: frames get keys, and wide turns get more.
      const turn = ((next - time) * WIDEST_TURN) / Math.max(sweep, 1e-9),
        step = Math.max(turn < 1 ? 1 / Math.ceil(1 / turn) : 1, (next - time) / MOST_BETWEEN);
      for (let k = Math.floor(time / step) + 1; k * step < next - step * 1e-6; k++) if (k * step > time) times.push(k * step);
    });
    const count = times.length,
      all = times.map(parts),
      // A collapsed matrix has no rotation to read: it keeps its neighbour's, so a pop-in does not spin.
      open = all.map((p) => p.handedness === 'degenerate');
    for (let i = 1; i < count; i++)
      if (open[i] && !open[i - 1]) {
        all[i].rotation = all[i - 1].rotation;
        open[i] = false;
      }
    for (let i = count - 2; i >= 0; i--)
      if (open[i] && !open[i + 1]) {
        all[i].rotation = all[i + 1].rotation;
        open[i] = false;
      }
    const moved = new Float32Array(count * 3),
      sized = new Float32Array(count * 3),
      turned = new Float32Array(count * 4);
    let sheared = false,
      previous = [0, 0, 0, 1];
    all.forEach(({ translation, scale, rotation, lossless, handedness }, i) => {
      moved.set(translation, i * 3);
      sized.set(scale, i * 3);
      // Neighbouring keys take the same side, so a clip never spins the long way round.
      const dot = rotation.reduce((sum, x, k) => sum + x * previous[k], 0),
        sign = i && dot < 0 ? -1 : 1;
      previous = rotation.map((x) => x * sign);
      turned.set(previous, i * 4);
      if (!lossless && handedness !== 'degenerate') sheared = true;
    });
    const still = (data: Float32Array, width: number) => data.every((v, i) => v === data[i % width]),
      fixedMove = still(moved, 3),
      fixedTurn = still(turned, 4),
      fixedSize = still(sized, 3);
    if (fixedMove && fixedTurn && fixedSize) continue;
    if (sheared) read.soft(`the transform of ${path} shears over time, which a node cannot hold; its nearest rotation and scale play`);
    const node = read.document.nodes![id],
      seconds = secondsOf(times);
    delete node.matrix;
    node.translation = Array.from(moved.subarray(0, 3));
    node.rotation = Array.from(turned.subarray(0, 4));
    node.scale = Array.from(sized.subarray(0, 3));
    if (!fixedMove) clip.channel(id, 'translation', seconds, moved);
    if (!fixedTurn) clip.channel(id, 'rotation', seconds, turned);
    if (!fixedSize) clip.channel(id, 'scale', seconds, sized);
  }
  visibility(read, secondsOf);
}

/** Visibility holds from sample to sample. A hidden node hides what is below it, as `invisible` does on a stage. */
function visibility(read: SceneRead, secondsOf: (times: number[]) => number[]): void {
  const clip = clipOf(read),
    doc = read.document;
  for (const [path, id] of read.nodes) {
    const samples = read.specs[path + '.visibility']?.fields.timeSamples as TimeSamples | undefined;
    if (!samples?.times.length) continue;
    const shown = Uint8Array.from(samples.values, (v) => (v === 'invisible' ? 0 : 1));
    if (shown.every((v) => v === shown[0])) continue;
    const node = doc.nodes![id];
    node.extensions = { ...node.extensions, KHR_node_visibility: { visible: shown[0] === 1 } };
    clip.pointer(`/nodes/${id}/extensions/KHR_node_visibility/visible`, secondsOf([...samples.times]), shown);
    for (const name of ['KHR_node_visibility', 'KHR_animation_pointer'])
      if (!(doc.extensionsUsed ??= []).includes(name)) doc.extensionsUsed.push(name);
  }
}

/**
 * Time samples on transforms and visibility for the USD readers: pass `extensions: [composition(), animation()]`. They play
 * as the stage's clip, shared with `skeletons()`. Visibility also needs `pointerChannels` of `@margoengine/animation/pointer`.
 */
export function animation(): USDExtension {
  const hook: ExtensionHooks = { name: 'anim', scene: transforms, showsLater: true };
  return hook;
}
