/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { compute } from '../../shared/gpu.js';
import { Let, push, statement, write } from './control.js';
import {
  FIXED,
  MUTABLE,
  Node,
  ONCE,
  Program,
  STMT,
  builtin,
  cast,
  sameEntries,
  scalarOf,
  sizeOf,
  unique,
  type Builder,
  type Host,
  type NodeInput,
  type Resource,
  type Type,
} from './node.js';
import { effects } from './scope.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number; COPY_SRC: number; VERTEX: number; INDIRECT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** Element types with a 4-byte-aligned array stride (vec3 would pad; use vec4). */
export type StorageType = 'f32' | 'i32' | 'u32' | 'vec2f' | 'vec2i' | 'vec2u' | 'vec4f' | 'vec4i' | 'vec4u';
type Atomic = 'u32' | 'i32';
/** What a ComputePass body returns: writes, atomic results to keep, or nothing when it only makes atomic operations. */
export type ComputeBody = Store | Node | readonly (Store | Node)[] | void;
type Index = NodeInput<'u32' | 'i32'>;
const index = (i: Index) =>
  i instanceof Node
    ? i.type === 'u32' || i.type === 'i32'
      ? i
      : cast(i, 'u32', 'storage index')
    : cast(i, 'u32', 'storage index');
// Keep only live storage listeners under one device promise. A promise callback directly closing over
// StorageBuffer would retain its CPU array after dispose(), until that GPU device eventually disappeared.
type LossListener = (info: GPUDeviceLostInfo) => void;
const deviceLoss = new WeakMap<GPUDevice, Set<LossListener>>();
function deviceLossListeners(device: GPUDevice): Set<LossListener> {
  let listeners = deviceLoss.get(device);
  if (!listeners) {
    listeners = new Set();
    deviceLoss.set(device, listeners);
    const shared = listeners;
    void device.lost.then((info) => {
      const callbacks = [...shared];
      shared.clear();
      deviceLoss.delete(device);
      for (const callback of callbacks) callback(info);
    });
  }
  return listeners;
}
/** @internal Calls `listener` once when `device` is lost; returns the unsubscribe. Keeps no closure alive after it. */
export function observeDeviceLoss(device: GPUDevice, listener: LossListener): () => void {
  if (!device.lost) return () => {};
  const listeners = deviceLossListeners(device);
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const atomicNode = <T extends Type>(
  owner: Resource,
  type: T,
  op: string,
  at: Node,
  values: readonly Node[],
): Node<T> => {
  const n = new Node(
    type,
    'a' + unique(),
    [at, ...values],
    (b, x) => {
      if (b.stage.kind !== 'compute') throw new TypeError(`${op} is only available in ComputePass nodes`);
      const [i, ...rest] = x.args.map((a) => b.expr(a)),
        name = b.name();
      b.line(`let ${name} = ${op}(&${b.resource(owner)}[${i}]${rest.map((v) => ', ' + v).join('')});`);
      return name;
    },
    STMT | FIXED | ONCE,
  );
  effects.list?.push(n);
  return n;
};
/** What `compareExchange` gives: the value before the attempt, and whether the swap happened. */
export interface Exchange<T extends Type> {
  readonly old: Node<T>;
  readonly exchanged: Node<'bool'>;
}
const exchange = <T extends Type>(n: Node<T>): Exchange<T> => ({
  old: new Node(n.type, '.old', [n], (b, x) => `${b.expr(x.args[0])}.old_value`),
  exchanged: new Node('bool', '.exchanged', [n], (b, x) => `${b.expr(x.args[0])}.exchanged`),
});
/** One write `buffer[index] = value`, made by `StorageBuffer.store` inside a ComputePass body. */
export interface Store {
  readonly buffer: StorageBuffer;
  readonly index: Node;
  readonly value: Node;
}
/** A GPU array that compute nodes write and any node reads (`element(i)`); `buffer(device)` hands it to other passes (it is also a vertex buffer). */
export class StorageBuffer<T extends StorageType = StorageType> implements Resource {
  readonly prefix = 'ndb';
  readonly bindings = 1;
  readonly count: number;
  private readonly id = unique();
  private version = 0;
  private readonly buffers = new Map<GPUDevice, { buffer: GPUBuffer; version: number }>();
  private readonly lossSubscriptions = new Map<GPUDevice, () => void>();
  /** `atomic: true` (u32 or i32 only) declares `array<atomic<T>>` in compute passes so `atomicAdd`/`atomicMax`/`atomicMin` work. */
  constructor(
    readonly data: Float32Array | Int32Array | Uint32Array,
    readonly type: T,
    readonly atomic = false,
  ) {
    const kind = { f32: Float32Array, i32: Int32Array, u32: Uint32Array }[scalarOf(type) as 'f32'];
    if (!kind || sizeOf(type) === 3 || !(data instanceof kind))
      throw new TypeError(`Storage ${type} needs a ${kind?.name ?? 'f32, i32 or u32 typed array'}`);
    if (atomic && type !== 'u32' && type !== 'i32')
      throw new TypeError('Atomic storage must be u32 or i32; pass one of those types or drop {atomic: true}.');
    this.count = data.length / sizeOf(type);
    if (!Number.isInteger(this.count) || this.count < 1)
      throw new RangeError('Storage data length must be a positive multiple of the element size');
  }
  /** @internal */ declare(name: string, group: number, binding: number, write: boolean): string {
    return `@group(${group}) @binding(${binding}) var<storage, ${write ? 'read_write' : 'read'}> ${name}:array<${write && this.atomic ? `atomic<${this.type}>` : this.type}>;`;
  }
  /** @internal */ entries(device: GPUDevice): GPUBindingResource[] {
    return [{ buffer: this.buffer(device) }];
  }
  /** The GPU copy for `device`, created from `data` on first use and after `update()`. */
  buffer(device: GPUDevice): GPUBuffer {
    let b = this.buffers.get(device);
    if (!b) {
      b = {
        buffer: device.createBuffer({
          label: 'shader:storage',
          size: Math.max(16, this.data.byteLength),
          usage:
            GPUBufferUsage.STORAGE |
            GPUBufferUsage.COPY_DST |
            GPUBufferUsage.COPY_SRC |
            GPUBufferUsage.VERTEX |
            GPUBufferUsage.INDIRECT,
        }),
        version: -1,
      };
      this.buffers.set(device, b);
      this.lossSubscriptions.set(
        device,
        observeDeviceLoss(device, () => {
          this.buffers.delete(device);
          this.lossSubscriptions.delete(device);
        }),
      );
    }
    if (b.version !== this.version) {
      device.queue.writeBuffer(b.buffer, 0, this.data as Float32Array<ArrayBuffer>);
      b.version = this.version;
    }
    return b.buffer;
  }
  /** Re-upload `data` on next use, replacing what the GPU computed. */
  update(): void {
    this.version++;
  }
  /** Element `i` (an `atomicLoad` on an atomic buffer inside a ComputePass; use `atomicLoad` to fix when it reads relative to other atomics). */
  element(i: Index): Node<T> {
    return new Node(this.type, 'e' + this.id, [index(i)], (b, n) => {
      const at = `${b.resource(this)}[${b.expr(n.args[0])}]`;
      return this.atomic && b.stage.kind === 'compute' ? `atomicLoad(&${at})` : at;
    }, MUTABLE);
  }
  /** A write made at the end of the ComputePass body (`atomicStore` on an atomic buffer); inside `If`, `Loop` and other statement bodies it happens right where it is called. */
  store(i: Index, value: NodeInput<T>): Store {
    // StorageBuffer<T> is invariant in T (element reads and value writes), so widening to Store's buffer needs the cast.
    const write = {
      buffer: this as unknown as StorageBuffer,
      index: index(i),
      value: cast(value, this.type, 'stored value'),
    };
    effects.store?.(write);
    return write;
  }
  /** Atomically adds `value` to element `i` and returns the previous value (compaction: `out.store(counter.atomicAdd(0, 1), i)`).
   * Runs where it is made, in order with other atomics, even when its result is unused; inside `loop` or `Fn` only when the result is used. */
  atomicAdd(this: StorageBuffer<Atomic>, i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicAdd', i, value) as never;
  }
  /** Atomic subtraction; returns the previous value. */
  atomicSub(this: StorageBuffer<Atomic>, i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicSub', i, value) as never;
  }
  /** Atomic maximum; returns the previous value. */
  atomicMax(this: StorageBuffer<Atomic>, i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicMax', i, value) as never;
  }
  /** Atomic minimum; returns the previous value. */
  atomicMin(this: StorageBuffer<Atomic>, i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicMin', i, value) as never;
  }
  /** Atomic bitwise and; returns the previous value. */
  atomicAnd(this: StorageBuffer<Atomic>, i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicAnd', i, value) as never;
  }
  /** Atomic bitwise or; returns the previous value. */
  atomicOr(this: StorageBuffer<Atomic>, i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicOr', i, value) as never;
  }
  /** Atomic bitwise xor; returns the previous value. */
  atomicXor(this: StorageBuffer<Atomic>, i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicXor', i, value) as never;
  }
  /** Atomically replaces element `i`; returns the previous value. */
  atomicExchange(this: StorageBuffer<Atomic>, i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicExchange', i, value) as never;
  }
  /**
   * Sets element `i` to `value` if it equals `compare`. It may fail even when they are equal (WGSL's weak form), so
   * retry in a `Loop` or `While` on `exchanged`.
   */
  atomicCompareExchange(this: StorageBuffer<Atomic>, i: Index, compare: NodeInput<T>, value: NodeInput<T>): Exchange<T> {
    return exchange(this.rmw('atomicCompareExchangeWeak', i, compare, value)) as never;
  }
  /** Reads element `i` at this point of the body, after the atomics made before it (unlike `element`, which reads up front). */
  atomicLoad(this: StorageBuffer<Atomic>, i: Index): Node<T> {
    return this.rmw('atomicLoad', i) as never;
  }
  /** `store` on an atomic buffer. */
  atomicStore(this: StorageBuffer<Atomic>, i: Index, value: NodeInput<T>): Store {
    return this.store(i, value as never);
  }
  private rmw(op: string, i: Index, ...values: NodeInput[]): Node<T> {
    if (!this.atomic) throw new TypeError(`${op} needs storage(data, '${this.type}', {atomic: true})`);
    return atomicNode(
      this,
      this.type,
      op,
      index(i),
      values.map((v) => cast(v, this.type, op + ' value')),
    );
  }
  /** Destroys the GPU copies; a later use uploads `data` again. */
  dispose(): void {
    for (const remove of this.lossSubscriptions.values()) remove();
    this.lossSubscriptions.clear();
    for (const b of this.buffers.values()) b.buffer.destroy();
    this.buffers.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
/** `storage(new Float32Array(4 * n), 'vec4f')` or `storage(n, 'vec4f')` for zeros; `storage(1, 'u32', {atomic: true})` for a counter. */
export function storage<T extends StorageType>(
  data: number | Float32Array | Int32Array | Uint32Array,
  type: T,
  { atomic = false }: { atomic?: boolean } = {},
): StorageBuffer<T> {
  const s = scalarOf(type),
    n = sizeOf(type);
  return new StorageBuffer(
    typeof data === 'number'
      ? new ({ f32: Float32Array, i32: Int32Array, u32: Uint32Array } as const)[s as 'f32'](data * n)
      : data,
    type,
    atomic,
  );
}
/** The invocation number in a ComputePass, 0..count-1 (row by row in a 2D or 3D pass). */
export const instanceIndex = /*@__PURE__*/ builtin('instanceIndex', 'u32');
/** The invocation's position in the whole dispatch, `global_invocation_id`: `globalId.xy` is the texel of a 2D pass. */
export const globalId = /*@__PURE__*/ builtin('globalId', 'vec3u');
/** The invocation's position in its workgroup, and the same as one number 0..size-1. */
export const localId = /*@__PURE__*/ builtin('localId', 'vec3u'),
  localIndex = /*@__PURE__*/ builtin('localIndex', 'u32');
/** Which workgroup this is, and how many the dispatch has. */
export const workgroupId = /*@__PURE__*/ builtin('workgroupId', 'vec3u'),
  workgroupCount = /*@__PURE__*/ builtin('workgroupCount', 'vec3u');
const inputs: Record<string, [string, string, string]> = {
  localId: ['lid', 'local_invocation_id', 'vec3u'],
  localIndex: ['lix', 'local_invocation_index', 'u32'],
  workgroupId: ['wid', 'workgroup_id', 'vec3u'],
  workgroupCount: ['nwg', 'num_workgroups', 'vec3u'],
};
// Passes that hold a barrier: every invocation of a workgroup has to reach it, so they have no early return.
const barriers = new WeakSet<Program>();
const barrier = (name: string) =>
  push(
    statement([], (b) => {
      if (b.stage.kind !== 'compute') throw new TypeError(`${name} is only available in ComputePass nodes; move it into a ComputePass body`);
      barriers.add(b.program);
      b.line(`${name}();`);
      b.epoch++;
    }),
    name,
  );
/**
 * Waits until every invocation of the workgroup arrives and sees each other's `workgroup` writes. Every invocation
 * must reach it, so not under a branch or loop that differs between them (WGSL refuses that when the pipeline compiles).
 */
export function workgroupBarrier(): void {
  effects.flush?.();
  barrier('workgroupBarrier');
}
/** {@link workgroupBarrier} for storage buffers: writes before it are seen by the workgroup after it. */
export function storageBarrier(): void {
  effects.flush?.();
  barrier('storageBarrier');
}
/** {@link workgroupBarrier} for read-write storage textures. */
export function textureBarrier(): void {
  effects.flush?.();
  barrier('textureBarrier');
}
/** Element types of workgroup memory. */
export type WorkgroupType = StorageType | 'vec3f' | 'vec3i' | 'vec3u';
/** Memory shared by one workgroup, gone when it ends. Made with {@link workgroup}. */
export class WorkgroupArray<T extends WorkgroupType = WorkgroupType> implements Resource {
  readonly prefix = 'ndg';
  readonly bindings = 0;
  private readonly id = unique();
  constructor(
    readonly count: number,
    readonly type: T,
    readonly atomic = false,
  ) {
    if (!Number.isInteger(count) || count < 1) throw new RangeError('Workgroup memory needs a whole count of at least 1');
    if (atomic && type !== 'u32' && type !== 'i32')
      throw new TypeError('Atomic workgroup memory must be u32 or i32; pass one of those types or drop {atomic: true}.');
  }
  /** @internal */ declare(name: string): string {
    return `var<workgroup> ${name}:array<${this.atomic ? `atomic<${this.type}>` : this.type}, ${this.count}>;`;
  }
  /** @internal */ entries(): GPUBindingResource[] {
    return [];
  }
  /** Element `i` where it is used (an `atomicLoad` on atomic memory). */
  element(i: Index): Node<T> {
    return new Node(
      this.type,
      'g' + this.id,
      [index(i)],
      (b, n) => {
        if (b.stage.kind !== 'compute') throw new TypeError('Workgroup memory is only available in ComputePass nodes; move it into a ComputePass body');
        const at = `${b.resource(this)}[${b.expr(n.args[0])}]`;
        return this.atomic ? `atomicLoad(&${at})` : at;
      },
      MUTABLE,
    );
  }
  /** Writes element `i` here in the body, in order with barriers and other statements. */
  store(i: Index, value: NodeInput<T>): void {
    write({ buffer: this, index: index(i), value: cast(value, this.type, 'stored value') });
  }
  /**
   * Element `i`, the same for the whole workgroup, so a branch or loop on it may hold a barrier (`workgroupUniformLoad`,
   * which is itself a barrier). Not on atomic memory.
   */
  uniformLoad(i: Index): Node<T> {
    if (this.atomic) throw new TypeError('uniformLoad reads plain workgroup memory; use element() on atomic memory');
    return Let(
      new Node(this.type, 'g' + unique(), [index(i)], (b, n) => {
        barriers.add(b.program);
        return `workgroupUniformLoad(&${b.resource(this)}[${b.expr(n.args[0])}])`;
      }),
    );
  }
  private rmw(op: string, i: Index, ...values: NodeInput[]): Node<T> {
    if (!this.atomic) throw new TypeError(`${op} needs workgroup(n, '${this.type}', {atomic: true})`);
    return atomicNode(
      this,
      this.type,
      op,
      index(i),
      values.map((v) => cast(v, this.type, op + ' value')),
    );
  }
  /** Atomic addition; returns the previous value. The others match StorageBuffer's. */
  atomicAdd(i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicAdd', i, value);
  }
  atomicSub(i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicSub', i, value);
  }
  atomicMax(i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicMax', i, value);
  }
  atomicMin(i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicMin', i, value);
  }
  atomicAnd(i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicAnd', i, value);
  }
  atomicOr(i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicOr', i, value);
  }
  atomicXor(i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicXor', i, value);
  }
  atomicExchange(i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicExchange', i, value);
  }
  atomicCompareExchange(i: Index, compare: NodeInput<T>, value: NodeInput<T>): Exchange<T> {
    return exchange(this.rmw('atomicCompareExchangeWeak', i, compare, value));
  }
  /** `atomicLoad` at this point of the body. */
  atomicLoad(i: Index): Node<T> {
    return this.rmw('atomicLoad', i);
  }
  /** `atomicStore` here in the body. */
  atomicStore(i: Index, value: NodeInput<T>): void {
    this.store(i, value);
  }
}
/**
 * Declares memory shared by the invocations of one workgroup: `workgroup(64, 'f32')`, or `{atomic: true}` for u32 and i32.
 * All workgroup memory of a pass must fit the device's 16,384 bytes.
 */
export const workgroup = <T extends WorkgroupType>(
  count: number,
  type: T,
  { atomic = false }: { atomic?: boolean } = {},
): WorkgroupArray<T> => new WorkgroupArray(count, type, atomic);
let passes = 0;
type Size3 = readonly [number, number, number];
/** Invocations of a pass: a count, or `[x, y]` and `[x, y, z]` for a grid. */
export type ComputeCount = number | readonly [number, number] | readonly [number, number, number];
const grid = (size: ComputeCount | number): Size3 => {
  const [x, y = 1, z = 1] = typeof size === 'number' ? [size] : size;
  return [x, y, z];
};
const counted = (count: ComputeCount) => (typeof count === 'number' ? 1 : count.length);
/**
 * Options for `new ComputePass(count, body, options)`. `count` (invocations, >= 1) divided by `workgroupSize`, rounded
 * up, must stay <= 65,535 workgroups.
 */
export interface ComputeOptions {
  /** Invocations per workgroup, up to 256 in all and 64 along z. Default 64, `[8, 8]` for a 2D pass, `[4, 4, 4]` for a 3D one. */
  workgroupSize?: ComputeCount;
  /** Frame-graph order; the default -100 runs before the scene draws. */
  order?: number;
  /** Plugin and debug name. Default `'shader:compute:<n>'` (n counts passes). */
  name?: string;
  /**
   * Takes the workgroup counts from three u32 elements of this buffer when it dispatches, so an earlier pass can decide
   * how much work there is. `count` stays the limit: invocations past it return at once.
   */
  indirect?: StorageBuffer<'u32'>;
  /** Element of `indirect` where the three counts start. Default 0. */
  indirectOffset?: number;
}
/** Runs `body` for `count` invocations every frame: atomic operations and statements first, in the order they were made, then its writes, returned ones first (their reads happen before any write). */
export class ComputePass implements EnginePlugin {
  readonly name: string;
  readonly program = new Program(0, true);
  readonly code: string;
  private readonly order: number;
  private readonly groups: Size3;
  private readonly indirect?: StorageBuffer<'u32'>;
  private readonly indirectOffset: number;
  private engine?: Engine;
  private pipeline?: GPUComputePipeline;
  private group?: GPUBindGroup;
  private last: GPUBindGroupEntry[] = [];
  constructor(
    readonly count: ComputeCount,
    body: (index: Node<'u32'>) => ComputeBody,
    {
      workgroupSize = [64, [8, 8], [4, 4, 4]][counted(count) - 1] as ComputeCount,
      order = -100,
      name = 'shader:compute:' + passes++,
      indirect,
      indirectOffset = 0,
    }: ComputeOptions = {},
  ) {
    const size = grid(count),
      local = grid(workgroupSize),
      groups = size.map((n, k) => Math.ceil(n / local[k])) as unknown as Size3;
    if (
      size.some((n) => !Number.isInteger(n) || n < 1) ||
      local.some((n) => !Number.isInteger(n) || n < 1) ||
      local[0] * local[1] * local[2] > 256 ||
      local[2] > 64 ||
      (!indirect && groups.some((n) => n > 65535)) ||
      !Number.isFinite(order)
    )
      throw new RangeError(
        'ComputePass needs a whole count of at least 1 on each axis, a workgroup size of at most 256 invocations and 64 along z that dispatches at most 65535 groups per axis, and a finite order; adjust count or workgroupSize.',
      );
    if (indirect && (indirect.type !== 'u32' || !(indirectOffset >= 0) || indirectOffset + 3 > indirect.count))
      throw new RangeError('indirect needs a u32 storage buffer with three elements at indirectOffset');
    const { list, store, flush } = effects,
      made: Node[] = (effects.list = []),
      kept: Store[] = [],
      flushed = new Set<Store>();
    effects.store = (w) => kept.push(w as Store);
    // A barrier orders what came before it, so writes made so far happen before it rather than at the end of the body.
    effects.flush = () => {
      for (const w of kept.splice(0)) {
        flushed.add(w);
        write(w);
      }
    };
    let result: ComputeBody;
    try {
      result = body(instanceIndex);
    } finally {
      effects.list = list;
      effects.store = store;
      effects.flush = flush;
    }
    const out = [result ?? []].flat(),
      returned = out.filter((s) => !(s instanceof Node)) as Store[];
    if (
      (!out.length && !made.length && !kept.length) ||
      returned.some((s) => !(s?.buffer instanceof StorageBuffer))
    )
      throw new TypeError(
        'A ComputePass body must make storage.store(...) writes, statements or atomic operations; add one to the body.',
      );
    // A write the body made and did not return still happens: losing it silently would be worse than any order.
    const stores = [...new Set([...returned, ...kept])].filter((w) => !flushed.has(w));
    const first = [...made, ...out.filter((n) => n instanceof Node)],
      p = this.program;
    const axes = counted(count),
      params = new Set<string>(),
      linear = axes === 1 ? 'gid.x' : axes === 2 ? `(gid.y * ${size[0]}u + gid.x)` : `((gid.z * ${size[1]}u + gid.y) * ${size[0]}u + gid.x)`,
      builtins: Record<string, string | ((b: Builder) => string)> = { instanceIndex: linear, globalId: 'gid' };
    for (const key in inputs)
      builtins[key] = (b) => {
        params.add(key);
        return b.local(inputs[key][0]);
      };
    const s = this.program.stage({ kind: 'compute', builtins }, [...first, ...stores.flatMap((w) => [w.index, w.value])]),
      k0 = first.length;
    // Every write's reads come first: with two writes, an inline read in the second would see the first.
    const early: string[] = [],
      kept2 = (code: string) => {
        if (stores.length < 2 || !/\bnd[bg]\d|textureLoad/.test(code)) return code;
        const name = p.name();
        early.push(`  let ${name} = ${code};\n`);
        return name;
      };
    const writes = stores
      .map((w, k) => {
        const at = `${p.resource(w.buffer)}[${kept2(s.values[k0 + k * 2])}]`,
          v = kept2(s.values[k0 + k * 2 + 1]);
        return `  ${w.buffer.atomic ? `atomicStore(&${at}, ${v})` : `${at} = ${v}`};\n`;
      })
      .join('');
    const whole = barriers.has(p);
    if (whole && !indirect && size.some((n, k) => n % local[k]))
      throw new RangeError(
        'A ComputePass with a barrier runs whole workgroups, so its count must be a multiple of workgroupSize; adjust either one.',
      );
    const limit =
        axes === 1
          ? `gid.x >= ${size[0]}u`
          : axes === 2
            ? `any(gid.xy >= vec2u(${size[0]}u, ${size[1]}u))`
            : `any(gid >= vec3u(${size[0]}u, ${size[1]}u, ${size[2]}u))`,
      guard = whole ? '' : `  if (${limit}) { return; }\n`,
      extra = [...params].map((k) => `, @builtin(${inputs[k][1]}) ${inputs[k][0]}:${inputs[k][2]}`).join(''),
      shape = typeof workgroupSize === 'number' ? workgroupSize : workgroupSize.join(', ');
    this.name = name;
    this.order = order;
    this.groups = groups;
    this.indirect = indirect;
    this.indirectOffset = indirectOffset;
    this.code = `${p.declare(0)}\n@compute @workgroup_size(${shape}) fn main(@builtin(global_invocation_id) gid:vec3u${extra}) {\n${guard}${s.lines.map((l) => '  ' + l + '\n').join('')}${early.join('')}${writes}}\n`;
  }
  static attach(
    engine: EngineKernel,
    count: ComputeCount,
    body: (index: Node<'u32'>) => ComputeBody,
    options?: ComputeOptions,
  ): ComputePass {
    const pass = new ComputePass(count, body, options);
    engineRuntime(engine).use(pass);
    return pass;
  }
  setup(engine: Engine): void {
    if (!engine.gpu)
      throw new MargoError('unsupported', 'ComputePass requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu') this.dispatch(c);
      },
    });
  }
  private dispatch(c: Context): void {
    this.encode(c.device, c.encoder, { width: c.width, height: c.height, delta: c.delta });
  }
  /** @internal Records one dispatch of every invocation into `encoder`, uploading uniforms and storage first. */
  encode(device: GPUDevice, encoder: GPUCommandEncoder, host: Host): void {
    this.pipeline ??= compute(device, this.code, 'main');
    const entries = this.program.entries(device, host);
    if (!this.group || !sameEntries(entries, this.last)) {
      this.last = entries;
      this.group = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries });
    }
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    if (this.indirect) pass.dispatchWorkgroupsIndirect(this.indirect.buffer(device), this.indirectOffset * 4);
    else pass.dispatchWorkgroups(...this.groups);
    pass.end();
    for (const r of this.program.resources) r.resource.finish?.();
  }
  onDeviceRestored(): void {
    this.pipeline = this.group = undefined;
  }
  dispose(): void {
    const engine = this.engine;
    this.engine = undefined;
    this.onDeviceRestored();
    engine?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
