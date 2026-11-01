// Clean-room Margo derivation, 2026-11-01, from classify.ts and the existing Q16 limb primitive.
// W3C WGSL https://www.w3.org/TR/2026/CRD-WGSL-20261026/:
// #integer-types (wrap), #arithmetic-expr (signed division truncates), #bit-expr (signed right shift),
// #bitcast-builtin (Q16 limbs), #address-spaces and #compute-shader-workgroups (storage and guarded 8x8 dispatch).
// WebGPU https://www.w3.org/TR/2026/CRD-webgpu-20260915/:
// #buffer-mapping, #computepass, #error-scopes, #gpuadapterinfo support transport, validation and selected identity.
// The 700 m warp is Margo's pre-existing design. Perlin's Improving Noise is background for CPU fbm only,
// not evidence for this warp design. This slice makes no ecology, classification-default or performance claim.
// For |corner| <= B = floor((2^31-1)/160)-32768 = 13389004, bilinear stays in [-B,B].
// Therefore |bilinear-32768| <= B+32768 and its product by 160 <= 2147483520 fits i32.
// CPU lerp products are below 2^41, so JS integer-valued doubles and the WGSL limb primitive agree exactly.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { WarpLattice } from './classify-warp.js';
import { FIXED_LERP_WGSL } from './gpu-fixed-lerp.js';

declare const GPUBufferUsage: {
  STORAGE: number;
  COPY_DST: number;
  COPY_SRC: number;
  UNIFORM: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };

/** Largest symmetric corner magnitude that keeps the biased temperature product within i32. */
export const WARP_CORNER_BOUND = 13389004;

/** Interpolation only; the CPU retains fbm generation. The fourth plane marks every executed invocation. */
export const CLASSIFY_WARP_WGSL =
  FIXED_LERP_WGSL +
  /* wgsl */ `
struct Shape { n: u32, depth: u32, span: u32, rows: u32, ox: u32, oz: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<storage, read> lattice: array<i32>;
@group(0) @binding(1) var<uniform> shape: Shape;
@group(0) @binding(2) var<storage, read_write> output: array<i32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= shape.n || id.y >= shape.depth) { return; }
  let x = shape.ox + id.x;
  let z = shape.oz + id.y;
  let at = (z >> 3u) * shape.span + (x >> 3u);
  let fx = (x & 7u) << 13u;
  let fz = (z & 7u) << 13u;
  let count = shape.n * shape.depth;
  let k = id.y * shape.n + id.x;
  let base = shape.span * shape.rows;
  let n1 = bilinearQ16(lattice[at], lattice[at+1u], lattice[at+shape.span], lattice[at+shape.span+1u], fx, fz) - 32768;
  let n2 = bilinearQ16(lattice[base+at], lattice[base+at+1u], lattice[base+at+shape.span], lattice[base+at+shape.span+1u], fx, fz) - 32768;
  output[k] = n1;
  output[count+k] = n2;
  // WGSL #arithmetic-expr truncates signed division; #bit-expr sign-fills >>, giving JS floor for negatives.
  output[2u*count+k] = (n1 * 160) >> 15u;
  output[3u*count+k] = i32(k+1u);
}
`;

function checkLattice(lattice: WarpLattice, gx: number, gz: number, n: number, depth: number) {
  if (![n, depth].every((v) => Number.isSafeInteger(v) && v >= 1) || n * depth > 0x3fffffff)
    throw rangeError(
      'Warp dimensions must be positive safe integers within u32 plane addressing; split the rectangle',
      'biomes',
    );
  if (![gx, gz, gx + n, gz + depth].every((v) => Number.isSafeInteger(v) && v >= -2147483648 && v <= 2147483647))
    throw rangeError(
      'Warp origins and endpoints must fit signed i32 cell coordinates; use a smaller rectangle or origin',
      'biomes',
    );
  if (
    !lattice ||
    lattice.a0 !== gx >> 3 ||
    lattice.b0 !== gz >> 3 ||
    lattice.span !== ((gx + n) >> 3) - lattice.a0 + 2 ||
    lattice.rows !== ((gz + depth) >> 3) - lattice.b0 + 2 ||
    2 * lattice.span * lattice.rows > 0xffffffff
  )
    throw rangeError('Warp lattice geometry does not cover this rectangle; rebuild it with warpLattice', 'biomes');
  for (const grid of [lattice.warpA, lattice.warpB]) {
    if (!(grid instanceof Int32Array) || grid.length !== lattice.span * lattice.rows)
      throw typeError(
        'Warp lattices must be Int32Arrays of span * rows samples; rebuild them with warpLattice',
        'biomes',
      );
  }
}

/**
 * Internal opt-in interpolation. Own buffers are destroyed; the caller retains its device.
 * The optional signal defaults to no cancellation and rejects with its reason.
 * @throws RangeError/TypeError for invalid inputs; MargoError 'failed' for GPU failure or missing writes.
 */
export async function classifyWarpGPU(
  device: GPUDevice,
  lattice: WarpLattice,
  gx: number,
  gz: number,
  n: number,
  depth: number,
  { signal }: { readonly signal?: AbortSignal } = {},
): Promise<{ n1: Int32Array; n2: Int32Array; dT: Int32Array }> {
  signal?.throwIfAborted();
  checkLattice(lattice, gx, gz, n, depth);
  const { span, rows, a0, b0, warpA, warpB } = lattice;
  const count = n * depth,
    bytes = 4 * count * 4,
    gridCount = span * rows,
    ox = gx - a0 * 8,
    oz = gz - b0 * 8;
  const buffers: GPUBuffer[] = [];
  let rejectFailure: (reason: unknown) => void = () => {};
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const abort = () => rejectFailure(signal?.reason);
  const uncaptured = (event: GPUUncapturedErrorEvent) =>
    rejectFailure(
      fault('failed', `Ecotone warp GPU error: ${event.error.message}; use a valid WebGPU device`, 'biomes'),
    );
  signal?.addEventListener('abort', abort, { once: true });
  device.addEventListener('uncapturederror', uncaptured);
  // WebGPU section 22: mapAsync rejects on device loss. Avoid retaining a device.lost callback per request.
  const wait = <T>(pending: Promise<T>) => Promise.race([pending, failure]);
  try {
    const sizes = [2 * gridCount * 4, 32, bytes];
    if (
      sizes.some((n) => n > device.limits.maxBufferSize) ||
      [sizes[0], bytes].some((n) => n > device.limits.maxStorageBufferBindingSize) ||
      Math.ceil(n / 8) > device.limits.maxComputeWorkgroupsPerDimension ||
      Math.ceil(depth / 8) > device.limits.maxComputeWorkgroupsPerDimension
    )
      throw rangeError('Ecotone warp rectangle exceeds device limits; split it into smaller rectangles', 'biomes');
    // Snapshot before any await so later caller writes cannot bypass the checked corner bound.
    const packed = new Int32Array(2 * gridCount);
    packed.set(warpA);
    packed.set(warpB, gridCount);
    for (const value of packed)
      if (Math.abs(value) > WARP_CORNER_BOUND)
        throw rangeError(
          'Warp corner exceeds the safe i32 temperature bound; use corners within +/-13389004',
          'biomes',
        );
    device.pushErrorScope('validation');
    let module: GPUShaderModule, pipelinePromise: Promise<GPUComputePipeline>;
    let compilePromise: Promise<GPUCompilationInfo>;
    let scope: Promise<GPUError | null>;
    try {
      module = device.createShaderModule({ code: CLASSIFY_WARP_WGSL });
      compilePromise = module.getCompilationInfo();
      pipelinePromise = device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    } finally {
      scope = device.popErrorScope();
    }
    const [compilation, pipeline, validation] = await wait(Promise.all([compilePromise, pipelinePromise, scope]));
    if (compilation.messages.length || validation)
      throw fault(
        'failed',
        `Ecotone warp shader compilation or validation failed: ${validation?.message ?? compilation.messages.map((m) => m.message).join('; ')}; check the WGSL device support`,
        'biomes',
      );
    signal?.throwIfAborted();
    const make = (size: number, usage: GPUBufferUsageFlags) => {
      const buffer = device.createBuffer({ size, usage });
      buffers.push(buffer);
      return buffer;
    };
    device.pushErrorScope('validation');
    let readback: GPUBuffer, mapping: Promise<void>;
    try {
      const src = make(packed.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        shape = make(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
        dst = make(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      readback = make(bytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
      device.queue.writeBuffer(src, 0, packed);
      device.queue.writeBuffer(shape, 0, new Uint32Array([n, depth, span, rows, ox, oz, 0, 0]));
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [src, shape, dst].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(depth / 8));
      pass.end();
      encoder.copyBufferToBuffer(dst, 0, readback, 0, bytes);
      device.queue.submit([encoder.finish()]);
      mapping = readback.mapAsync(GPUMapMode.READ);
    } finally {
      scope = device.popErrorScope();
    }
    const [, error] = await wait(Promise.all([mapping, scope]));
    if (error)
      throw fault('failed', `Ecotone warp dispatch validation failed: ${error.message}; check device limits`, 'biomes');
    signal?.throwIfAborted();
    const values = new Int32Array(readback.getMappedRange()).slice();
    readback.unmap();
    for (let k = 0; k < count; k++)
      if (values[3 * count + k] !== k + 1)
        throw fault(
          'failed',
          'Ecotone warp dispatch left cells unwritten; check the shader dispatch dimensions',
          'biomes',
        );
    return {
      n1: values.subarray(0, count),
      n2: values.subarray(count, 2 * count),
      dT: values.subarray(2 * count, 3 * count),
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof RangeError || (error as Error)?.name === 'MargoError') throw error;
    throw fault(
      'failed',
      `Ecotone warp failed: ${String(error)}; recreate the WebGPU device and check its limits`,
      'biomes',
    );
  } finally {
    signal?.removeEventListener('abort', abort);
    device.removeEventListener('uncapturederror', uncaptured);
    for (const buffer of buffers) buffer.destroy();
  }
}
