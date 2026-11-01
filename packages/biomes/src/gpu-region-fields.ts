// Clean-room Margo derivation, 2026-11-01, from fields.ts rectFields and gpu-fixed-lerp.ts, no other engine source.
// W3C WGSL https://www.w3.org/TR/2026/CRD-WGSL-20261026/#integer-types, #bit-expr, #bitcast-builtin:
// the reused Q16 primitive implements exact signed floor interpolation with u32 limbs, x then z.
// WGSL sections 14.3 (#address-spaces), 6.5.2 (#host-shareable), 15.3 (#compute-shader-workgroups):
// packed storage, a 16-byte uniform,
// and independent 8x8 workgroups, with bounds guards for partial rectangles. No inter-invocation communication.
// WebGPU https://www.w3.org/TR/2026/CRD-webgpu-20260915/#gpubuffer, #buffer-mapping, #computepass:
// upload integers, dispatch, copy to MAP_READ storage, then map before accessing results.
// Supported claim: raw values equal rectFields before its clamps, for Int32 grids and valid region axes below.
// CPU axes retain rectFields' JS-double products and signed >>16 coordinates (nx,nz <=32768), including outside
// coordinates and the inclusive fraction 65536. Non-power-of-two cell/step ratios retain divFloor behavior.
// This internal opt-in slice makes no classification, default-backend, ecology or performance claim.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { clampInt, divFloor, ONE } from './fixed.js';
import { bilinearQ16Ref, FIXED_LERP_WGSL } from './gpu-fixed-lerp.js';
import type { Region } from './region.js';

declare const GPUBufferUsage: {
  STORAGE: number;
  COPY_DST: number;
  COPY_SRC: number;
  UNIFORM: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };

/** Internal field-major packing order; each grid is row-major with width * depth elements. */
export const REGION_FIELD_NAMES = ['rain', 'continentality', 'exposure', 'water', 'fill'] as const;
/** The five unclamped Int32 grids, with no classification or climate processing. */
export type RegionFields = Readonly<Record<(typeof REGION_FIELD_NAMES)[number], Int32Array>>;

/** Integer-only region upsampling; the sixth output plane records every executed cell as index + 1. */
export const REGION_FIELDS_WGSL =
  FIXED_LERP_WGSL +
  /* wgsl */ `
struct Shape { width: u32, depth: u32, nx: u32, nz: u32 }
@group(0) @binding(0) var<storage, read> grids: array<i32>;
@group(0) @binding(1) var<storage, read> axes: array<vec2<u32>>;
@group(0) @binding(2) var<uniform> shape: Shape;
@group(0) @binding(3) var<storage, read_write> output: array<i32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= shape.width || id.y >= shape.depth) { return; }
  let col = axes[id.x];
  let row = axes[shape.width + id.y];
  let at = row.x * shape.nx + col.x;
  let count = shape.width * shape.depth;
  let k = id.y * shape.width + id.x;
  for (var g = 0u; g < 5u; g++) {
    let base = g * shape.nx * shape.nz + at;
    output[g * count + k] = bilinearQ16(grids[base], grids[base + 1u],
      grids[base + shape.nx], grids[base + shape.nx + 1u], col.y, row.y);
  }
  output[5u * count + k] = i32(k + 1u);
}
`;

/**
 * Builds rectFields' per-column and per-row indices and inclusive Q16 fractions on the CPU.
 * @throws RangeError for invalid integer geometry or axes beyond rectFields' signed shift range.
 */
export function regionAxes(
  region: Pick<Region, 'nx' | 'nz' | 'step'>,
  cell: number,
  ox: number,
  oz: number,
  width: number,
  depth: number,
) {
  for (const size of [region.nx, region.nz])
    if (!Number.isInteger(size) || size < 2 || size > 32768)
      throw rangeError('Region axes require 2..32768 corner samples; split larger regions', 'biomes');
  for (const size of [cell, region.step, width, depth])
    if (!Number.isSafeInteger(size) || size <= 0)
      throw rangeError('Region spacing and rectangle sizes must be positive safe integers', 'biomes');
  if (!Number.isSafeInteger(cell * ONE) || !Number.isSafeInteger(width * depth) || width * depth > 0x0fffffff)
    throw rangeError('Region rectangle or cell size is too large; use a smaller rectangle or cell', 'biomes');
  if (![ox, oz, ox + width - 1, oz + depth - 1].every(Number.isSafeInteger))
    throw rangeError('Region origins and endpoints must be safe integer cell coordinates', 'biomes');
  const toRegion = divFloor(cell * ONE, region.step);
  const axis = (origin: number, length: number, samples: number) => {
    const index = new Int32Array(length),
      frac = new Int32Array(length);
    for (let i = 0; i < length; i++) {
      const f = clampInt((origin + i) * toRegion, 0, (samples - 1) * ONE),
        at = Math.min(samples - 2, f >> 16);
      index[i] = at;
      frac[i] = f - at * ONE;
    }
    return { index, frac };
  };
  const col = axis(ox, width, region.nx),
    row = axis(oz, depth, region.nz);
  return { colIndex: col.index, colFrac: col.frac, rowIndex: row.index, rowFrac: row.frac };
}

function checkGrids(region: Region) {
  if (5 * region.nx * region.nz > 0xffffffff)
    throw rangeError('Packed region grids exceed u32 addressing; split the region', 'biomes');
  for (const name of REGION_FIELD_NAMES)
    if (!(region[name] instanceof Int32Array) || region[name].length !== region.nx * region.nz)
      throw typeError(`Region ${name} must be an Int32Array of nx * nz corner samples`, 'biomes');
}

function unpack(values: Int32Array, count: number): RegionFields {
  return Object.fromEntries(
    REGION_FIELD_NAMES.map((name, g) => [name, values.subarray(g * count, (g + 1) * count)]),
  ) as RegionFields;
}

/** CPU reference for the five raw grids, using rectFields' axes and x-then-z floor rounding. */
export function regionFieldsRef(
  region: Region,
  cell: number,
  ox: number,
  oz: number,
  width: number,
  depth: number,
): RegionFields {
  const axes = regionAxes(region, cell, ox, oz, width, depth);
  checkGrids(region);
  const result = unpack(new Int32Array(5 * width * depth), width * depth);
  for (const name of REGION_FIELD_NAMES) {
    const grid = region[name];
    for (let j = 0; j < depth; j++)
      for (let i = 0; i < width; i++) {
        const at = axes.rowIndex[j] * region.nx + axes.colIndex[i];
        result[name][j * width + i] = bilinearQ16Ref(
          grid[at],
          grid[at + 1],
          grid[at + region.nx],
          grid[at + region.nx + 1],
          axes.colFrac[i],
          axes.rowFrac[j],
        );
      }
  }
  return result;
}

/** Applies the existing rectFields clamps into the LAYERS u16/u8/u16 storage formats. */
export function storedRegionLayers(raw: RegionFields) {
  return {
    rainfall: Uint16Array.from(raw.rain, (v) => clampInt(v, 0, 65535)),
    exposure: Uint8Array.from(raw.exposure, (v) => clampInt(v, 0, 255)),
    waterDistance: Uint16Array.from(raw.water, (v) => clampInt(v, 0, 65535)),
  };
}

/**
 * Opt-in internal WebGPU upsampling, with the same raw layout as regionFieldsRef. Own buffers are always destroyed.
 * No device is created or destroyed. The optional signal defaults to no cancellation and rejects with its reason.
 * @throws RangeError/TypeError for invalid inputs; MargoError 'failed' for GPU validation, loss or incomplete writes.
 */
export async function upsampleRegionFieldsGPU(
  device: GPUDevice,
  region: Region,
  cell: number,
  ox: number,
  oz: number,
  width: number,
  depth: number,
  { signal }: { readonly signal?: AbortSignal } = {},
): Promise<RegionFields> {
  signal?.throwIfAborted();
  const axes = regionAxes(region, cell, ox, oz, width, depth);
  checkGrids(region);
  const count = width * depth,
    bytes = 6 * count * 4,
    gridCount = region.nx * region.nz;
  const buffers: GPUBuffer[] = [];
  let rejectFailure: (reason: unknown) => void = () => {};
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const abort = () => rejectFailure(signal?.reason);
  const uncaptured = (event: GPUUncapturedErrorEvent) =>
    rejectFailure(
      fault('failed', `Region upsampling GPU error: ${event.error.message}; use a valid WebGPU device`, 'biomes'),
    );
  signal?.addEventListener('abort', abort, { once: true });
  device.addEventListener('uncapturederror', uncaptured);
  // WebGPU section 22: mapAsync rejects on device loss. Avoid retaining a device.lost callback per request.
  const wait = <T>(pending: Promise<T>) => Promise.race([pending, failure]);
  try {
    const sizes = [5 * gridCount * 4, (width + depth) * 8, 16, bytes];
    if (
      sizes.some((n) => n > device.limits.maxBufferSize) ||
      [sizes[0], sizes[1], bytes].some((n) => n > device.limits.maxStorageBufferBindingSize) ||
      Math.ceil(width / 8) > device.limits.maxComputeWorkgroupsPerDimension ||
      Math.ceil(depth / 8) > device.limits.maxComputeWorkgroupsPerDimension
    )
      throw rangeError('Region rectangle exceeds device limits; split it into smaller rectangles', 'biomes');
    device.pushErrorScope('validation');
    let module: GPUShaderModule, pipelinePromise: Promise<GPUComputePipeline>;
    let compilePromise: Promise<GPUCompilationInfo>;
    let scope: Promise<GPUError | null>;
    try {
      module = device.createShaderModule({ code: REGION_FIELDS_WGSL });
      compilePromise = module.getCompilationInfo();
      pipelinePromise = device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    } finally {
      scope = device.popErrorScope();
    }
    const [compilation, pipeline, validation] = await wait(Promise.all([compilePromise, pipelinePromise, scope]));
    if (compilation.messages.length || validation)
      throw fault(
        'failed',
        `Region shader compilation or validation failed: ${validation?.message ?? compilation.messages.map((m) => m.message).join('; ')}; check the WGSL device support`,
        'biomes',
      );
    const packed = new Int32Array(5 * gridCount);
    REGION_FIELD_NAMES.forEach((name, g) => packed.set(region[name], g * gridCount));
    const axisData = new Int32Array(2 * (width + depth));
    for (let i = 0; i < width; i++) axisData.set([axes.colIndex[i], axes.colFrac[i]], 2 * i);
    for (let j = 0; j < depth; j++) axisData.set([axes.rowIndex[j], axes.rowFrac[j]], 2 * (width + j));
    const make = (size: number, usage: GPUBufferUsageFlags) => {
      const buffer = device.createBuffer({ size, usage });
      buffers.push(buffer);
      return buffer;
    };
    device.pushErrorScope('validation');
    let readback: GPUBuffer, mapping: Promise<void>;
    try {
      const src = make(packed.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        axis = make(axisData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        shape = make(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
        dst = make(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      readback = make(bytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
      device.queue.writeBuffer(src, 0, packed);
      device.queue.writeBuffer(axis, 0, axisData);
      device.queue.writeBuffer(shape, 0, new Uint32Array([width, depth, region.nx, region.nz]));
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [src, axis, shape, dst].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(depth / 8));
      pass.end();
      encoder.copyBufferToBuffer(dst, 0, readback, 0, bytes);
      device.queue.submit([encoder.finish()]);
      mapping = readback.mapAsync(GPUMapMode.READ);
    } finally {
      scope = device.popErrorScope();
    }
    const [, error] = await wait(Promise.all([mapping, scope]));
    if (error)
      throw fault('failed', `Region dispatch validation failed: ${error.message}; check device limits`, 'biomes');
    const values = new Int32Array(readback.getMappedRange()).slice();
    readback.unmap();
    for (let k = 0; k < count; k++)
      if (values[5 * count + k] !== k + 1)
        throw fault('failed', 'Region dispatch left cells unwritten; check the shader dispatch dimensions', 'biomes');
    return unpack(values.subarray(0, 5 * count), count);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof RangeError || (error as Error)?.name === 'MargoError') throw error;
    throw fault(
      'failed',
      `Region upsampling failed: ${String(error)}; recreate the WebGPU device and check its limits`,
      'biomes',
    );
  } finally {
    signal?.removeEventListener('abort', abort);
    device.removeEventListener('uncapturederror', uncaptured);
    for (const buffer of buffers) buffer.destroy();
  }
}
