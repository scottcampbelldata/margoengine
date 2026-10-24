// COLLADA <library_animations> and <library_animation_clips>: samplers (LINEAR, STEP, BEZIER, HERMITE) and channels
// that address node transform elements or morph weights. Written from the COLLADA 1.4.1 and 1.5 specifications.
import { LoaderError } from './types.js';
import { block, F, kid, kids, numbers, ref, sourcesOf, TRANSFORM_SIZES, type DAETransform } from './dae-common.js';
import type { DAEMorph } from './dae-controllers.js';
import type { XMLElement } from './xml.js';

/** How a sampler moves from one key to the next. */
export type DAEInterpolation = 'LINEAR' | 'STEP' | 'BEZIER' | 'HERMITE';

/** A `<sampler>`: key times, values and per-key interpolation, as written (the file's axes and units). */
export interface DAESampler {
  /** Key times in seconds, increasing. */
  input: Float64Array;
  /** `stride` values per key. */
  output: Float64Array;
  stride: number;
  /** The interpolation from each key to the next. */
  interpolations: DAEInterpolation[];
  /** BEZIER and HERMITE tangents, `tangentStride` values per key: `(time, value)` pairs per component, or values. */
  inTangents?: Float64Array;
  outTangents?: Float64Array;
  tangentStride?: number;
}

/**
 * A `<channel>`. A transform channel names a node (`node`) and one element of its transform stack (`transform`, the
 * element's sid); a weights channel names a morph (`morph`). `index` is the first value written: a component of the
 * transform's values (`.X` 0, `.Y` 1, `.Z` 2, `.ANGLE` 3, `(i)`, and `(row)(column)` as row * 4 + column in a
 * matrix's row-major values) or a weight `(i)`; without it the channel writes all the values.
 */
export interface DAEAnimationChannel {
  /** The `target` attribute as written. */
  target: string;
  node?: string;
  transform?: string;
  morph?: number;
  index?: number;
  sampler: DAESampler;
}

/** An `<animation>`; nested animations are listed too, each naming its `parent` (-1 at the top). */
export interface DAEAnimation {
  id?: string;
  name?: string;
  parent: number;
  channels: DAEAnimationChannel[];
}

/** An `<animation_clip>`: a time range over some animations (and the animations nested in them). */
export interface DAEClip {
  id?: string;
  name?: string;
  /** Start in seconds (default 0). */
  start: number;
  /** End in seconds, when given. */
  end?: number;
  /** Indices into `LoadedDAE.animations`. */
  animations: number[];
}

const SELECTORS: Record<string, number> = {
  X: 0,
  Y: 1,
  Z: 2,
  W: 3,
  ANGLE: 3,
  R: 0,
  G: 1,
  B: 2,
  A: 3,
  U: 0,
  V: 1,
  S: 0,
  T: 1,
  P: 2,
  Q: 3,
};

/** A target's last part: the sid or id, and the value index its `.member` or `(i)(j)` selector names. */
function selector(part: string, rows = 4): { name: string; index?: number } | undefined {
  const match = /^([^.(]*)(?:\.([A-Za-z]+)|((?:\(\d+\))+))?$/.exec(part);
  if (!match) return;
  const [, name, member, array] = match;
  if (member !== undefined) {
    const index = SELECTORS[member.toUpperCase()];
    return index === undefined ? undefined : { name, index };
  }
  if (array === undefined) return { name };
  const indices = [...array.matchAll(/\((\d+)\)/g)].map((m) => Number(m[1]));
  if (indices.length > 2) return;
  return { name, index: indices.length === 2 ? indices[0] * rows + indices[1] : indices[0] };
}

const KINDS: readonly string[] = ['LINEAR', 'STEP', 'BEZIER', 'HERMITE'];

function readSampler(
  sampler: XMLElement,
  source: ReturnType<typeof sourcesOf>,
  what: string,
  warn: (message: string) => void,
): DAESampler {
  const inputs = new Map(kids(sampler, 'input').map((i) => [i.attributes.semantic, i.attributes.source]));
  if (!inputs.has('INPUT') || !inputs.has('OUTPUT'))
    throw new LoaderError(F, 'syntax', `${what} sampler needs INPUT and OUTPUT inputs`);
  const input = source(inputs.get('INPUT')),
    output = source(inputs.get('OUTPUT')),
    count = input.count || input.data.length,
    times = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    const time = input.data[input.offset + k * input.stride];
    if (!Number.isFinite(time) || (k && time < times[k - 1]))
      throw new LoaderError(F, 'syntax', `${what} key ${k} time ${time} is not finite and increasing`);
    times[k] = time;
  }
  if (!count) throw new LoaderError(F, 'syntax', `${what} sampler has no keys`);
  const stride = output.stride,
    values = new Float64Array(count * stride);
  if (output.count < count)
    throw new LoaderError(F, 'truncated', `${what} has ${count} key times but ${output.count} output values`);
  for (let k = 0; k < count; k++) values.set(block(output, k, stride), k * stride);
  const names = inputs.has('INTERPOLATION') ? (source(inputs.get('INTERPOLATION')).names ?? []) : [];
  let tangents = false;
  const interpolations = Array.from({ length: count }, (_, k): DAEInterpolation => {
    const name = names[k] ?? names[0] ?? 'LINEAR';
    if (KINDS.includes(name)) {
      tangents ||= name === 'BEZIER' || name === 'HERMITE';
      return name as DAEInterpolation;
    }
    warn(`${what}: ${name.slice(0, 16)} interpolation is sampled as LINEAR`);
    return 'LINEAR';
  });
  const result: DAESampler = { input: times, output: values, stride, interpolations };
  if (!tangents) return result;
  if (!inputs.has('IN_TANGENT') || !inputs.has('OUT_TANGENT')) {
    warn(`${what}: BEZIER or HERMITE keys without IN_TANGENT and OUT_TANGENT are sampled as LINEAR`);
    result.interpolations = interpolations.map((i) => (i === 'STEP' ? i : 'LINEAR'));
    return result;
  }
  const inTangent = source(inputs.get('IN_TANGENT')),
    outTangent = source(inputs.get('OUT_TANGENT')),
    tangentStride = inTangent.stride;
  if (
    outTangent.stride !== tangentStride ||
    (tangentStride !== stride && tangentStride !== stride * 2) ||
    inTangent.count < count ||
    outTangent.count < count
  )
    throw new LoaderError(F, 'syntax', `${what} tangents must have ${stride} or ${stride * 2} values per key`);
  result.inTangents = new Float64Array(count * tangentStride);
  result.outTangents = new Float64Array(count * tangentStride);
  for (let k = 0; k < count; k++) {
    result.inTangents.set(block(inTangent, k, tangentStride), k * tangentStride);
    result.outTangents.set(block(outTangent, k, tangentStride), k * tangentStride);
  }
  result.tangentStride = tangentStride;
  return result;
}

/** Reads every `<animation>` (nested ones too) and `<animation_clip>`. */
export function readAnimations(
  root: XMLElement,
  ids: Map<string, XMLElement>,
  morphs: readonly DAEMorph[],
  warn: (message: string) => void,
): { animations: DAEAnimation[]; clips: DAEClip[] } {
  const animations: DAEAnimation[] = [],
    index = new Map<XMLElement, number>(),
    morphOf = new Map<string, number>();
  morphs.forEach((morph, i) => {
    morphOf.set(morph.id, i);
    if (morph.weightsSource) morphOf.set(morph.weightsSource, i);
  });
  const channelOf = (target: string, sampler: DAESampler): DAEAnimationChannel | undefined => {
    const slash = target.indexOf('/'),
      first = slash < 0 ? target : target.slice(0, slash),
      rest = slash < 0 ? '' : target.slice(slash + 1);
    // A weights channel: "morph/weights(i)" or "weightsSource(i)".
    const direct = slash < 0 ? selector(first) : undefined,
      morph = morphOf.get(direct ? direct.name : first);
    if (morph !== undefined) {
      const part = direct ?? selector(rest);
      if (!part) return;
      const width = part.index === undefined ? morphs[morph].weights.length : 1;
      if ((part.index ?? 0) >= morphs[morph].weights.length || sampler.stride !== width) return;
      const channel: DAEAnimationChannel = { target, morph, sampler };
      if (part.index !== undefined) channel.index = part.index;
      return channel;
    }
    const node = ids.get(first.startsWith('./') ? first.slice(2) : first);
    if (node?.name !== 'node' || !rest || rest.includes('/')) return;
    const part = selector(rest),
      element =
        part && node.children.find((c) => c.attributes.sid === part.name && Object.hasOwn(TRANSFORM_SIZES, c.name));
    if (!part || !element) return;
    const size = TRANSFORM_SIZES[element.name as DAETransform['type']];
    if ((part.index ?? 0) >= size || sampler.stride !== (part.index === undefined ? size : 1)) return;
    const channel: DAEAnimationChannel = { target, node: first, transform: part.name, sampler };
    if (part.index !== undefined) channel.index = part.index;
    return channel;
  };
  const read = (e: XMLElement, parent: number, depth: number): void => {
    if (depth > 64) throw new LoaderError(F, 'limit', 'animations nest deeper than 64');
    const animation: DAEAnimation = { parent, channels: [] },
      at = animations.length,
      what = `animation "${e.attributes.id ?? e.attributes.name ?? at}"`,
      source = sourcesOf(e, ids, what);
    if (e.attributes.id !== undefined) animation.id = e.attributes.id;
    if (e.attributes.name !== undefined) animation.name = e.attributes.name;
    animations.push(animation);
    index.set(e, at);
    const samplers = new Map<string, DAESampler>();
    for (const channel of kids(e, 'channel')) {
      const id = ref(channel.attributes.source),
        target = channel.attributes.target ?? '',
        element = kids(e, 'sampler').find((s) => s.attributes.id === id);
      if (!element) {
        warn(`${what} channel "${target}" names no <sampler> "${id}"`);
        continue;
      }
      let sampler = samplers.get(id);
      if (!sampler) samplers.set(id, (sampler = readSampler(element, source, `${what} sampler "${id}"`, warn)));
      const loaded = channelOf(target, sampler);
      if (loaded) animation.channels.push(loaded);
      else warn(`${what} channel "${target}" is not imported: it names no node transform or morph weight it fits`);
    }
    for (const child of kids(e, 'animation')) read(child, at, depth + 1);
  };
  for (const e of kids(kid(root, 'library_animations'), 'animation')) read(e, -1, 0);
  const clips: DAEClip[] = [];
  for (const e of kids(kid(root, 'library_animation_clips'), 'animation_clip')) {
    const number = (name: string): number | undefined => {
      const text = e.attributes[name];
      if (text === undefined) return;
      const value = numbers(text, `animation_clip ${name}`)[0];
      if (!Number.isFinite(value)) throw new LoaderError(F, 'syntax', `animation_clip ${name} must be a finite number`);
      return value;
    };
    const clip: DAEClip = { start: number('start') ?? 0, animations: [] },
      end = number('end');
    if (e.attributes.id !== undefined) clip.id = e.attributes.id;
    if (e.attributes.name !== undefined) clip.name = e.attributes.name;
    if (end !== undefined) clip.end = end;
    for (const instance of kids(e, 'instance_animation')) {
      const found = ids.get(ref(instance.attributes.url)),
        at = found && index.get(found);
      if (at === undefined) warn(`animation_clip instance_animation "${instance.attributes.url}" names no <animation>`);
      else clip.animations.push(at);
    }
    clips.push(clip);
  }
  return { animations, clips };
}

/** x(s) or y(s) of a cubic Bezier with control values a, b, c, d. */
const bezier = (a: number, b: number, c: number, d: number, s: number): number => {
  const u = 1 - s;
  return u * u * u * a + 3 * u * u * s * b + 3 * u * s * s * c + s * s * s * d;
};

/**
 * A sampler's values at `time` seconds: the first key's before it, the last key's after it, else the segment's
 * interpolation. BEZIER segments are 2D curves through (time, value) control points: OUT_TANGENT of the key and
 * IN_TANGENT of the next one, solved for the time (value-only tangents sit at a third of the segment). HERMITE uses the
 * value part of the tangents as derivatives over the segment's normalised time.
 */
export function sampleDAESampler(sampler: DAESampler, time: number, out?: Float64Array): Float64Array {
  if (typeof time !== 'number' || !Number.isFinite(time))
    throw new RangeError(`DAE sample time ${time} is invalid; pass finite seconds`);
  const { input, output, stride } = sampler,
    last = input.length - 1;
  out ??= new Float64Array(stride);
  if (out.length < stride) throw new RangeError(`DAE sample target must hold ${stride} numbers; pass a larger array`);
  let a = 0;
  if (time >= input[last]) a = last;
  else if (time > input[0])
    for (let hi = last; a + 1 < hi; ) {
      const mid = (a + hi) >> 1;
      if (input[mid] <= time) a = mid;
      else hi = mid;
    }
  const kind = sampler.interpolations[a];
  if (a === last || time <= input[a] || kind === 'STEP' || input[a + 1] <= input[a]) {
    out.set(output.subarray(a * stride, a * stride + stride));
    return out;
  }
  const t0 = input[a],
    t1 = input[a + 1],
    dt = t1 - t0,
    s = (time - t0) / dt,
    ts = sampler.tangentStride ?? 0,
    pairs = ts === stride * 2,
    inT = sampler.inTangents,
    outT = sampler.outTangents;
  for (let c = 0; c < stride; c++) {
    const p0 = output[a * stride + c],
      p1 = output[(a + 1) * stride + c];
    if (kind === 'LINEAR' || !inT || !outT) {
      out[c] = p0 + (p1 - p0) * s;
      continue;
    }
    const o = (a * ts + (pairs ? c * 2 : c)) | 0,
      i = ((a + 1) * ts + (pairs ? c * 2 : c)) | 0;
    if (kind === 'HERMITE') {
      const m0 = pairs ? outT[o + 1] : outT[o],
        m1 = pairs ? inT[i + 1] : inT[i],
        s2 = s * s,
        s3 = s2 * s;
      out[c] = (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1;
      continue;
    }
    const x1 = pairs ? outT[o] : t0 + dt / 3,
      y1 = pairs ? outT[o + 1] : outT[o],
      x2 = pairs ? inT[i] : t1 - dt / 3,
      y2 = pairs ? inT[i + 1] : inT[i];
    // Solve x(u) = time on [0, 1]; x is monotonic for well-formed curves, so bisection always converges.
    let lo = 0,
      hi = 1,
      u = s;
    for (let n = 0; n < 60; n++) {
      u = (lo + hi) / 2;
      if (bezier(t0, x1, x2, t1, u) < time) lo = u;
      else hi = u;
    }
    out[c] = bezier(p0, y1, y2, p1, u);
  }
  return out;
}

/** The transform values a node's channels give at `time` (copies; the node's own stack is left as is). */
export function animateTransforms(
  transforms: readonly DAETransform[],
  channels: readonly DAEAnimationChannel[],
  time: number,
): DAETransform[] {
  const out = transforms.map((t) => ({ ...t, values: [...t.values] }));
  for (const channel of channels) {
    const transform = out.find((t) => t.sid === channel.transform);
    if (!transform) continue;
    const value = sampleDAESampler(channel.sampler, time);
    if (channel.index === undefined) for (let k = 0; k < transform.values.length; k++) transform.values[k] = value[k];
    else transform.values[channel.index] = value[0];
  }
  return out;
}
