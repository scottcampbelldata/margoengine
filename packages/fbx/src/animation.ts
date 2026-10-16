import type { AnimationData, AnimationChannelData } from '@margoengine/exporters';
import { array, findChild, id, objectName, property, type FBXNode } from './document.js';
import { children, localParts, type SceneContext } from './scene.js';
import type { MorphBinding } from './morph.js';

interface Curve {
  times: number[];
  values: ArrayLike<number>;
  interpolation: 'LINEAR' | 'STEP';
}
const ticksPerSecond = 46186158000,
  maxKeys = 1_000_000;
function curve(node: FBXNode): Curve {
  const raw = findChild(node, 'KeyTime')?.properties[0] as ArrayLike<number | bigint> | undefined,
    values = array(node, 'KeyValueFloat');
  if (!raw || !raw.length || raw.length !== values.length || raw.length > maxKeys)
    throw new RangeError('Invalid FBX animation key count');
  const times: number[] = [];
  let previous = -1,
    mode: 'LINEAR' | 'STEP' | undefined;
  const flags = findChild(node, 'KeyAttrFlags') ? array(node, 'KeyAttrFlags') : undefined,
    refs = findChild(node, 'KeyAttrRefCount') ? array(node, 'KeyAttrRefCount') : undefined;
  if (refs) {
    if (
      !flags ||
      refs.length !== flags.length ||
      Array.from(refs).some((v) => !Number.isInteger(v) || v < 1) ||
      Array.from(refs).reduce((a, b) => a + b, 0) !== raw.length
    )
      throw new RangeError('Invalid FBX key attribute references');
  }
  if (flags) {
    if (!flags.length || (!refs && flags.length !== 1 && flags.length !== raw.length))
      throw new RangeError('Invalid FBX key flags');
    for (let i = 0; i < flags.length; i++) {
      const bits = flags[i] & 14,
        next = bits === 2 ? 'STEP' : bits === 4 ? 'LINEAR' : undefined;
      if (bits === 2 && flags[i] & 0x100) throw new TypeError('Unsupported FBX constant-next interpolation');
      if (!next) throw new TypeError(`Unsupported FBX cubic animation: ${objectName(node)}`);
      if (mode && mode !== next) throw new TypeError('Unsupported FBX mixed animation interpolation');
      mode = next;
    }
  }
  for (let i = 0; i < raw.length; i++) {
    const time = Number(raw[i]) / ticksPerSecond;
    if (!Number.isFinite(time) || time < 0 || time <= previous || !Number.isFinite(values[i]))
      throw new RangeError('Invalid FBX animation key');
    times.push(time);
    previous = time;
  }
  return { times, values, interpolation: mode ?? 'LINEAR' };
}
function sample(c: Curve, time: number): number {
  let lo = 0,
    hi = c.times.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (c.times[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  const next = Math.min(lo + 1, c.times.length - 1);
  if (c.interpolation === 'STEP' || lo === next || time <= c.times[lo]) return c.values[lo];
  const alpha = Math.min(1, (time - c.times[lo]) / (c.times[next] - c.times[lo]));
  return c.values[lo] * (1 - alpha) + c.values[next] * alpha;
}
function commonTimes(curves: Curve[]): number[] {
  const values = new Set<number>();
  let mode: string | undefined;
  for (const c of curves) {
    if (mode && mode !== c.interpolation) throw new TypeError('Unsupported FBX mixed animation interpolation');
    mode = c.interpolation;
    for (const t of c.times) {
      values.add(t);
      if (values.size > maxKeys) throw new RangeError('FBX animation key budget exceeded');
    }
  }
  const result = [...values].sort((a, b) => a - b);
  for (let i = 1; i < result.length; i++)
    if (Math.fround(result[i]) <= Math.fround(result[i - 1]))
      throw new RangeError('FBX animation times collapse in Float32');
  return result;
}
type Axes = (Curve | undefined)[];
type Parts = ReturnType<typeof localParts>;
function createLocalSampler(
  ctx: SceneContext,
  model: FBXNode,
  tracks: Map<string, Axes>,
  beforeSample: () => void,
): (time: number) => Parts {
  const defaults = {
    translation: property(model, 'Lcl Translation', [0, 0, 0]),
    rotation: property(model, 'Lcl Rotation', [0, 0, 0]),
    scale: property(model, 'Lcl Scaling', [1, 1, 1]),
  };
  const hasModelChildren = children(ctx, id(model.properties[0])).some((n) => n.name === 'Model');
  let samples = 0;
  return function sampleLocal(time: number): Parts {
    beforeSample();
    if ((++samples & 255) === 0) ctx.signal?.throwIfAborted();
    const override: { translation?: number[]; rotation?: number[]; scale?: number[] } = {};
    for (const [name, path] of [
      ['Lcl Translation', 'translation'],
      ['Lcl Rotation', 'rotation'],
      ['Lcl Scaling', 'scale'],
    ] as const) {
      const axes = tracks.get(name);
      if (axes)
        override[path] = [0, 1, 2].map((k) =>
          axes[k] ? sample(axes[k]!, time) : (defaults[path] as ArrayLike<number>)[k],
        );
    }
    if (
      hasModelChildren &&
      override.scale &&
      (Math.abs(override.scale[0] - override.scale[1]) > 1e-7 || Math.abs(override.scale[1] - override.scale[2]) > 1e-7)
    )
      throw new TypeError('Unsupported FBX animated nonuniform parent scale');
    return localParts(ctx, model, override);
  };
}

function keepQuaternionHemisphere(previous: Float32Array, next: Float32Array): void {
  let dot = 0;
  for (let k = 0; k < 4; k++) dot += previous[k] * next[k];
  // q and -q describe the same rotation; matching signs selects the short arc.
  if (dot < 0) for (let k = 0; k < 4; k++) next[k] *= -1;
}

function refineTimes(seed: number[], evaluate: (time: number) => Parts, rotation: Axes | undefined): number[] {
  const out = [seed[0]];
  let work = 0;
  const acceptable = (a: Parts, b: Parts, p: Parts, alpha: number) => {
    for (const key of ['translation', 'scale'] as const)
      for (let k = 0; k < 3; k++) {
        const expected = a[key][k] * (1 - alpha) + b[key][k] * alpha;
        if (Math.abs(p[key][k] - expected) > 1e-5 * Math.max(1, Math.abs(p[key][k]), Math.abs(expected))) return false;
      }
    let dot = 0;
    for (let k = 0; k < 4; k++) dot += a.rotation[k] * b.rotation[k];
    const sign = dot < 0 ? -1 : 1;
    dot = Math.min(1, Math.abs(dot));
    let x = 1 - alpha,
      y = alpha;
    if (dot < 0.9995) {
      const angle = Math.acos(dot),
        s = Math.sin(angle);
      x = Math.sin((1 - alpha) * angle) / s;
      y = Math.sin(alpha * angle) / s;
    }
    let length = 0,
      agreement = 0;
    for (let k = 0; k < 4; k++) {
      const v = a.rotation[k] * x + b.rotation[k] * y * sign;
      length += v * v;
      agreement += v * p.rotation[k];
    }
    return 1 - Math.min(1, Math.abs(agreement) / Math.sqrt(length)) <= 1.25e-9; // angular error <= 1e-4 radians
  };
  const visit = (start: number, end: number, a: Parts, b: Parts, depth: number): void => {
    if (++work > 1_000_000) throw new RangeError('FBX animation baking work budget exceeded');
    let split = rotation?.some((c) => c && Math.abs(sample(c, end) - sample(c, start)) > 45) ?? false;
    for (const alpha of [0.25, 0.5, 0.75])
      if (!acceptable(a, b, evaluate(start + (end - start) * alpha), alpha)) split = true;
    if (split) {
      const mid = (start + end) / 2;
      if (depth >= 18 || Math.fround(mid) <= Math.fround(start) || Math.fround(mid) >= Math.fround(end))
        throw new RangeError('FBX animation cannot meet baking tolerance');
      const p = evaluate(mid);
      visit(start, mid, a, p, depth + 1);
      visit(mid, end, p, b, depth + 1);
    } else {
      out.push(end);
      if (out.length > 200_000) throw new RangeError('FBX baked animation key budget exceeded');
    }
  };
  for (let i = 1; i < seed.length; i++) visit(seed[i - 1], seed[i], evaluate(seed[i - 1]), evaluate(seed[i]), 0);
  return out;
}
function axes(ctx: SceneContext, node: FBXNode, cache: Map<bigint, Curve>): Axes {
  const out: Axes = [];
  for (const c of ctx.incoming.get(id(node.properties[0])) ?? []) {
    const source = ctx.document.objects.get(c.child)!;
    if (c.kind !== 'OP' || source.name !== 'AnimationCurve') continue;
    const axis = ['d|X', 'd|Y', 'd|Z'].indexOf(c.property ?? '');
    if (axis === -1) throw new TypeError('Unsupported FBX animation axis');
    if (out[axis]) throw new TypeError('Duplicate FBX animation axis');
    let data = cache.get(c.child);
    if (!data) {
      data = curve(source);
      cache.set(c.child, data);
    }
    out[axis] = data;
  }
  return out;
}

export function buildAnimations(ctx: SceneContext, morphs: MorphBinding[]): AnimationData[] {
  const clips: AnimationData[] = [],
    cache = new Map<bigint, Curve>();
  let totalValues = 0,
    bakingSamples = 0;
  const reserve = (count: number) => {
    totalValues += count;
    if (totalValues > 16_000_000) throw new RangeError('FBX animation byte budget exceeded');
    ctx.signal?.throwIfAborted();
  };
  for (const stack of ctx.document.objects.values()) {
    if (stack.name !== 'AnimationStack') continue;
    const models = new Map<bigint, Map<string, Axes>>(),
      weights = new Map<bigint, Curve>(),
      channels: AnimationChannelData[] = [];
    const layers = children(ctx, id(stack.properties[0])).filter((n) => n.name === 'AnimationLayer');
    if (layers.length > 1) throw new TypeError('Unsupported FBX animation layer blending');
    for (const layer of layers) {
      if (Number(property(layer, 'Weight', 100)) !== 100 || Number(property(layer, 'Mute', 0)) !== 0)
        throw new TypeError('Unsupported FBX animation layer blending');
      if (Number(property(layer, 'BlendMode', 0)) !== 0) throw new TypeError('Unsupported FBX animation layer mode');
      for (const track of children(ctx, id(layer.properties[0])).filter((n) => n.name === 'AnimationCurveNode')) {
        const tracks = axes(ctx, track, cache);
        if (!tracks.some(Boolean)) continue;
        for (const target of ctx.outgoing.get(id(track.properties[0])) ?? []) {
          if (target.kind !== 'OP') continue;
          const path = target.property ?? '';
          if (path === 'DeformPercent') {
            if (tracks.filter(Boolean).length !== 1 || !tracks[0])
              throw new TypeError('Unsupported FBX morph curve axes');
            if (weights.has(target.parent)) throw new TypeError('Duplicate animation target');
            weights.set(target.parent, tracks[0]);
            continue;
          }
          if (!['Lcl Translation', 'Lcl Rotation', 'Lcl Scaling'].includes(path))
            throw new TypeError(`Unsupported FBX animated property: ${path}`);
          if (!ctx.models.has(target.parent)) throw new TypeError('FBX animation target is not a model');
          const record = models.get(target.parent) ?? new Map<string, Axes>();
          if (record.has(path)) throw new TypeError('Duplicate animation target');
          record.set(path, tracks);
          models.set(target.parent, record);
        }
      }
    }
    for (const [key, tracks] of models) {
      const model = ctx.models.get(key)!,
        node = ctx.nodes.get(key)!,
        all = [...tracks.values()].flat().filter((c): c is Curve => !!c),
        interpolation = all[0].interpolation;
      const sampleLocal = createLocalSampler(ctx, model, tracks, () => {
        if (++bakingSamples > 100_000) throw new RangeError('FBX animation sampling work budget exceeded');
      });
      const seed = commonTimes(all),
        times = interpolation === 'LINEAR' ? refineTimes(seed, sampleLocal, tracks.get('Lcl Rotation')) : seed;
      reserve(times.length * 11);
      const outputs = {
        translation: new Float32Array(times.length * 3),
        rotation: new Float32Array(times.length * 4),
        scale: new Float32Array(times.length * 3),
      };
      for (let i = 0; i < times.length; i++) {
        const value = sampleLocal(times[i]);
        outputs.translation.set(value.translation, i * 3);
        outputs.rotation.set(value.rotation, i * 4);
        outputs.scale.set(value.scale, i * 3);
        if (i)
          keepQuaternionHemisphere(
            outputs.rotation.subarray((i - 1) * 4, i * 4),
            outputs.rotation.subarray(i * 4, i * 4 + 4),
          );
      }
      for (const [name, path, width] of [
        ['Lcl Translation', 'translation', 3],
        ['Lcl Rotation', 'rotation', 4],
        ['Lcl Scaling', 'scale', 3],
      ] as const) {
        const rest = node[path] ?? (path === 'rotation' ? [0, 0, 0, 1] : path === 'scale' ? [1, 1, 1] : [0, 0, 0]);
        if (tracks.has(name) || outputs[path].some((v, i) => Math.abs(v - rest[i % width]) > 1e-6))
          channels.push({ node, path, interpolation, times: Float32Array.from(times), values: outputs[path] });
      }
    }
    for (const binding of morphs) {
      const curves = binding.channels.map((key) => weights.get(key)),
        all = curves.filter((c): c is Curve => !!c);
      if (!all.length) continue;
      const times = commonTimes(all),
        width = curves.length;
      reserve(times.length * (width + 1));
      const values = new Float32Array(times.length * width);
      for (let i = 0; i < times.length; i++)
        for (let k = 0; k < width; k++)
          values[i * width + k] = curves[k] ? sample(curves[k]!, times[i]) / 100 : binding.mesh.node.morphWeights![k];
      channels.push({
        node: binding.mesh.node,
        path: 'weights',
        interpolation: all[0].interpolation,
        times: Float32Array.from(times),
        values,
      });
    }
    for (const key of weights.keys())
      if (!morphs.some((m) => m.channels.includes(key))) throw new TypeError('FBX morph animation has no shape target');
    if (channels.length) clips.push({ name: objectName(stack), channels });
  }
  return clips;
}
