// Clean-room derivation from Margo classify.ts; no other engine source.
// Primary arithmetic provenance: W3C WGSL https://www.w3.org/TR/2026/CRD-WGSL-20261026/
// #integer-types, #arithmetic-expr (wrap and truncation), #bit-expr, #bitcast-builtin (exact limbs),
// #address-spaces, #compute-shader-workgroups (storage and guarded 8x8 dispatch).
// Transport: WebGPU https://www.w3.org/TR/2026/CRD-webgpu-20260915/
// #buffer-mapping, #computepass, #error-scopes, #gpuadapterinfo (readback, ordering, validation, identity).
// Kernel: Wendland 1995, https://doi.org/10.1007/BF02123482, C2 polynomial as cited in fixed.ts.
// Margo-specific choices: integer sources |v| <= 2^30, CPU fbm, CPU zone scorer and selection tail,
// saturating envelope comparisons, and execution markers. Normal fbm gives |n2| <= 32768, |dT| <= 160.
// Claim: bytes equal classify() within this domain, given classifyWarpGPU equals warpPlanes.
// No ecology, default-backend or performance claim. Internal opt-in only; no public export.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { classifyPlanes, type Classifier, type ClassifyInput, type ClassifyPlanes } from './classify.js';
import { warpLattice } from './classify-warp.js';
import { classifyWarpGPU } from './gpu-classify-warp.js';

declare const GPUBufferUsage: {
  STORAGE: number;
  COPY_DST: number;
  COPY_SRC: number;
  UNIFORM: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };

/** Internal source bound: all additions fit i32 and all CPU rainfall products are exact binary64 integers. */
export const SOURCE_BOUND = 1073741824;

/** Input warping and ordered envelope products. The second half of output marks every executed address. */
export const CLASSIFY_INPUTS_WGSL = /* wgsl */ `
struct Shape { n: u32, depth: u32, cells: u32, total: u32, slots: u32, count: u32, starts: u32, dims: u32 }
@group(0) @binding(0) var<storage, read> sources: array<i32>;
@group(0) @binding(1) var<storage, read> warp: array<i32>;
@group(0) @binding(2) var<storage, read> table: array<i32>;
@group(0) @binding(3) var<uniform> shape: Shape;
@group(0) @binding(4) var<storage, read_write> output: array<i32>;

fn floor10(t: i32) -> i32 {
  let a = u32(abs(t));
  let q = a / 10u;
  if (t < 0) { return -i32(q + select(0u, 1u, a % 10u != 0u)); }
  return i32(q);
}

// Reused from archived 9c93c2af, with the full source domain and normal fbm bounds.
// v*n2*16/6553600 = v*n2/409600. |v*n2| <= 2^45, so the CPU integer product
// (including *16) is exact; division rounding is at most 2^-27, below the least nonzero remainder 1/6553600.
// 409600 = 2^14*25: the magnitude shifted by 14 fits u32. Retain its discarded bits for negative floor.
fn rainDelta(v: i32, noise: i32) -> i32 {
  let a = u32(abs(v));
  let b = u32(abs(noise));
  let low = (a & 65535u) * (b & 65535u);
  let cross = (a >> 16u) * (b & 65535u) + (a & 65535u) * (b >> 16u);
  let lo = low + (cross << 16u);
  let hi = (a >> 16u) * (b >> 16u) + (cross >> 16u) + select(0u, 1u, lo < low);
  let u = (hi << 18u) | (lo >> 14u);
  let q = u / 25u;
  let remainder = u % 25u != 0u || (lo & 16383u) != 0u;
  if ((v < 0) != (noise < 0)) { return -i32(q + select(0u, 1u, remainder)); }
  return i32(q);
}

@compute @workgroup_size(8, 8)
fn inputs(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= shape.n || id.y >= shape.depth || id.z >= shape.slots) { return; }
  let k = id.y * shape.n + id.x;
  let at = id.z * shape.cells + k;
  let v = sources[at];
  let noise = warp[k];
  let t = warp[shape.cells+k];
  var value = 0;
  if (table[2u*id.z+1u] != 0) {
    switch table[2u*id.z] {
      case 0: { value = max(0, v); }
      case 1: { value = v + t; }
      case 2: { value = max(0, v + 2*t); }
      case 3: { value = clamp(v + floor10(t), 0, 365); }
      case 4: { value = max(0, v + rainDelta(v, noise)); }
      case 5: { value = clamp(v + ((noise * 10) >> 15u), 0, 255); }
      default: { value = v; }
    }
  }
  output[at] = value;
  output[shape.total+at] = i32(at+1u);
}

// reach < width <= 2^31-1; doubling the remainder fits u32 at every restoring step.
fn ratioQ16(reach: u32, width: u32) -> u32 {
  var rem = reach;
  var r = 0u;
  for (var bit = 0u; bit < 16u; bit++) {
    rem <<= 1u;
    r <<= 1u;
    if (rem >= width) { rem -= width; r |= 1u; }
  }
  return r;
}

@compute @workgroup_size(8, 8)
fn members(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= shape.n || id.y >= shape.depth || id.z >= shape.count) { return; }
  let k = id.y * shape.n + id.x;
  var mk = 65536u;
  let end = u32(table[shape.starts+id.z+1u]);
  for (var q = u32(table[shape.starts+id.z]); q < end; q++) {
    if (mk == 0u) { continue; }
    let at = shape.dims+4u*q;
    let x = output[u32(table[at])*shape.cells+k];
    let lo = table[at+1u];
    let hi = table[at+2u];
    let width = u32(table[at+3u]);
    let half = width >> 1u;
    var reach = 0u;
    if (x < lo || x > hi) {
      // The positive distance can exceed i32. Unsigned subtraction is exact up to 2^32-1.
      let dist = select(bitcast<u32>(x)-bitcast<u32>(hi), bitcast<u32>(lo)-bitcast<u32>(x), x < lo);
      if (dist >= width-half) { mk = 0u; continue; }
      reach = dist+half;
    } else {
      let inside = min(bitcast<u32>(x)-bitcast<u32>(lo), bitcast<u32>(hi)-bitcast<u32>(x));
      if (inside >= half) { continue; }
      reach = half-inside;
    }
    let r = ratioQ16(reach, width);
    let s = 65536u-r;
    // r can be zero after flooring a very wide ramp; avoid squaring 65536 in u32.
    if (r == 0u) { continue; }
    let s2 = (s*s) >> 16u;
    let s4 = (s2*s2) >> 16u;
    let t = 4u*r+65536u;
    let w = s4*(t >> 16u) + ((s4*(t & 65535u)) >> 16u);
    if (mk == 65536u) { mk = w; }
    else { mk = (mk*w) >> 16u; }
  }
  let at = (shape.slots+id.z)*shape.cells+k;
  output[at] = i32(mk);
  output[shape.total+at] = i32(at+1u);
}
`;

function prepare(device: GPUDevice, c: Classifier, input: ClassifyInput) {
  if (!c || !input) throw typeError('Supply a classifier and classification grid', 'biomes');
  const { n, gx, gz, seed, cell } = input,
    depth = input.depth ?? n;
  if (![n, depth].every((v) => Number.isSafeInteger(v) && v >= 3) || n * depth > 0x3fffffff)
    throw rangeError('Classification needs at least a 3 by 3 integer grid; split oversized rectangles', 'biomes');
  if (![gx, gz, gx + n, gz + depth].every((v) => Number.isSafeInteger(v) && v >= -2147483648 && v <= 2147483647))
    throw rangeError('Classification origins and endpoints must fit i32; use a smaller rectangle or origin', 'biomes');
  if (
    !Number.isSafeInteger(seed) ||
    seed < -2147483648 ||
    seed > 4294967295 ||
    !Number.isSafeInteger(cell) ||
    cell <= 0
  )
    throw rangeError('Supply an integer seed and a positive safe integer cell size in mm', 'biomes');
  if (input.ecotone !== undefined && (!Number.isSafeInteger(input.ecotone) || input.ecotone < 0))
    throw rangeError('Supply a nonnegative integer ecotone half width in cells', 'biomes');
  const cells = n * depth,
    slots = c.inputs.length,
    count = c.ids.length,
    d = c.envelopes,
    zones = !!c.score,
    starts = 2 * slots,
    dims = starts + count + 1,
    total = (slots + (zones ? 0 : count)) * cells;
  if (!slots || count < 1 || count > 255 || !(c.modes instanceof Int32Array) || c.modes.length !== slots)
    throw typeError('Supply a built classifier with input modes and 1 to 255 biomes', 'biomes');
  if (
    !d ||
    !(d.start instanceof Int32Array) ||
    d.start.length !== count + 1 ||
    !(d.slot instanceof Int32Array) ||
    !(d.width instanceof Int32Array) ||
    !(d.lo instanceof Float64Array) ||
    !(d.hi instanceof Float64Array) ||
    [d.width.length, d.lo.length, d.hi.length].some((v) => v !== d.slot.length)
  )
    throw typeError('Supply matching flattened envelope arrays from classifier()', 'biomes');
  if (
    d.start[0] !== 0 ||
    d.start[count] !== d.slot.length ||
    d.start.some((v, b) => v < 0 || (b > 0 && v < d.start[b - 1]))
  )
    throw rangeError('Envelope starts must cover the dimensions in biome order; rebuild the classifier', 'biomes');
  for (let q = 0; q < d.slot.length; q++)
    if (
      d.slot[q] < 0 ||
      d.slot[q] >= slots ||
      ![d.lo[q], d.hi[q], d.width[q]].every((v) => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) ||
      d.lo[q] > d.hi[q] ||
      d.width[q] < 1
    )
      throw rangeError(
        'Envelope bounds must fit i32 and widths must be 1 to 2147483647; rebuild the classifier',
        'biomes',
      );
  const span = ((gx + n) >> 3) - (gx >> 3) + 2,
    rows = ((gz + depth) >> 3) - (gz >> 3) + 2,
    sizes = [4 * slots * cells, 8 * cells, 4 * (dims + 4 * d.slot.length), 32, 8 * total],
    warpSizes = [8 * span * rows, 16 * cells];
  if (
    !Number.isSafeInteger(total) ||
    total > 0x7fffffff ||
    [...sizes, ...warpSizes].some((v) => v > device.limits.maxBufferSize) ||
    [...sizes.filter((_, i) => i !== 3), ...warpSizes].some((v) => v > device.limits.maxStorageBufferBindingSize) ||
    [Math.ceil(n / 8), Math.ceil(depth / 8), slots, zones ? 1 : count].some(
      (v) => v > device.limits.maxComputeWorkgroupsPerDimension,
    )
  )
    throw rangeError('Classification planes exceed device limits; split the rectangle', 'biomes');
  const packed = new Int32Array(slots * cells),
    table = new Int32Array(dims + 4 * d.slot.length);
  table.set(d.start, starts);
  for (let q = 0; q < d.slot.length; q++) table.set([d.slot[q], d.lo[q], d.hi[q], d.width[q]], dims + 4 * q);
  // Snapshot and validate the original numbers before Int32Array conversion or any async GPU call.
  for (let s = 0; s < slots; s++) {
    const mode = c.modes[s],
      source = mode ? input.layer(c.inputs[s]) : input.user(c.inputs[s]);
    if (mode < 0 || mode > 6) throw rangeError('Supply classification modes from 0 through 6', 'biomes');
    table[2 * s] = mode;
    if (source === undefined) continue;
    if (!source || source.length !== cells)
      throw typeError('Supply each source with n * depth cells, or undefined', 'biomes');
    table[2 * s + 1] = 1;
    for (let k = 0; k < cells; k++) {
      const v = source[k];
      if (!Number.isInteger(v) || Math.abs(v) > SOURCE_BOUND)
        throw rangeError(
          'Classification sources must be integers within +/-1073741824; quantize or rescale the source',
          'biomes',
        );
      packed[s * cells + k] = v;
    }
  }
  return {
    n,
    depth,
    gx,
    gz,
    seed,
    cell,
    cells,
    slots,
    count,
    zones,
    starts,
    dims,
    total,
    sizes,
    packed,
    table,
    feathered: !!input.ecotone && !!c.paint.length,
  };
}

/**
 * Internal opt-in GPU inputs and envelope memberships, followed by the shared CPU zone scorer when supplied.
 * Own buffers are destroyed. Signal defaults to no cancellation and rejects with its reason.
 * Invalid inputs throw TypeError/RangeError before GPU allocation; GPU failures throw MargoError 'failed'.
 * Returned arrays are request-owned, never shared CPU scratch.
 */
export async function classifyInputsGPU(
  device: GPUDevice,
  c: Classifier,
  input: ClassifyInput,
  { signal }: { readonly signal?: AbortSignal } = {},
): Promise<ClassifyPlanes> {
  signal?.throwIfAborted();
  const p = prepare(device, c, input);
  const warp = await classifyWarpGPU(
    device,
    warpLattice(p.seed, p.cell, p.gx, p.gz, p.n, p.depth),
    p.gx,
    p.gz,
    p.n,
    p.depth,
    { signal },
  );
  signal?.throwIfAborted();
  const buffers: GPUBuffer[] = [];
  let result: ClassifyPlanes;
  let rejectFailure: (reason: unknown) => void = () => {};
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const pendingTasks: Promise<unknown>[] = [failure];
  const abort = () => rejectFailure(signal?.reason);
  const uncaptured = (event: GPUUncapturedErrorEvent) =>
    rejectFailure(
      fault('failed', `Classification GPU error: ${event.error.message}; use a valid WebGPU device`, 'biomes'),
    );
  const wait = <T>(pending: Promise<T>) => Promise.race([pending, failure]);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    device.addEventListener('uncapturederror', uncaptured);
    device.pushErrorScope('validation');
    let compile: Promise<GPUCompilationInfo>,
      pipelineTasks: Promise<GPUComputePipeline>[],
      scope: Promise<GPUError | null>;
    try {
      const module = device.createShaderModule({ code: CLASSIFY_INPUTS_WGSL });
      compile = module.getCompilationInfo();
      pendingTasks.push(compile);
      pipelineTasks = [];
      for (const entryPoint of p.zones ? ['inputs'] : ['inputs', 'members']) {
        const task = device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } });
        pipelineTasks.push(task);
        pendingTasks.push(task);
      }
    } finally {
      scope = device.popErrorScope();
      pendingTasks.push(scope);
    }
    const [compilation, pipelines, validation] = await wait(Promise.all([compile, Promise.all(pipelineTasks), scope]));
    if (compilation.messages.length || validation)
      throw fault(
        'failed',
        `Classification compilation failed: ${validation?.message ?? compilation.messages.map((m) => m.message).join('; ')}; check WGSL device support`,
        'biomes',
      );
    signal?.throwIfAborted();
    const make = (size: number, usage: GPUBufferUsageFlags) => {
      const b = device.createBuffer({ size, usage });
      buffers.push(b);
      return b;
    };
    device.pushErrorScope('validation');
    let readback: GPUBuffer, mapping: Promise<void>;
    try {
      const src = make(p.sizes[0], GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        noise = make(p.sizes[1], GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        table = make(p.sizes[2], GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        shape = make(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
        dst = make(p.sizes[4], GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      readback = make(p.sizes[4], GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
      const packedWarp = new Int32Array(2 * p.cells);
      packedWarp.set(warp.n2);
      packedWarp.set(warp.dT, p.cells);
      device.queue.writeBuffer(src, 0, p.packed);
      device.queue.writeBuffer(noise, 0, packedWarp);
      device.queue.writeBuffer(table, 0, p.table);
      device.queue.writeBuffer(
        shape,
        0,
        new Uint32Array([p.n, p.depth, p.cells, p.total, p.slots, p.count, p.starts, p.dims]),
      );
      const encoder = device.createCommandEncoder();
      for (let i = 0; i < pipelines.length; i++) {
        const pipeline = pipelines[i];
        const entries = [src, noise, table, shape, dst].map((buffer, binding) => ({ binding, resource: { buffer } }));
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: i ? entries.slice(2) : entries,
        });
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(p.n / 8), Math.ceil(p.depth / 8), i ? p.count : p.slots);
        pass.end();
      }
      encoder.copyBufferToBuffer(dst, 0, readback, 0, p.sizes[4]);
      device.queue.submit([encoder.finish()]);
      mapping = readback.mapAsync(GPUMapMode.READ);
      pendingTasks.push(mapping);
    } finally {
      scope = device.popErrorScope();
      pendingTasks.push(scope);
    }
    const [, error] = await wait(Promise.all([mapping, scope]));
    if (error) throw fault('failed', `Classification dispatch failed: ${error.message}; check device limits`, 'biomes');
    signal?.throwIfAborted();
    const values = new Int32Array(readback.getMappedRange()).slice();
    readback.unmap();
    for (let k = 0; k < p.total; k++)
      if (values[p.total + k] !== k + 1)
        throw fault('failed', 'Classification left cells unwritten; check shader dispatch dimensions', 'biomes');
    const warped = values.subarray(0, p.slots * p.cells),
      member = p.zones ? new Int32Array(p.count * p.cells) : values.subarray(p.slots * p.cells, p.total);
    result = { warped, member, n2: warp.n2, n1s: p.feathered ? warp.n1 : undefined };
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as Error)?.name === 'MargoError') throw error;
    throw fault(
      'failed',
      `Classification failed: ${String(error)}; recreate the WebGPU device and check its limits`,
      'biomes',
    );
  } finally {
    // Observe secondary rejections even when a synchronous API failure prevents awaiting the phase.
    void Promise.allSettled(pendingTasks);
    signal?.removeEventListener('abort', abort);
    device.removeEventListener('uncapturederror', uncaptured);
    for (const buffer of buffers) buffer.destroy();
  }
  c.score?.(result.warped, p.cells, result.member);
  return result;
}

/** Internal opt-in classification; the synchronous paint, zone, fallback and selection rules stay shared. */
export async function classifyGPU(
  device: GPUDevice,
  c: Classifier,
  input: ClassifyInput,
  ids: Uint8Array,
  weights: Uint8Array,
  { signal }: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  signal?.throwIfAborted();
  const length = (input.n - 2) * ((input.depth ?? input.n) - 2) * 4;
  if (
    !(ids instanceof Uint8Array) ||
    !(weights instanceof Uint8Array) ||
    ids.length < length ||
    weights.length < length
  )
    throw typeError('Supply Uint8Array ids and weights with four slots per inner cell', 'biomes');
  const planes = await classifyInputsGPU(device, c, input, { signal });
  signal?.throwIfAborted();
  classifyPlanes(c, input, planes, ids, weights);
}
