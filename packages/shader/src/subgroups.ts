// WebGPU subgroup operations and half floats as nodes. Both are optional device features, so each comes from a function of the
// engine that writes the fast WGSL when the device has the feature and portable WGSL when it does not, from one graph.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { wholeGroups } from './compute.js';
import {
  builtin,
  cast,
  constant,
  FIXED,
  Node,
  ONCE,
  STMT,
  sizeOf,
  unique,
  type Builder,
  type Matrix,
  type NodeInput,
  type Type,
} from './node.js';

/** Types a subgroup reduction takes: every scalar and vector but the booleans. */
export type SubgroupValue = Exclude<Type, Matrix | 'bool' | `vec${2 | 3 | 4}<bool>`>;
/** Types the bitwise reductions take. */
export type SubgroupBits = Extract<SubgroupValue, 'i32' | 'u32' | `vec${2 | 3 | 4}${'i' | 'u'}`>;
/** Full-precision float types {@link HalfFloats.half} takes. */
export type FullFloat = 'f32' | 'vec2f' | 'vec3f' | 'vec4f';
/** The half-float type of a {@link FullFloat}: `'f16'` for `'f32'`, `'vec3h'` for `'vec3f'`. */
export type HalfOf<T extends FullFloat> = T extends 'f32' ? 'f16' : T extends `vec${infer K extends 2 | 3 | 4}f` ? `vec${K}h` : never;
/** The full-precision type of a half-float type. */
export type FullOf<T extends HalfFloat> = T extends 'f16' ? 'f32' : T extends `vec${infer K extends 2 | 3 | 4}h` ? `vec${K}f` : never;
/** Half-float node types. */
export type HalfFloat = 'f16' | 'vec2h' | 'vec3h' | 'vec4h';

/**
 * Subgroup operations of one device, from {@link subgroups}. Lanes of a subgroup run together, and the operations read across
 * them with no workgroup memory and no barrier. Write for any `size`: a device with no `subgroups` feature gives subgroups of one
 * lane, where a reduction is the value itself, and code that is right for every size stays right.
 * An operation must run in uniform control flow, so a ComputePass using them runs whole workgroups, as with a barrier.
 */
export interface Subgroups {
  /** True when the device has the `subgroups` feature: the nodes below are the hardware's. */
  readonly supported: boolean;
  /** Lanes in this subgroup. */
  readonly size: Node<'u32'>;
  /** This lane's number, from 0. */
  readonly id: Node<'u32'>;
  /** The sum of `x` over the lanes. */
  add<T extends SubgroupValue>(x: Node<T>): Node<T>;
  /** The product of `x` over the lanes. */
  mul<T extends SubgroupValue>(x: Node<T>): Node<T>;
  /** The least `x` over the lanes. */
  min<T extends SubgroupValue>(x: Node<T>): Node<T>;
  /** The greatest `x` over the lanes. */
  max<T extends SubgroupValue>(x: Node<T>): Node<T>;
  /** Bitwise and of `x` over the lanes. */
  and<T extends SubgroupBits>(x: Node<T>): Node<T>;
  /** Bitwise or of `x` over the lanes. */
  or<T extends SubgroupBits>(x: Node<T>): Node<T>;
  /** Bitwise xor of `x` over the lanes. */
  xor<T extends SubgroupBits>(x: Node<T>): Node<T>;
  /** The sum of `x` over the lanes up to and including this one. */
  inclusiveAdd<T extends SubgroupValue>(x: Node<T>): Node<T>;
  /** The sum of `x` over the lanes before this one (0 on the first). */
  exclusiveAdd<T extends SubgroupValue>(x: Node<T>): Node<T>;
  /** The product of `x` over the lanes up to and including this one. */
  inclusiveMul<T extends SubgroupValue>(x: Node<T>): Node<T>;
  /** The product of `x` over the lanes before this one (1 on the first). */
  exclusiveMul<T extends SubgroupValue>(x: Node<T>): Node<T>;
  /** True when `x` holds on every lane. */
  all(x: Node<'bool'>): Node<'bool'>;
  /** True when `x` holds on any lane. */
  any(x: Node<'bool'>): Node<'bool'>;
  /** A bit per lane where `x` holds: lane 0 is bit 0 of `.x`, lane 32 bit 0 of `.y`. */
  ballot(x: Node<'bool'>): Node<'vec4u'>;
  /** True on one lane of the subgroup: the one to write its result. */
  elect(): Node<'bool'>;
  /** `x` of lane `lane`, a constant below `size`. */
  broadcast<T extends SubgroupValue>(x: Node<T>, lane: number): Node<T>;
  /** `x` of the first active lane. */
  broadcastFirst<T extends SubgroupValue>(x: Node<T>): Node<T>;
  /** `x` of lane `lane`, which may differ per lane. Keep it below `size`. */
  shuffle<T extends SubgroupValue>(x: Node<T>, lane: NodeInput<'u32'>): Node<T>;
  /** `x` of the lane `delta` below this one. Keep it within the subgroup. */
  shuffleUp<T extends SubgroupValue>(x: Node<T>, delta: NodeInput<'u32'>): Node<T>;
  /** `x` of the lane `delta` above this one. Keep it within the subgroup. */
  shuffleDown<T extends SubgroupValue>(x: Node<T>, delta: NodeInput<'u32'>): Node<T>;
  /** `x` of the lane whose number is this one's xor `mask`. Keep it within the subgroup. */
  shuffleXor<T extends SubgroupValue>(x: Node<T>, mask: NodeInput<'u32'>): Node<T>;
}

const compute = (b: Builder, what: string, enable: string): void => {
  if (b.stage.kind !== 'compute') throw new TypeError(`${what} is only available in ComputePass nodes; move it into a ComputePass`);
  b.declare(enable, `enable ${enable};`);
};
const has = (source: EngineKernel | GPUDevice, feature: GPUFeatureName): boolean =>
  !!('queue' in source ? source : engineRuntime(source).gpu)?.features.has(feature);

/** A call that runs once, where it was made: every lane must reach it together. */
function lanes<T extends Type>(name: string, type: T, args: readonly Node[]): Node<T> {
  return new Node(
    type,
    'sg' + unique(),
    args,
    (b, x) => {
      compute(b, name, 'subgroups');
      wholeGroups(b.program);
      const values = x.args.map((a) => b.expr(a)),
        v = b.name();
      b.line(`let ${v} = ${name}(${values.join(', ')});`);
      return v;
    },
    STMT | FIXED | ONCE,
  );
}
const input = (name: string, wgsl: string): Node<'u32'> => {
  const value = builtin(wgsl, 'u32');
  return new Node('u32', 'sg:' + wgsl, [value], (b, x) => {
    compute(b, name, 'subgroups');
    return b.expr(x.args[0]);
  });
};
const reduce =
  (name: string) =>
  <T extends Type>(x: Node<T>): Node<T> =>
    lanes(name, x.type, [x]);
const moved =
  (name: string) =>
  <T extends Type>(x: Node<T>, lane: NodeInput<'u32'>): Node<T> =>
    lanes(name, x.type, [x, cast(lane, 'u32')]);
const same = <T extends Type>(x: Node<T>): Node<T> => x;

/**
 * The subgroup operations of `engine`'s device. Ask for them with `features: ['subgroups']` when creating the engine: a device
 * without the feature gets the one-lane form, so the same graph runs everywhere.
 */
export function subgroups(engine: EngineKernel | GPUDevice): Subgroups {
  if (has(engine, 'subgroups'))
    return {
      supported: true,
      size: input('subgroups.size', 'subgroupSize'),
      id: input('subgroups.id', 'subgroupId'),
      add: reduce('subgroupAdd'),
      mul: reduce('subgroupMul'),
      min: reduce('subgroupMin'),
      max: reduce('subgroupMax'),
      and: reduce('subgroupAnd'),
      or: reduce('subgroupOr'),
      xor: reduce('subgroupXor'),
      inclusiveAdd: reduce('subgroupInclusiveAdd'),
      exclusiveAdd: reduce('subgroupExclusiveAdd'),
      inclusiveMul: reduce('subgroupInclusiveMul'),
      exclusiveMul: reduce('subgroupExclusiveMul'),
      all: reduce('subgroupAll'),
      any: reduce('subgroupAny'),
      ballot: (x) => lanes('subgroupBallot', 'vec4u', [x]),
      elect: () => lanes('subgroupElect', 'bool', []),
      broadcast: (x, lane) => lanes('subgroupBroadcast', x.type, [x, constant(lane, 'u32')]),
      broadcastFirst: reduce('subgroupBroadcastFirst'),
      shuffle: moved('subgroupShuffle'),
      shuffleUp: moved('subgroupShuffleUp'),
      shuffleDown: moved('subgroupShuffleDown'),
      shuffleXor: moved('subgroupShuffleXor'),
    };
  return {
    supported: false,
    size: constant(1, 'u32'),
    id: constant(0, 'u32'),
    add: same,
    mul: same,
    min: same,
    max: same,
    and: same,
    or: same,
    xor: same,
    inclusiveAdd: same,
    exclusiveAdd: (x) => constant(0, x.type),
    inclusiveMul: same,
    exclusiveMul: (x) => constant(1, x.type),
    all: same,
    any: same,
    ballot: (x) => new Node('vec4u', 'ballot', [x], (b, n) => `vec4u(select(0u, 1u, ${b.expr(n.args[0])}), 0u, 0u, 0u)`),
    elect: () => constant(true, 'bool'),
    broadcast: same,
    broadcastFirst: same,
    shuffle: same,
    shuffleUp: same,
    shuffleDown: same,
    shuffleXor: same,
  };
}

/**
 * Half floats of one device, from {@link halfFloats}. Maths on half floats takes half the registers and, on many GPUs, half the
 * time. Without the `shader-f16` feature the same graph runs in f32: values keep more precision and go past 65,504 without
 * becoming infinite, so results differ by what f16 rounds away.
 */
export interface HalfFloats {
  /** True when the device has the `shader-f16` feature: nodes from `half` are f16. */
  readonly supported: boolean;
  /** `x` as a half float. Numbers take part in maths on the result as usual; nodes of f32 do not, so convert them too. */
  half<T extends FullFloat>(x: Node<T>): Node<HalfOf<T>>;
  /** A half float back at full precision. */
  full<T extends HalfFloat>(x: Node<T>): Node<FullOf<T>>;
}

/**
 * The half floats of `engine`'s device. Ask for them with `features: ['shader-f16']` when creating the engine: a device without
 * the feature gets the f32 form.
 */
export function halfFloats(engine: EngineKernel | GPUDevice): HalfFloats {
  if (!has(engine, 'shader-f16'))
    return { supported: false, half: (x) => x as unknown as Node<never>, full: (x) => x as unknown as Node<never> };
  return {
    supported: true,
    half: (x) => {
      const type = (sizeOf(x.type) === 1 ? 'f16' : x.type.replace('f', 'h')) as Type;
      return new Node(type, 'half', [x], (b, n) => {
        compute(b, 'half', 'f16');
        return `${type}(${b.expr(n.args[0])})`;
      }) as unknown as Node<never>;
    },
    full: (x) => {
      const type = (sizeOf(x.type) === 1 ? 'f32' : x.type.replace('h', 'f')) as Type;
      return new Node(type, 'full', [x], (b, n) => `${type}(${b.expr(n.args[0])})`) as unknown as Node<never>;
    },
  };
}

/** Two floats as the two halves of a u32, rounded to f16: half the storage on every device. */
export const packHalf2 = (x: Node<'vec2f'>): Node<'u32'> =>
  new Node('u32', 'packHalf2', [x], (b, n) => `pack2x16float(${b.expr(n.args[0])})`);
/** The two floats of a {@link packHalf2}. */
export const unpackHalf2 = (x: Node<'u32'>): Node<'vec2f'> =>
  new Node('vec2f', 'unpackHalf2', [x], (b, n) => `unpack2x16float(${b.expr(n.args[0])})`);
