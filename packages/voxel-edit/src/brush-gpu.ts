/// <reference lib="esnext.disposable" preserve="true" />
// GPU side of the shader brushes (internal, not an entry): the WGSL prelude and entry point a brush compiles with, and
// a grid held in GPU buffers that brushes run on pass after pass. Used by ./shaders and ./gpu.
import { MargoError } from '@margoengine/math/errors';
import type { Vec3 } from '@margoengine/math';
import type { VoxelGrid } from './grid.js';

declare const GPUBufferUsage: {
  STORAGE: number;
  COPY_SRC: number;
  COPY_DST: number;
  UNIFORM: number;
  MAP_READ: number;
};
declare const GPUShaderStage: { COMPUTE: number };
declare const GPUMapMode: { READ: number };

// The prelude every brush is compiled with: the grid, its cells and the helpers the user code may call.
export const PRELUDE = /* wgsl */ `struct Info {
  size: vec4<i32>,
  count: u32,
  every: u32,
  pass_index: u32,
  seed: u32,
  tool_size: vec4<i32>,
  tool_offset: vec4<i32>,
  params: array<vec4<f32>, 4>,
}
@group(0) @binding(0) var<uniform> info: Info;
@group(0) @binding(1) var<storage, read> source_cells: array<u32>;
@group(0) @binding(2) var<storage, read_write> result_cells: array<u32>;
@group(0) @binding(3) var<storage, read> selected_cells: array<u32>;
@group(0) @binding(4) var<storage, read> tool_cells: array<u32>;
@group(0) @binding(5) var<storage, read> lookup_table: array<u32, 256>;
fn grid_size() -> vec3<i32> { return info.size.xyz; }
fn inside(q: vec3<i32>) -> bool { return all(q >= vec3<i32>(0)) && all(q < info.size.xyz); }
fn cell_index(q: vec3<i32>) -> i32 { return q.x + info.size.x * (q.z + info.size.z * q.y); }
fn cell(q: vec3<i32>) -> u32 {
  if (!inside(q)) { return 0u; }
  let i = u32(cell_index(q));
  return (source_cells[i >> 2u] >> ((i & 3u) * 8u)) & 255u;
}
fn tool(q: vec3<i32>) -> u32 {
  let t = q - info.tool_offset.xyz;
  if (info.tool_size.w == 0 || any(t < vec3<i32>(0)) || any(t >= info.tool_size.xyz)) { return 0u; }
  let i = u32(t.x + info.tool_size.x * (t.z + info.tool_size.z * t.y));
  return (tool_cells[i >> 2u] >> ((i & 3u) * 8u)) & 255u;
}
fn lookup(i: u32) -> u32 { return lookup_table[min(i, 255u)]; }
fn face_offset(d: i32) -> vec3<i32> {
  switch d {
    case 0: { return vec3<i32>(-1, 0, 0); }
    case 1: { return vec3<i32>(1, 0, 0); }
    case 2: { return vec3<i32>(0, -1, 0); }
    case 3: { return vec3<i32>(0, 1, 0); }
    case 4: { return vec3<i32>(0, 0, -1); }
    default: { return vec3<i32>(0, 0, 1); }
  }
}
fn param(i: u32) -> f32 { return info.params[min(i, 15u) >> 2u][i & 3u]; }
fn pass_number() -> u32 { return info.pass_index; }
fn hash_u32(x: u32) -> u32 {
  var h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}
fn hash(q: vec3<i32>, salt: u32) -> f32 {
  let h = hash_u32(bitcast<u32>(q.x) ^ hash_u32(bitcast<u32>(q.y) ^ hash_u32(bitcast<u32>(q.z) ^ hash_u32(salt ^ info.seed))));
  return f32(h >> 8u) / 16777216.0;
}
fn noise(x: vec3<f32>) -> f32 {
  let c = floor(x);
  let f = x - c;
  let u = f * f * (3.0 - 2.0 * f);
  let i = vec3<i32>(c);
  let a = mix(hash(i, 0u), hash(i + vec3<i32>(1, 0, 0), 0u), u.x);
  let b = mix(hash(i + vec3<i32>(0, 1, 0), 0u), hash(i + vec3<i32>(1, 1, 0), 0u), u.x);
  let d = mix(hash(i + vec3<i32>(0, 0, 1), 0u), hash(i + vec3<i32>(1, 0, 1), 0u), u.x);
  let e = mix(hash(i + vec3<i32>(0, 1, 1), 0u), hash(i + vec3<i32>(1, 1, 1), 0u), u.x);
  return mix(mix(a, b, u.y), mix(d, e, u.y), u.z);
}
`;
export const MAIN = /* wgsl */ `
@compute @workgroup_size(64)
fn brush_main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let w = id.x + id.y * groups.x * 64u;
  if (w * 4u >= info.count) { return; }
  let row = info.size.x * info.size.z;
  var out = 0u;
  for (var k = 0u; k < 4u; k++) {
    let i = w * 4u + k;
    if (i >= info.count) { break; }
    var v = (source_cells[w] >> (k * 8u)) & 255u;
    if (info.every == 1u || ((selected_cells[w] >> (k * 8u)) & 255u) != 0u) {
      let n = i32(i);
      let y = n / row;
      let z = (n - y * row) / info.size.x;
      v = min(brush(vec3<i32>(n - y * row - z * info.size.x, y, z), v), 255u);
    }
    out |= v << (k * 8u);
  }
  result_cells[w] = out;
}
`;
export const PRELUDE_LINES = PRELUDE.split('\n').length - 1;

/** The device and pipeline of each live ShaderBrush, for GpuGrid.brush; dispose() removes its entry. */
export const brushPipelines = new WeakMap<object, { device: GPUDevice; pipeline: GPUComputePipeline }>();

/** The full WGSL module a brush compiles to: the prelude, then `code`, then the entry point `brush_main`. */
export function brushSource(code: string): string {
  if (typeof code !== 'string' || !/\bfn\s+brush\s*\(/.test(code))
    throw new TypeError('Shader brush code must be WGSL defining fn brush(p: vec3<i32>, value: u32) -> u32; pass one');
  return PRELUDE + code + MAIN;
}

export const isDevice = (device: unknown): device is GPUDevice =>
  typeof (device as GPUDevice)?.createShaderModule === 'function' &&
  typeof (device as GPUDevice)?.createComputePipeline === 'function';

/** Compiles brush `code` on `device`, naming the line of `code` on a compile error. */
export async function compileBrush(device: GPUDevice, code: string, label: string): Promise<GPUComputePipeline> {
  // The module's validation error is caught in a scope and reported below with the brush line, so a broken brush
  // rejects create() instead of raising an uncaptured device error.
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ label, code: brushSource(code) }),
    info = await module.getCompilationInfo(),
    scoped = await device.popErrorScope(),
    errors = info.messages.filter((m) => m.type === 'error');
  if (scoped && !errors.length)
    throw new MargoError('failed', `Shader brush module is invalid: ${scoped.message}; fix the WGSL`);
  if (errors.length) {
    const m = errors[0],
      line = m.lineNum - PRELUDE_LINES;
    throw new MargoError(
      'failed',
      `Shader brush code does not compile: ${m.message} (${line > 0 ? `line ${line} of the brush code` : 'in the prelude'}); fix the WGSL`,
    );
  }
  // An explicit layout: 'auto' would drop the bindings a brush leaves unused (tool, lookup, selection).
  const storage = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type },
    }),
    group = device.createBindGroupLayout({
      label,
      entries: [
        storage(0, 'uniform'),
        storage(1, 'read-only-storage'),
        storage(2, 'storage'),
        storage(3, 'read-only-storage'),
        storage(4, 'read-only-storage'),
        storage(5, 'read-only-storage'),
      ],
    });
  return device.createComputePipelineAsync({
    label,
    layout: device.createPipelineLayout({ label, bindGroupLayouts: [group] }),
    compute: { module, entryPoint: 'brush_main' },
  });
}

/** What one {@link GridBuffers.run} reads besides the grid. */
export interface PassInputs {
  passes: number;
  params: readonly number[];
  seed: number;
  /** Packed cell mask (a byte per cell, 4 per word) or null for every cell. */
  mask: Uint8Array | null;
  tool: VoxelGrid | null;
  toolOffset: Vec3;
  /** 256 entries or null. */
  table: ArrayLike<number> | null;
}

/** Bytes a grid of `count` cells takes on the GPU, refused past the device's binding limit. */
export function gridBytes(device: GPUDevice, count: number, subject: string): number {
  const bytes = Math.ceil(count / 4) * 4;
  if (bytes > device.limits.maxStorageBufferBindingSize)
    throw new RangeError(
      `${subject} grid of ${count} cells needs ${bytes} bytes, over this device's ${device.limits.maxStorageBufferBindingSize}; split the grid`,
    );
  return bytes;
}

// Read when a grid is made, not at import, so the entry loads where WebGPU is missing (Node, tests).
const storage = (): number => GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;

/** A grid in two ping-pong GPU buffers (packed, a byte per cell) that brushes run on, read back on demand. */
export class GridBuffers {
  readonly size: Vec3;
  readonly count: number;
  #device: GPUDevice;
  #bytes: number;
  #cells: GPUBuffer[];
  #current = 0;
  #uniform: GPUBuffer;
  #empty: GPUBuffer;
  #disposed = false;

  constructor(device: GPUDevice, grid: VoxelGrid, label: string) {
    const count = grid.voxels.length;
    this.#device = device;
    this.size = [grid.size[0], grid.size[1], grid.size[2]];
    this.count = count;
    this.#bytes = gridBytes(device, count, label);
    this.#cells = [0, 1].map((n) =>
      device.createBuffer({ label: `${label} cells ${n}`, size: this.#bytes, usage: storage() }),
    );
    this.#uniform = device.createBuffer({
      label: `${label} info`,
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#empty = device.createBuffer({
      label: `${label} none`,
      size: 1024,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.write(grid.voxels);
  }

  /** The buffer holding the current cells. */
  get buffer(): GPUBuffer {
    return this.#cells[this.#current];
  }

  /** Replaces every cell. */
  write(voxels: Uint8Array): void {
    const padded = new Uint8Array(this.#bytes);
    padded.set(voxels);
    this.#device.queue.writeBuffer(this.#cells[this.#current], 0, padded);
  }

  /** Runs `pipeline` for `inputs.passes` passes, each reading the result of the one before. */
  run(pipeline: GPUComputePipeline, inputs: PassInputs): void {
    const device = this.#device,
      words = this.#bytes / 4,
      groups = Math.ceil(words / 64),
      gx = Math.min(groups, 65535),
      gy = Math.ceil(groups / gx),
      temporary: GPUBuffer[] = [],
      upload = (data: Uint8Array | Uint32Array, label: string): GPUBuffer => {
        const buffer = device.createBuffer({
          label,
          size: Math.max(16, Math.ceil(data.byteLength / 4) * 4),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const padded = new Uint8Array(buffer.size);
        padded.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        device.queue.writeBuffer(buffer, 0, padded);
        temporary.push(buffer);
        return buffer;
      },
      mask = inputs.mask ? upload(inputs.mask, 'brush selection') : this.#empty,
      tool = inputs.tool
        ? (gridBytes(device, inputs.tool.voxels.length, 'Brush tool'), upload(inputs.tool.voxels, 'brush tool'))
        : this.#empty,
      table = inputs.table ? upload(Uint32Array.from(inputs.table), 'brush table') : this.#empty,
      info = new ArrayBuffer(128),
      ints = new Int32Array(info),
      uints = new Uint32Array(info),
      floats = new Float32Array(info);
    ints.set(this.size, 0);
    uints[4] = this.count;
    uints[5] = inputs.mask ? 0 : 1;
    uints[7] = inputs.seed;
    if (inputs.tool) {
      ints.set(inputs.tool.size, 8);
      ints[11] = 1;
    }
    ints.set(inputs.toolOffset, 12);
    floats.set(inputs.params, 16);
    const layout = pipeline.getBindGroupLayout(0),
      binds = [0, 1].map((n) =>
        device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer: this.#uniform } },
            { binding: 1, resource: { buffer: this.#cells[n] } },
            { binding: 2, resource: { buffer: this.#cells[1 - n] } },
            { binding: 3, resource: { buffer: mask } },
            { binding: 4, resource: { buffer: tool } },
            { binding: 5, resource: { buffer: table } },
          ],
        }),
      );
    // One submit per pass, so each pass sees its own pass number in the uniform.
    for (let pass = 0; pass < inputs.passes; pass++) {
      uints[6] = pass;
      device.queue.writeBuffer(this.#uniform, 0, info);
      const encoder = device.createCommandEncoder({ label: 'brush pass' }),
        compute = encoder.beginComputePass();
      compute.setPipeline(pipeline);
      compute.setBindGroup(0, binds[this.#current]);
      compute.dispatchWorkgroups(gx, gy);
      compute.end();
      device.queue.submit([encoder.finish()]);
      this.#current = 1 - this.#current;
    }
    if (temporary.length)
      device.queue.onSubmittedWorkDone().then(() => {
        for (const b of temporary) b.destroy();
      });
  }

  /** Reads the current cells back; rejects with the signal's reason when aborted first. */
  async read(signal?: AbortSignal): Promise<Uint8Array> {
    const device = this.#device,
      staging = device.createBuffer({
        label: 'brush read',
        size: this.#bytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }),
      encoder = device.createCommandEncoder({ label: 'brush read' });
    try {
      encoder.copyBufferToBuffer(this.#cells[this.#current], 0, staging, 0, this.#bytes);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      signal?.throwIfAborted();
      return new Uint8Array(staging.getMappedRange().slice(0, this.count));
    } finally {
      staging.destroy();
    }
  }

  /** Frees the buffers. Calling it again does nothing. */
  destroy(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const b of [...this.#cells, this.#uniform, this.#empty]) b.destroy();
  }
}
