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
import {
  Node,
  Program,
  STMT,
  builtin,
  cast,
  sameEntries,
  scalarOf,
  sizeOf,
  unique,
  type NodeInput,
  type Resource,
  type ShaderStage,
} from './node.js';
import { effects } from './effects.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number; COPY_SRC: number; VERTEX: number };
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
  /** `atomic: true` (u32 or i32 only) declares `array<atomic<T>>` in compute passes so `atomicAdd`/`atomicMax`/`atomicMin` work. */
  constructor(
    readonly data: Float32Array | Int32Array | Uint32Array,
    readonly type: T,
    readonly atomic = false,
  ) {
    const kind = { f32: Float32Array, i32: Int32Array, u32: Uint32Array }[scalarOf(type) as 'f32'];
    if (!kind || sizeOf(type) === 3 || !(data instanceof kind))
      throw new TypeError(`Storage ${type} needs a ${kind?.name ?? 'f32, i32 or u32 typed array'}`);
    if (atomic && type !== 'u32' && type !== 'i32') throw new TypeError('Atomic storage is u32 or i32');
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
      device.lost?.then(() => this.buffers.delete(device));
      b = {
        buffer: device.createBuffer({
          label: 'shader:storage',
          size: Math.max(16, this.data.byteLength),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.VERTEX,
        }),
        version: -1,
      };
      this.buffers.set(device, b);
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
    });
  }
  /** A write made at the end of the ComputePass body (`atomicStore` on an atomic buffer). */
  store(i: Index, value: NodeInput<T>): Store {
    // StorageBuffer<T> is invariant in T (element reads and value writes), so widening to Store's buffer needs the cast.
    return { buffer: this as unknown as StorageBuffer, index: index(i), value: cast(value, this.type, 'stored value') };
  }
  /** Atomically adds `value` to element `i` and returns the previous value (compaction: `out.store(counter.atomicAdd(0, 1), i)`).
   * Runs where it is made, in order with other atomics, even when its result is unused; inside `loop` or `Fn` only when the result is used. */
  atomicAdd(this: StorageBuffer<Atomic>, i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicAdd', i, value) as never;
  }
  atomicMax(this: StorageBuffer<Atomic>, i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicMax', i, value) as never;
  }
  atomicMin(this: StorageBuffer<Atomic>, i: Index, value: NodeInput<T>): Node<T> {
    return this.rmw('atomicMin', i, value) as never;
  }
  /** Reads element `i` at this point of the body, after the atomics made before it (unlike `element`, which reads up front). */
  atomicLoad(this: StorageBuffer<Atomic>, i: Index): Node<T> {
    return this.rmw('atomicLoad', i) as never;
  }
  /** `store` on an atomic buffer. */
  atomicStore(this: StorageBuffer<Atomic>, i: Index, value: NodeInput<T>): Store {
    return this.store(i, value as never);
  }
  private rmw(op: string, i: Index, value?: NodeInput): Node<T> {
    if (!this.atomic) throw new TypeError(`${op} needs storage(data, '${this.type}', {atomic: true})`);
    const n = new Node(
      this.type,
      'a' + unique(),
      [index(i), ...(value === undefined ? [] : [cast(value, this.type, op + ' value')])],
      (b, x) => {
        if (b.stage.kind !== 'compute') throw new TypeError(`${op} is only available in ComputePass nodes`);
        const [at, v] = x.args.map((a) => b.expr(a)),
          name = b.name();
        b.line(`let ${name} = ${op}(&${b.resource(this)}[${at}]${v ? ', ' + v : ''});`);
        return name;
      },
      STMT,
    );
    effects.list?.push(n);
    return n;
  }
  /** Destroys the GPU copies; a later use uploads `data` again. */
  dispose(): void {
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
/** The invocation number in a ComputePass, 0..count-1. */
export const instanceIndex = /*@__PURE__*/ builtin('instanceIndex', 'u32');
const stage: ShaderStage = { kind: 'compute', builtins: { instanceIndex: 'gid.x' } };
let passes = 0;
/**
 * Options for `new ComputePass(count, body, options)`. `count` (invocations, >= 1) divided by `workgroupSize`, rounded
 * up, must stay <= 65,535 workgroups.
 */
export interface ComputeOptions {
  /** Invocations per workgroup, integer 1..256. Default 64. */
  workgroupSize?: number;
  /** Frame-graph order; the default -100 runs before the scene draws. */
  order?: number;
  /** Plugin and debug name. Default `'shader:compute:<n>'` (n counts passes). */
  name?: string;
}
/** Runs `body` for `count` invocations every frame: atomic operations first, in the order they were made, then the writes it returns (their reads happen before any write). */
export class ComputePass implements EnginePlugin {
  readonly name: string;
  readonly program = new Program(0, true);
  readonly code: string;
  private readonly order: number;
  private readonly size: number;
  private engine?: Engine;
  private pipeline?: GPUComputePipeline;
  private group?: GPUBindGroup;
  private last: GPUBindGroupEntry[] = [];
  constructor(
    readonly count: number,
    body: (index: Node<'u32'>) => ComputeBody,
    { workgroupSize = 64, order = -100, name = 'shader:compute:' + passes++ }: ComputeOptions = {},
  ) {
    if (
      !Number.isInteger(workgroupSize) ||
      workgroupSize < 1 ||
      workgroupSize > 256 ||
      !Number.isInteger(count) ||
      count < 1 ||
      Math.ceil(count / workgroupSize) > 65535 ||
      !Number.isFinite(order)
    )
      throw new RangeError('Invalid compute count, workgroup size or order');
    const outer = effects.list,
      made: Node[] = (effects.list = []);
    let result: ComputeBody;
    try {
      result = body(instanceIndex);
    } finally {
      effects.list = outer;
    }
    const out = [result ?? []].flat(),
      stores = out.filter((s) => !(s instanceof Node)) as Store[];
    if ((!out.length && !made.length) || stores.some((s) => !(s?.buffer instanceof StorageBuffer)))
      throw new TypeError('A ComputePass body returns storage.store(...) writes or makes atomic operations');
    const first = [...made, ...out.filter((n) => n instanceof Node)],
      p = this.program;
    const s = this.program.stage(stage, [...first, ...stores.flatMap((w) => [w.index, w.value])]),
      k0 = first.length;
    const writes = stores
      .map((w, k) => {
        const at = `${p.resource(w.buffer)}[${s.values[k0 + k * 2]}]`,
          v = s.values[k0 + k * 2 + 1];
        return `  ${w.buffer.atomic ? `atomicStore(&${at}, ${v})` : `${at} = ${v}`};\n`;
      })
      .join('');
    this.name = name;
    this.order = order;
    this.size = workgroupSize;
    this.code = `${p.declare(0)}\n@compute @workgroup_size(${workgroupSize}) fn main(@builtin(global_invocation_id) gid:vec3u) {\n  if (gid.x >= ${count}u) { return; }\n${s.lines.map((l) => '  ' + l + '\n').join('')}${writes}}\n`;
  }
  static attach(
    engine: EngineKernel,
    count: number,
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
    this.pipeline ??= compute(c.device, this.code, 'main');
    const entries = this.program.entries(c.device, { width: c.width, height: c.height, delta: c.delta });
    if (!this.group || !sameEntries(entries, this.last)) {
      this.last = entries;
      this.group = c.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries });
    }
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(Math.ceil(this.count / this.size));
    pass.end();
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
