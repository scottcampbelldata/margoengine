// FBX animation curves of every kind and blended animation layers. Written from the public FBX SDK reference
// (FbxAnimCurveDef flag values and data slots, FbxAnimLayer properties), Autodesk's MotionBuilder help on layer modes and
// Kochanek and Bartels 1984 for TCB tangents; see docs/clean-room.md.
import type { Axes, Curve, LayerRead, StackTracks } from './animation.js';
import { array, findChild, id, property, type FBXNode } from './document.js';
import type { ExtensionHooks, FBXExtension } from './extension.js';
import { interpolateQuaternions, multiplyQuaternions } from '@margoengine/math/quat';
import { decomposeTRS, rotationEuler } from './math.js';
import type { SceneContext } from './scene.js';

const CONSTANT = 2,
  CUBIC = 8,
  CONSTANT_NEXT = 0x100,
  TANGENT_TCB = 0x200,
  TANGENT_USER = 0x400,
  /** Generic clamp and progressive clamp: Maya's auto keys carry the second, and both are flat at a turning point. */
  TANGENT_CLAMP = 0x1000 | 0x4000,
  WEIGHTED_RIGHT = 0x1000000,
  WEIGHTED_NEXT_LEFT = 0x2000000,
  // A weight of one third of the interval is what a plain Hermite segment has.
  THIRD = 1 / 3,
  WEIGHT_SCALE = 9999;

interface Key {
  flags: number;
  right: number;
  nextLeft: number;
  rightWeight: number;
  nextLeftWeight: number;
}

/** One attribute record for each key, by KeyAttrRefCount. */
function attributes(node: FBXNode, count: number): { flags: Int32Array; data: Float32Array; bits: Uint32Array } {
  const flagsIn = findChild(node, 'KeyAttrFlags') ? array(node, 'KeyAttrFlags') : [4],
    refs = findChild(node, 'KeyAttrRefCount') ? array(node, 'KeyAttrRefCount') : undefined,
    dataIn = findChild(node, 'KeyAttrDataFloat') ? array(node, 'KeyAttrDataFloat') : [],
    flags = new Int32Array(count),
    data = new Float32Array(count * 4),
    bits = new Uint32Array(data.buffer),
    // Text files write these Float32s as the integers of their bits, slopes and packed weights alike.
    fromBits = !(dataIn instanceof Float32Array);
  let key = 0;
  for (let a = 0; a < flagsIn.length; a++) {
    const uses = refs ? refs[a] : flagsIn.length === 1 ? count : 1;
    if (!Number.isInteger(uses) || uses < 1 || key + uses > count)
      throw new RangeError('Invalid FBX key attribute references; re-export the file, it looks damaged');
    for (let i = 0; i < uses; i++, key++) {
      flags[key] = flagsIn[a];
      for (let k = 0; k < 4; k++) {
        const value = dataIn[a * 4 + k] ?? 0;
        if (fromBits && Number.isInteger(value)) bits[key * 4 + k] = value;
        else data[key * 4 + k] = value;
      }
    }
  }
  if (key !== count) throw new RangeError('Invalid FBX key attribute references; re-export the file, it looks damaged');
  return { flags, data, bits };
}

/** Kochanek-Bartels slopes of a key, per second. */
function tcb(times: number[], values: ArrayLike<number>, i: number, data: Float32Array): [number, number] {
  if (i === 0 || i === times.length - 1) return [0, 0];
  const t = data[i * 4],
    c = data[i * 4 + 1],
    b = data[i * 4 + 2],
    before = values[i] - values[i - 1],
    after = values[i + 1] - values[i],
    leftTime = times[i] - times[i - 1],
    rightTime = times[i + 1] - times[i],
    out = ((1 - t) * (1 - c) * (1 + b) * before + (1 - t) * (1 + c) * (1 - b) * after) / 2,
    into = ((1 - t) * (1 + c) * (1 + b) * before + (1 - t) * (1 - c) * (1 - b) * after) / 2;
  return [into / leftTime, out / rightTime];
}

/** An auto key's slope: the cardinal spline's, flat at the ends and, when clamped, at a turning point. */
function auto(times: number[], values: ArrayLike<number>, i: number, clamped: boolean): number {
  if (i === 0 || i === times.length - 1) return 0;
  const before = values[i] - values[i - 1],
    after = values[i + 1] - values[i];
  if (clamped && before * after <= 0) return 0;
  return (values[i + 1] - values[i - 1]) / (times[i + 1] - times[i - 1]);
}

function keysOf(node: FBXNode, times: number[], values: ArrayLike<number>): Key[] {
  const { flags, data, bits } = attributes(node, times.length),
    keys: Key[] = [],
    slopes = (i: number): [number, number] => {
      const f = flags[i];
      if (f & TANGENT_TCB) return tcb(times, values, i, data);
      // Auto keys are stored with empty slopes, which the reader works out; a tool may still have written them.
      if (!(f & TANGENT_USER) && !data[i * 4] && !data[i * 4 + 1]) {
        const slope = auto(times, values, i, !!(f & TANGENT_CLAMP));
        return [slope, slope];
      }
      return [i ? data[(i - 1) * 4 + 1] : data[i * 4], data[i * 4]];
    };
  for (let i = 0; i < times.length; i++) {
    const f = flags[i],
      weights = bits[i * 4 + 2],
      next = i + 1 < times.length ? slopes(i + 1)[0] : 0;
    keys.push({
      flags: f,
      right: slopes(i)[1],
      nextLeft: next,
      rightWeight: f & WEIGHTED_RIGHT ? (weights & 0xffff) / WEIGHT_SCALE : THIRD,
      nextLeftWeight: f & WEIGHTED_NEXT_LEFT ? (weights >>> 16) / WEIGHT_SCALE : THIRD,
    });
  }
  return keys;
}

/** A Bezier segment at `alpha` of its time: x(u) is monotonic for weights in [0, 1], so bisection cannot fail. */
function bezier(alpha: number, v0: number, v1: number, c0: number, c1: number, x1: number, x2: number): number {
  let u = alpha;
  if (x1 !== THIRD || x2 !== 1 - THIRD) {
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 40; i++) {
      u = (lo + hi) / 2;
      const r = 1 - u,
        x = 3 * r * r * u * x1 + 3 * r * u * u * x2 + u * u * u;
      if (x < alpha) lo = u;
      else hi = u;
    }
  }
  const r = 1 - u;
  return r * r * r * v0 + 3 * r * r * u * c0 + 3 * r * u * u * c1 + u * u * u * v1;
}

function evaluator(times: number[], values: ArrayLike<number>, keys: Key[]): (time: number) => number {
  const last = times.length - 1;
  return (time) => {
    if (time < times[0]) return values[0];
    if (time >= times[last]) return values[last];
    let lo = 0,
      hi = last;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (times[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    const key = keys[lo],
      mode = key.flags & 14,
      a = values[lo],
      b = values[lo + 1];
    if (mode === CONSTANT) return key.flags & CONSTANT_NEXT ? b : a;
    const span = times[lo + 1] - times[lo],
      alpha = (time - times[lo]) / span;
    if (mode !== CUBIC) return a + (b - a) * alpha;
    if (alpha === 0) return a;
    const x1 = key.rightWeight,
      x2 = 1 - key.nextLeftWeight;
    return bezier(
      alpha,
      a,
      b,
      a + key.right * key.rightWeight * span,
      b - key.nextLeft * key.nextLeftWeight * span,
      x1,
      x2,
    );
  };
}

/** Where the curve jumps: a constant key holds to the next key, or takes the next key's value at once. */
function jumps(times: number[], keys: Key[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    if ((keys[i].flags & 14) !== CONSTANT) continue;
    out.push(keys[i].flags & CONSTANT_NEXT ? times[i] : times[i + 1]);
  }
  return out;
}

interface Layer {
  mode: number;
  /** The stack's first layer holds whole values, whatever its mode says. */
  bottom: boolean;
  byChannel: boolean;
  multiply: boolean;
  weight: (time: number) => number;
  weightCurve?: Curve;
  full: boolean;
  tracks: StackTracks;
}

/** Layer weight in [0, 1] at a time: its Weight property, or the curve on it. */
function layerWeight(ctx: SceneContext, node: FBXNode, read: LayerRead): { at: (t: number) => number; curve?: Curve } {
  const fixed = Number(property(node, 'Weight', 100)) / 100;
  for (const link of ctx.incoming.get(id(node.properties[0])) ?? []) {
    if (link.kind !== 'OP' || link.property !== 'Weight') continue;
    const curve = read.weight(link.child);
    if (curve) return { at: (t) => read.sample(curve, t) / 100, curve };
  }
  return { at: () => fixed };
}

const DEGREES = 180 / Math.PI,
  IDENTITY = [0, 0, 0, 1],
  // Below this angle a linear blend of the quaternions matches the arc to Float32.
  CLOSE = 0.9995;
const quaternion = (degrees: readonly number[]): number[] => decomposeTRS(rotationEuler(degrees)).rotation;
const ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 2, 0],
  [1, 0, 2],
  [2, 0, 1],
  [2, 1, 0],
];
/** Euler degrees in an FBX order of a unit quaternion. */
export function eulerDegrees(q: readonly number[], order: number): number[] {
  const [x, y, z, w] = q,
    // Row r, column c of the rotation matrix.
    r = [
      [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
      [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
      [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ],
    [i, j, k] = ORDERS[order],
    sign = (j - i + 3) % 3 === 1 ? 1 : -1,
    out = [0, 0, 0],
    cosine = Math.hypot(r[k][j], r[k][k]);
  out[j] = Math.atan2(-sign * r[k][i], cosine);
  if (cosine > 1e-9) {
    out[i] = Math.atan2(sign * r[k][j], r[k][k]);
    out[k] = Math.atan2(sign * r[j][i], r[i][i]);
  } else out[i] = Math.atan2(-sign * r[j][k], r[j][j]);
  return out.map((v) => v * DEGREES);
}

/**
 * Of the angles that give this XYZ rotation, the set closest to `guess`. On a node of another order they are read as
 * they stand, so which set is taken must not flip from one sample to the next.
 */
function nearestEuler(angles: readonly number[], guess: readonly number[]): number[] {
  const wrap = (v: number, near: number) => v + 360 * Math.round((near - v) / 360),
    first = angles.map((v, k) => wrap(v, guess[k])),
    second = [angles[0] + 180, 180 - angles[1], angles[2] + 180].map((v, k) => wrap(v, guess[k])),
    distance = (set: number[]) => set.reduce((sum, v, k) => sum + Math.abs(v - guess[k]), 0);
  return distance(first) <= distance(second) ? first : second;
}

/** Blends one value through the layers. */
function mix(mode: number, lower: number, value: number, weight: number): number {
  if (mode === 0) return lower + weight * value;
  if (mode === 1) return weight * value;
  return lower + weight * (value - lower);
}

/** The same for a scale that multiplies: a weight is a power, which only a positive scale has. */
function mixScale(mode: number, lower: number, value: number, weight: number): number {
  const part = value > 0 ? value ** weight : 1 + weight * (value - 1);
  if (mode === 0) return lower * part;
  if (mode === 1) return part;
  return lower > 0 && value > 0 ? lower ** (1 - weight) * part : lower + weight * (value - lower);
}

function blendedCurve(times: Set<number>, jumpsAt: Set<number>, at: (time: number) => number, wrapped: boolean): Curve {
  return {
    times: [...times].sort((a, b) => a - b),
    values: [],
    interpolation: 'LINEAR',
    at,
    breaks: [...jumpsAt],
    wrapped,
  };
}

/** The layers' curves on a path of a model as one curve per axis. */
function blendPath(layers: Layer[], key: bigint, path: string, rest: readonly number[], read: LayerRead): Axes {
  const on = layers
    .map((layer) => ({ layer, axes: layer.tracks.models.get(key)?.get(path) }))
    .filter((entry) => entry.axes);
  // One whole layer needs no blending, and keeps a turn past 180 degrees that a quaternion would lose.
  if (on.length === 1 && on[0].layer.bottom && on[0].layer.full) return on[0].axes!;
  const times = new Set<number>(),
    breaks = new Set<number>();
  for (const { axes, layer } of on) {
    for (const curve of [...axes!, layer.weightCurve]) {
      if (!curve) continue;
      for (const t of curve.times) times.add(t);
      for (const t of curve.breaks ?? []) breaks.add(t);
    }
  }
  const scale = path === 'Lcl Scaling',
    rotation = path === 'Lcl Rotation';
  let stamp = NaN,
    cached = [0, 0, 0];
  const solve = (time: number): number[] => {
    if (time === stamp) return cached;
    let value = Array.from(rest);
    for (const { layer, axes } of on) {
      const weight = layer.weight(time),
        mode = layer.bottom ? 2 : layer.mode;
      if (rotation && !layer.byChannel && !(mode === 2 && weight === 1)) {
        // Always as XYZ: Maya stores the same blended angles on nodes of all six orders (a real file's six cubes), and
        // only then reads them in the node's own order.
        const angles = [0, 1, 2].map((k) => (axes![k] ? read.sample(axes![k]!, time) : mode === 2 ? value[k] : 0)),
          own = quaternion(angles),
          lower = quaternion(value),
          part = interpolateQuaternions(mode === 2 ? lower : IDENTITY, own, weight, CLOSE);
        value = nearestEuler(
          eulerDegrees(mode === 0 ? multiplyQuaternions(lower, part) : part, 0),
          value.map((v, k) => mix(mode, v, angles[k], weight)),
        );
        continue;
      }
      value = value.map((lower, k) => {
        if (!axes![k]) return lower;
        const v = read.sample(axes![k]!, time);
        return scale && layer.multiply ? mixScale(mode, lower, v, weight) : mix(mode, lower, v, weight);
      });
    }
    stamp = time;
    cached = value;
    return value;
  };
  const wrapped = rotation && on.some(({ layer }) => !layer.byChannel);
  return rest.map((_, k) => blendedCurve(times, breaks, (t) => solve(t)[k], wrapped));
}

/**
 * Reads cubic and constant curves of every tangent kind and blends animation layers, so clips from MotionBuilder and
 * Maya import as authored. Pass it in `extensions`: `loadFBX(engine, url, {extensions: [animationLayers]})`.
 */
export const animationLayers: FBXExtension = {
  name: 'layers',
  curve(node: FBXNode, times: number[], values: ArrayLike<number>): Curve {
    const keys = keysOf(node, times, values);
    return { times, values, interpolation: 'LINEAR', at: evaluator(times, values, keys), breaks: jumps(times, keys) };
  },
  blend(ctx: SceneContext, stack: readonly FBXNode[], read: LayerRead): StackTracks {
    const solo = stack.some((layer) => Number(property(layer, 'Solo', 0)) !== 0),
      layers: Layer[] = [];
    stack.forEach((node, index) => {
      if (Number(property(node, 'Mute', 0)) !== 0) return;
      if (solo && Number(property(node, 'Solo', 0)) === 0) return;
      const mode = Number(property(node, 'BlendMode', 0));
      if (mode !== 0 && mode !== 1 && mode !== 2)
        throw new TypeError(
          `Unsupported FBX animation layer mode ${mode}; bake or remove it in your 3D tool before export`,
        );
      const weight = layerWeight(ctx, node, read);
      layers.push({
        mode,
        bottom: index === 0,
        byChannel: Number(property(node, 'RotationAccumulationMode', 0)) === 1,
        multiply: Number(property(node, 'ScaleAccumulationMode', 0)) === 0,
        weight: weight.at,
        weightCurve: weight.curve,
        full: !weight.curve && weight.at(0) === 1,
        tracks: read.layer(node),
      });
    });
    const models = new Map<bigint, Map<string, Axes>>(),
      weights = new Map<bigint, Curve>(),
      channels = new Set<bigint>();
    for (const layer of layers) {
      for (const [key, paths] of layer.tracks.models) {
        const record = models.get(key) ?? new Map<string, Axes>();
        // A path that only holds constants has nothing to animate.
        for (const [path, axes] of paths) if (axes.some((c) => c?.times.length)) record.set(path, []);
        if (record.size) models.set(key, record);
      }
      for (const key of layer.tracks.weights.keys()) channels.add(key);
    }
    for (const [key, record] of models) {
      const model = ctx.models.get(key)!;
      for (const path of record.keys()) {
        const rest = property(model, path, path === 'Lcl Scaling' ? [1, 1, 1] : [0, 0, 0]) as ArrayLike<number>;
        record.set(path, blendPath(layers, key, path, Array.from(rest), read));
      }
    }
    for (const key of channels) {
      const rest = Number(property(ctx.document.objects.get(key)!, 'DeformPercent', 0)),
        own = layers.map((layer) => {
          const curve = layer.tracks.weights.get(key);
          return {
            ...layer,
            tracks: { models: new Map([[key, new Map([['DeformPercent', [curve]]])]]), weights: new Map() },
          };
        });
      weights.set(key, blendPath(own, key, 'DeformPercent', [rest], read)[0]!);
    }
    return { models, weights };
  },
} as ExtensionHooks;
