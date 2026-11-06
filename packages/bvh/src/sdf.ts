// The `sdf` entry: a signed distance field baked from a MeshBVH into a regular grid. Distance comes from the tree's
// closest-point query, the sign from the winding number, so a mesh with small gaps still bakes a clean inside.
import type { MutableVec3, Vec3 } from '@margoengine/math';
import type { Box3Like, MeshBVH } from './bvh.js';
import { windingAccuracy, windingAt, type WindingOptions } from './winding.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; STORAGE_BINDING: number; COPY_DST: number; COPY_SRC: number };

/** Settings of {@link bakeSDF}. */
export interface SDFOptions extends WindingOptions {
  /** Samples along the longest side of the box; the others follow so cells stay cubic. Or samples per axis. Default 32. */
  resolution?: number | readonly [number, number, number];
  /** The box to bake. Default the mesh's box, grown by `padding`. */
  bounds?: Box3Like;
  /** Margin around the mesh's box, as a share of its longest side. Default 0.1. */
  padding?: number;
  /** false bakes plain distance with no sign, for open meshes such as a terrain or a cloth. Default true. */
  signed?: boolean;
}
/** Settings of {@link bakeSDFAsync}. */
export interface SDFAsyncOptions extends SDFOptions {
  signal?: AbortSignal;
  /** Called with the share done, 0 to 1, between slices of work. */
  onProgress?: (done: number) => void;
}
/** Settings of {@link MeshSDF.toTexture}. */
export interface SDFTextureOptions {
  /** 'r16float' filters on every WebGPU device; 'r32float' keeps full precision and takes `usage` STORAGE_BINDING for sculpting, but needs 'float32-filterable' to filter. Default 'r16float'. */
  format?: 'r16float' | 'r32float';
  /** Extra GPUTextureUsage flags, added to TEXTURE_BINDING and COPY_DST. Default 0. */
  usage?: number;
}

const SLICE_MS = 8;

/**
 * A signed distance field: negative inside the mesh, positive outside, in the mesh's own space, sampled on a grid and
 * read back by trilinear interpolation. Samples sit on the corners of the cells, from `min` to `max` inclusive.
 */
export class MeshSDF {
  /** Samples, x fastest, then y, then z. */
  readonly data: Float32Array;
  /** Samples per axis. */
  readonly size: readonly [number, number, number];
  readonly min: Vec3;
  readonly max: Vec3;
  /** World distance between neighbouring samples, per axis. */
  readonly spacing: Vec3;

  constructor(data: Float32Array, size: readonly [number, number, number], min: Vec3, max: Vec3) {
    if (data.length !== size[0] * size[1] * size[2])
      throw new RangeError('SDF data does not match its size; pass one sample per grid point.');
    this.data = data;
    this.size = size;
    this.min = min;
    this.max = max;
    this.spacing = [0, 1, 2].map((k) => (max[k] - min[k]) / (size[k] - 1)) as unknown as Vec3;
  }

  /** Distance at a point. Outside the grid it adds the way to the grid, which never overstates how close the mesh is by more than the grid's own error. */
  distance(point: ArrayLike<number>): number {
    const { min, max, spacing, size, data } = this,
      sx = size[0],
      sxy = sx * size[1],
      base = [0, 0, 0],
      weight = [0, 0, 0];
    let outside = 0;
    for (let k = 0; k < 3; k++) {
      const clamped = Math.min(Math.max(point[k], min[k]), max[k]);
      outside += (point[k] - clamped) ** 2;
      const cell = (clamped - min[k]) / spacing[k],
        at = Math.min(Math.floor(cell), size[k] - 2);
      base[k] = at;
      weight[k] = cell - at;
    }
    const o = base[0] + base[1] * sx + base[2] * sxy,
      [wx, wy, wz] = weight,
      lerp = (a: number, b: number, t: number): number => a + (b - a) * t,
      near = lerp(lerp(data[o], data[o + 1], wx), lerp(data[o + sx], data[o + sx + 1], wx), wy),
      far = lerp(lerp(data[o + sxy], data[o + sxy + 1], wx), lerp(data[o + sxy + sx], data[o + sxy + sx + 1], wx), wy);
    return lerp(near, far, wz) + Math.sqrt(outside);
  }

  /** Direction of steepest growth at a point, away from the surface, normalized; [0, 0, 0] where the field is flat. */
  gradient(point: ArrayLike<number>, out: MutableVec3 = [0, 0, 0]): MutableVec3 {
    const p = [point[0], point[1], point[2]];
    for (let k = 0; k < 3; k++) {
      const h = this.spacing[k] / 2,
        keep = p[k];
      p[k] = keep + h;
      const high = this.distance(p);
      p[k] = keep - h;
      out[k] = high - this.distance(p);
      p[k] = keep;
    }
    const length = Math.hypot(out[0], out[1], out[2]);
    if (length > 0) for (let k = 0; k < 3; k++) out[k] /= length;
    return out;
  }

  /** The nearest point of the surface as the field sees it: one step along the gradient, which keeps particles stuck on. */
  project(point: ArrayLike<number>, out: MutableVec3 = [0, 0, 0]): MutableVec3 {
    const distance = this.distance(point);
    this.gradient(point, out);
    for (let k = 0; k < 3; k++) out[k] = point[k] - out[k] * distance;
    return out;
  }

  /** Uploads the samples as a 3D texture, for shaders. The caller owns and destroys it. */
  toTexture(device: GPUDevice, { format = 'r16float', usage = 0 }: SDFTextureOptions = {}): GPUTexture {
    if (format !== 'r16float' && format !== 'r32float')
      throw new TypeError("Invalid SDF texture format; use 'r16float' or 'r32float'.");
    const [width, height, depthOrArrayLayers] = this.size,
      limit = device.limits.maxTextureDimension3D;
    if (Math.max(width, height, depthOrArrayLayers) > limit)
      throw new RangeError(`SDF size ${this.size.join(' x ')} is over this device's ${limit}; bake a lower resolution.`);
    const texture = device.createTexture({
        label: 'bvh sdf',
        size: { width, height, depthOrArrayLayers },
        dimension: '3d',
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | usage,
      }),
      half = format === 'r16float',
      bytes = half ? halfFloats(this.data) : this.data;
    device.queue.writeTexture(
      { texture },
      bytes as BufferSource,
      { bytesPerRow: width * (half ? 2 : 4), rowsPerImage: height },
      { width, height, depthOrArrayLayers },
    );
    return texture;
  }
}

const FLOAT = new Float32Array(1),
  BITS = new Uint32Array(FLOAT.buffer);

function halfFloats(values: Float32Array): Uint16Array {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    FLOAT[0] = values[i];
    const bits = BITS[0],
      sign = (bits >>> 16) & 0x8000,
      exponent = ((bits >>> 23) & 0xff) - 112,
      mantissa = bits & 0x7fffff;
    if (exponent >= 31) out[i] = sign | 0x7bff;
    else if (exponent <= 0) {
      // Below the normal range: shift the mantissa, with its hidden bit, down into a subnormal, rounding to nearest.
      const shifted = exponent < -10 ? 0 : ((mantissa | 0x800000) >>> (13 - exponent)) + 1;
      out[i] = sign | (shifted >>> 1);
    } else {
      const rounded = ((exponent << 10) | (mantissa >>> 13)) + ((mantissa >>> 12) & 1);
      out[i] = sign | Math.min(rounded, 0x7bff);
    }
  }
  return out;
}

interface Grid {
  size: [number, number, number];
  min: MutableVec3;
  max: MutableVec3;
  step: MutableVec3;
  accuracy: number;
  signed: boolean;
}

function grid(bvh: MeshBVH, options: SDFOptions): Grid {
  const { resolution = 32, bounds, padding = 0.1, signed = true } = options,
    accuracy = windingAccuracy(options);
  if (!(padding >= 0) || !Number.isFinite(padding)) throw new RangeError('Invalid padding; pass a finite share of at least 0.');
  const box = bvh.getBoundingBox(),
    longest = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) || 1,
    min = [0, 1, 2].map((k) => (bounds ? bounds.min[k] : box.min[k] - padding * longest)) as MutableVec3,
    max = [0, 1, 2].map((k) => (bounds ? bounds.max[k] : box.max[k] + padding * longest)) as MutableVec3;
  for (let k = 0; k < 3; k++) {
    if (!Number.isFinite(min[k]) || !Number.isFinite(max[k]) || !(max[k] > min[k]))
      throw new RangeError('Invalid SDF bounds; pass a finite box with max above min on every axis.');
  }
  let size: [number, number, number];
  if (typeof resolution === 'number') {
    if (!Number.isInteger(resolution) || resolution < 2 || resolution > 2048)
      throw new RangeError('Invalid SDF resolution; pass whole numbers from 2 to 2048.');
    const cell = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / (resolution - 1);
    size = [0, 1, 2].map((k) => Math.max(Math.ceil((max[k] - min[k]) / cell - 1e-9) + 1, 2)) as [number, number, number];
  } else size = [resolution[0], resolution[1], resolution[2]];
  if (!size.every((n) => Number.isInteger(n) && n >= 2 && n <= 2048))
    throw new RangeError('Invalid SDF resolution; pass whole numbers from 2 to 2048.');
  const step = [0, 1, 2].map((k) => (max[k] - min[k]) / (size[k] - 1)) as MutableVec3;
  return { size, min, max, step, accuracy, signed };
}

function bakeRow(bvh: MeshBVH, g: Grid, data: Float32Array, row: number): void {
  const [sx, sy] = g.size,
    y = g.min[1] + (row % sy) * g.step[1],
    z = g.min[2] + Math.floor(row / sy) * g.step[2],
    p = [0, y, z];
  for (let i = 0; i < sx; i++) {
    p[0] = g.min[0] + i * g.step[0];
    const distance = bvh.closestPointToPoint(p)!.distance;
    data[row * sx + i] = g.signed && Math.abs(windingAt(bvh, p[0], y, z, g.accuracy)) > 0.5 ? -distance : distance;
  }
}

/**
 * Bakes a signed distance field on the calling thread. A closed mesh wound counter-clockwise reads negative inside.
 * Each sample costs a closest-point and a winding query, so a large grid takes seconds: {@link bakeSDFAsync} keeps the
 * page alive meanwhile.
 */
export function bakeSDF(bvh: MeshBVH, options: SDFOptions = {}): MeshSDF {
  const g = grid(bvh, options),
    data = new Float32Array(g.size[0] * g.size[1] * g.size[2]);
  for (let row = 0, rows = g.size[1] * g.size[2]; row < rows; row++) bakeRow(bvh, g, data, row);
  return new MeshSDF(data, g.size, g.min, g.max);
}

/** {@link bakeSDF} in short slices between which the page can draw, answering the same samples. */
export async function bakeSDFAsync(bvh: MeshBVH, options: SDFAsyncOptions = {}): Promise<MeshSDF> {
  const { signal, onProgress } = options,
    g = grid(bvh, options),
    data = new Float32Array(g.size[0] * g.size[1] * g.size[2]),
    rows = g.size[1] * g.size[2];
  signal?.throwIfAborted();
  let row = 0;
  while (row < rows) {
    const end = performance.now() + SLICE_MS;
    while (row < rows && performance.now() < end) bakeRow(bvh, g, data, row++);
    onProgress?.(row / rows);
    if (row < rows) await new Promise((resolve) => setTimeout(resolve));
    signal?.throwIfAborted();
  }
  return new MeshSDF(data, g.size, g.min, g.max);
}
