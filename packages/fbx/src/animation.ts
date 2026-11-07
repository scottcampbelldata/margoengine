import type { AnimationData, AnimationChannelData } from '@margoengine/exporters';
import { array, findChild, id, objectName, property, type FBXNode } from './document.js';
import { children, localParts, type SceneContext } from './scene.js';
import type { MorphBinding } from './morph.js';

export interface Curve {
  times: number[];
  values: ArrayLike<number>;
  interpolation: 'LINEAR' | 'STEP';
  /** The value at a time, for a curve that is not straight between its keys. */
  at?: (time: number) => number;
  /** Times the value jumps at. */
  breaks?: number[];
  /** Degrees that come back in range, so two samples say nothing of the turn between them. */
  wrapped?: boolean;
}
/** What one animation layer holds: per model, its paths' axes; per blend channel, its weight curve. */
export interface StackTracks {
  models: Map<bigint, Map<string, Axes>>;
  weights: Map<bigint, Curve>;
}
/** The readers an extension blends layers with. */
export interface LayerRead {
  layer(node: FBXNode): StackTracks;
  /** The curve under an animation curve node, as on a layer's Weight. */
  weight(key: bigint): Curve | undefined;
  sample(curve: Curve, time: number): number;
}
const ticksPerSecond = 46186158000,
  maxKeys = 1_000_000,
  animated = ['Lcl Translation', 'Lcl Rotation', 'Lcl Scaling', 'DeformPercent'];
function curve(ctx: SceneContext, node: FBXNode): Curve {
  const raw = findChild(node, 'KeyTime')?.properties[0] as ArrayLike<number | bigint> | undefined,
    values = array(node, 'KeyValueFloat');
  if (!raw || !raw.length || raw.length !== values.length || raw.length > maxKeys)
    throw new RangeError('Invalid FBX animation key count; re-export the file, it looks damaged');
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
      throw new RangeError('Invalid FBX key attribute references; re-export the file, it looks damaged');
  }
  const reader = ctx.extensions.find((extension) => extension.curve);
  if (flags && !reader) {
    if (!flags.length || (!refs && flags.length !== 1 && flags.length !== raw.length))
      throw new RangeError('Invalid FBX key flags; re-export the file, it looks damaged');
    for (let i = 0; i < flags.length; i++) {
      const bits = flags[i] & 14,
        next = bits === 2 ? 'STEP' : bits === 4 ? 'LINEAR' : undefined;
      if (bits === 2 && flags[i] & 0x100)
        throw new TypeError(
          'Unsupported FBX constant-next interpolation; bake or remove it in your 3D tool before export',
        );
      if (!next)
        throw new TypeError(
          `Unsupported FBX cubic animation: ${objectName(node)}; bake or remove it in your 3D tool before export`,
        );
      if (mode && mode !== next)
        throw new TypeError(
          'Unsupported FBX mixed animation interpolation; bake or remove it in your 3D tool before export',
        );
      mode = next;
    }
  }
  for (let i = 0; i < raw.length; i++) {
    const time = Number(raw[i]) / ticksPerSecond;
    if (!Number.isFinite(time) || time < 0 || time <= previous || !Number.isFinite(values[i]))
      throw new RangeError('Invalid FBX animation key; re-export the file, it looks damaged');
    times.push(time);
    previous = time;
  }
  return reader ? reader.curve!(node, times, values) : { times, values, interpolation: mode ?? 'LINEAR' };
}
function sample(c: Curve, time: number): number {
  if (c.at) return c.at(time);
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
const float = new Float32Array(1),
  floatBits = new Uint32Array(float.buffer);
/** The Float32 just below a positive time: glTF has no jump, so one is two keys as close as its times allow. */
function justBefore(time: number): number {
  float[0] = time;
  floatBits[0]--;
  return float[0];
}
/** The first key of each jump, which no refining can improve on. */
function jumpStarts(curves: Curve[]): Set<number> {
  const out = new Set<number>();
  for (const c of curves) for (const t of c.breaks ?? []) if (t > c.times[0]) out.add(justBefore(t));
  return out;
}
function commonTimes(curves: Curve[]): number[] {
  const values = new Set<number>();
  let mode: string | undefined;
  for (const c of curves) {
    if (mode && mode !== c.interpolation)
      throw new TypeError(
        'Unsupported FBX mixed animation interpolation; bake or remove it in your 3D tool before export',
      );
    mode = c.interpolation;
    for (const t of c.times) {
      values.add(t);
      if (values.size > maxKeys)
        throw new RangeError(
          'FBX animation key budget exceeded; simplify or split the scene, the import limits are listed in the README',
        );
    }
    for (const t of c.breaks ?? []) values.add(t);
  }
  for (const t of jumpStarts(curves)) values.add(t);
  const result = [...values].sort((a, b) => a - b);
  for (let i = 1; i < result.length; i++)
    if (Math.fround(result[i]) <= Math.fround(result[i - 1]))
      throw new RangeError(
        'FBX animation times collapse in Float32; simplify or split the scene, the import limits are listed in the README',
      );
  return result;
}
export type Axes = (Curve | undefined)[];
type Parts = ReturnType<typeof localParts>;
function createLocalSampler(
  ctx: SceneContext,
  model: FBXNode,
  tracks: Map<string, Axes>,
): (time: number) => Parts {
  const defaults = {
    translation: property(model, 'Lcl Translation', [0, 0, 0]),
    rotation: property(model, 'Lcl Rotation', [0, 0, 0]),
    scale: property(model, 'Lcl Scaling', [1, 1, 1]),
  };
  const hasModelChildren = children(ctx, id(model.properties[0])).some((n) => n.name === 'Model');
  let samples = 0;
  return function sampleLocal(time: number): Parts {
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
      throw new TypeError(
        'Unsupported FBX animated nonuniform parent scale; bake or remove it in your 3D tool before export',
      );
    return localParts(ctx, model, override, true);
  };
}

function keepQuaternionHemisphere(previous: Float32Array, next: Float32Array): void {
  let dot = 0;
  for (let k = 0; k < 4; k++) dot += previous[k] * next[k];
  // q and -q describe the same rotation; matching signs selects the short arc.
  if (dot < 0) for (let k = 0; k < 4; k++) next[k] *= -1;
}

/** Whether a straight glTF segment from a to b passes through p, a sample at `alpha` of it. */
function partsAgree(a: Parts, b: Parts, p: Parts, alpha: number): boolean {
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
}

/** Adds keys until straight segments meet `acceptable`; the segment of a jump stays as it is. */
function refineTimes<T>(
  seed: number[],
  evaluate: (time: number) => T,
  acceptable: (a: T, b: T, p: T, alpha: number) => boolean,
  jumps: Set<number>,
  mustSplit: (start: number, end: number) => boolean = () => false,
  /** Blended angles can truly jump where the nearest set of angles changes: such a segment ends at the search's depth. */
  mayJump = false,
): number[] {
  const out = [seed[0]];
  let work = 0;
  const visit = (start: number, end: number, a: T, b: T, depth: number): void => {
    if (++work > 1_000_000)
      throw new RangeError(
        'FBX animation baking work budget exceeded; simplify or split the scene, the import limits are listed in the README',
      );
    let split = mustSplit(start, end);
    for (const alpha of [0.25, 0.5, 0.75])
      if (!acceptable(a, b, evaluate(start + (end - start) * alpha), alpha)) split = true;
    if (split) {
      const mid = (start + end) / 2;
      if (depth >= 18 && mayJump) {
        out.push(end);
        return;
      }
      if (depth >= 18 || Math.fround(mid) <= Math.fround(start) || Math.fround(mid) >= Math.fround(end))
        throw new RangeError(
          'FBX animation cannot meet baking tolerance; simplify or split the scene, the import limits are listed in the README',
        );
      const p = evaluate(mid);
      visit(start, mid, a, p, depth + 1);
      visit(mid, end, p, b, depth + 1);
    } else {
      out.push(end);
      if (out.length > 200_000)
        throw new RangeError(
          'FBX baked animation key budget exceeded; simplify or split the scene, the import limits are listed in the README',
        );
    }
  };
  for (let i = 1; i < seed.length; i++) {
    if (jumps.has(seed[i - 1])) out.push(seed[i]);
    else visit(seed[i - 1], seed[i], evaluate(seed[i - 1]), evaluate(seed[i]), 0);
  }
  return out;
}
function axes(ctx: SceneContext, node: FBXNode, cache: Map<bigint, Curve>): Axes {
  const out: Axes = [];
  for (const c of ctx.incoming.get(id(node.properties[0])) ?? []) {
    const source = ctx.document.objects.get(c.child)!;
    if (c.kind !== 'OP' || source.name !== 'AnimationCurve') continue;
    // A weight curve is d|DeformPercent, one value on the channel's first axis.
    const axis = ['d|X', 'd|Y', 'd|Z', 'd|DeformPercent'].indexOf(c.property ?? '') % 3;
    if (axis === -1)
      throw new TypeError('Unsupported FBX animation axis; bake or remove it in your 3D tool before export');
    if (out[axis]) throw new TypeError('Duplicate FBX animation axis; keep one per target when exporting');
    let data = cache.get(c.child);
    if (!data) {
      data = curve(ctx, source);
      cache.set(c.child, data);
    }
    out[axis] = data;
  }
  return out;
}

const blending = (ctx: SceneContext): boolean => ctx.extensions.some((extension) => extension.blend);

/** The curves of one animation layer, by target. */
function layerTracks(ctx: SceneContext, layer: FBXNode, cache: Map<bigint, Curve>): StackTracks {
  const models = new Map<bigint, Map<string, Axes>>(),
    weights = new Map<bigint, Curve>();
  for (const track of children(ctx, id(layer.properties[0])).filter((n) => n.name === 'AnimationCurveNode')) {
    // Curves on anything else (a lens, a light, a tool's own bookkeeping) have no glTF node channel and are left out.
    const targets = (ctx.outgoing.get(id(track.properties[0])) ?? []).filter(
      (c) => c.kind === 'OP' && animated.includes(c.property ?? ''),
    );
    if (!targets.length) continue;
    const tracks = axes(ctx, track, cache);
    // In a stack of layers, an axis with no curve still holds a value: the curve node's own, which the blend reads.
    if (blending(ctx))
      ['d|X', 'd|Y', 'd|Z'].forEach((name, k) => {
        const value = Number(property(track, name, NaN));
        if (!tracks[k] && Number.isFinite(value))
          tracks[k] = { times: [], values: [], interpolation: 'LINEAR', at: () => value };
      });
    if (!tracks.some(Boolean)) continue;
    for (const target of targets) {
      const path = target.property ?? '';
      if (path === 'DeformPercent') {
        if (tracks.filter(Boolean).length !== 1 || !tracks[0])
          throw new TypeError('Unsupported FBX morph curve axes; bake or remove it in your 3D tool before export');
        if (weights.has(target.parent))
          throw new TypeError('Duplicate animation target; keep one per target when exporting');
        weights.set(target.parent, tracks[0]);
        continue;
      }
      if (!ctx.models.has(target.parent))
        throw new TypeError('FBX animation target is not a model; animate a model node');
      const record = models.get(target.parent) ?? new Map<string, Axes>();
      if (record.has(path)) throw new TypeError('Duplicate animation target; keep one per target when exporting');
      record.set(path, tracks);
      models.set(target.parent, record);
    }
  }
  return { models, weights };
}

/** The one layer a stack may hold without the layers entry. */
function singleLayer(ctx: SceneContext, layers: FBXNode[], cache: Map<bigint, Curve>): StackTracks {
  if (layers.length > 1)
    throw new TypeError('Unsupported FBX animation layer blending; bake or remove it in your 3D tool before export');
  for (const layer of layers) {
    if (Number(property(layer, 'Weight', 100)) !== 100 || Number(property(layer, 'Mute', 0)) !== 0)
      throw new TypeError('Unsupported FBX animation layer blending; bake or remove it in your 3D tool before export');
    if (Number(property(layer, 'BlendMode', 0)) !== 0)
      throw new TypeError('Unsupported FBX animation layer mode; bake or remove it in your 3D tool before export');
    return layerTracks(ctx, layer, cache);
  }
  return { models: new Map(), weights: new Map() };
}

export function buildAnimations(ctx: SceneContext, morphs: MorphBinding[]): AnimationData[] {
  const clips: AnimationData[] = [],
    cache = new Map<bigint, Curve>(),
    blender = ctx.extensions.find((extension) => extension.blend),
    read: LayerRead = {
      layer: (node) => layerTracks(ctx, node, cache),
      weight(key) {
        for (const c of ctx.incoming.get(key) ?? []) {
          const source = ctx.document.objects.get(c.child)!;
          if (c.kind === 'OP' && source.name === 'AnimationCurve') return curve(ctx, source);
        }
      },
      sample,
    };
  let totalValues = 0;
  const reserve = (count: number) => {
    totalValues += count;
    if (totalValues > 16_000_000)
      throw new RangeError(
        'FBX animation byte budget exceeded; simplify or split the scene, the import limits are listed in the README',
      );
    ctx.signal?.throwIfAborted();
  };
  for (const stack of ctx.document.objects.values()) {
    if (stack.name !== 'AnimationStack') continue;
    const channels: AnimationChannelData[] = [],
      layers = children(ctx, id(stack.properties[0])).filter((n) => n.name === 'AnimationLayer'),
      { models, weights } = blender ? blender.blend!(ctx, layers, read) : singleLayer(ctx, layers, cache);
    for (const [key, tracks] of models) {
      const model = ctx.models.get(key)!,
        node = ctx.nodes.get(key)!,
        all = [...tracks.values()].flat().filter((c): c is Curve => !!c),
        interpolation = all[0].interpolation,
        turning = tracks.get('Lcl Rotation');
      const sampleLocal = createLocalSampler(ctx, model, tracks);
      const seed = commonTimes(all),
        times =
          interpolation === 'LINEAR'
            ? refineTimes(seed, sampleLocal, partsAgree, jumpStarts(all), (start, end) =>
                (turning ?? []).some((c) => c && !c.wrapped && Math.abs(sample(c, end) - sample(c, start)) > 45),
                !!turning?.some((c) => c?.wrapped),
              )
            : seed;
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
      const width = curves.length,
        rest = binding.mesh.node.morphWeights!,
        weightsAt = (time: number) => curves.map((c, k) => (c ? sample(c, time) / 100 : rest[k])),
        // Weights run from 0 to 1, so an absolute 1e-5 is the transform tolerance at that size.
        agree = (a: number[], b: number[], p: number[], alpha: number) =>
          p.every((v, k) => Math.abs(v - (a[k] * (1 - alpha) + b[k] * alpha)) <= 1e-5),
        seed = commonTimes(all),
        times = all.some((c) => c.at) ? refineTimes(seed, weightsAt, agree, jumpStarts(all)) : seed;
      reserve(times.length * (width + 1));
      const values = new Float32Array(times.length * width);
      for (let i = 0; i < times.length; i++) values.set(weightsAt(times[i]), i * width);
      channels.push({
        node: binding.mesh.node,
        path: 'weights',
        interpolation: all[0].interpolation,
        times: Float32Array.from(times),
        values,
      });
    }
    for (const key of weights.keys())
      if (!morphs.some((m) => m.channels.includes(key)))
        throw new TypeError('FBX morph animation has no shape target; clean up the source model before export');
    if (channels.length) clips.push({ name: objectName(stack), channels });
  }
  return clips;
}
