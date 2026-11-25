// Reading a GPU `Scatter`'s instances back to the CPU (`@margoengine/scatter/read`): the last frame's cull output, one
// list per LOD ring, turned into rigid world transforms by the same placement the vertex stage applies (pose.ts
// `scatterPose`: yaw about +Y, then the rotation taking +Y to the instance's up, Rodrigues about Y x up, times scale,
// plus position). For a path tracer (`@margoengine/voxel-pathtracer/from-engine` takes the result as a `scatter`
// source), picking or export.
import type { EngineKernel, Geometry } from '@margoengine/core';
import type { Scatter } from './index.js';
import { margoError } from '../../shared/errors.js';

declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

/** One LOD ring's instances. */
export interface ScatterReadRing {
  /** The ring's mesh (positions and normals in `vertices`, as core `Geometry` holds them). */
  readonly geometry: Geometry;
  /** Column-major 4 x 4 world transforms, 16 floats per instance. */
  readonly transforms: Float32Array;
}
/** What {@link readScatter} returns: the rings, near to far, and the scatter's surface. */
export interface ScatterReadout {
  readonly rings: readonly ScatterReadRing[];
  /** Linear albedo the scatter draws with (its `material`'s colour when it has one, else `color`). */
  readonly color: readonly [number, number, number];
  /** Perceptual roughness and metalness (of `material`; 1 and 0 without one). */
  readonly roughness: number;
  readonly metalness: number;
}
/** Settings of {@link readScatter}. */
export interface ScatterReadOptions {
  /** Stops the wait for the GPU read; the promise then rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

/**
 * Reads the instances a `Scatter` culled in its last frame: those the camera saw within the last LOD distance, after
 * height, slope, density, exclusion and path rules, before any occlusion pass. An instance cross-fading between two
 * rings is kept once, in the nearer ring. Transforms are rigid: the wind's bend and the blades' distance widening are
 * per-vertex and left out. Render a frame first.
 *
 * ```ts
 * engine.render();
 * const { rings } = await readScatter(engine, scatter, { signal: AbortSignal.timeout(10_000) });
 * console.log(rings.map((r) => r.transforms.length / 16));
 * ```
 * @throws MargoError `'state'` when the scatter has not drawn a frame on this engine's WebGPU device, or is disposed.
 */
export async function readScatter(
  engine: EngineKernel,
  scatter: Scatter,
  { signal }: ScatterReadOptions = {},
): Promise<ScatterReadout> {
  signal?.throwIfAborted();
  const device = (engine as { gpu?: GPUDevice })?.gpu,
    parts = typeof scatter?.velocityParts === 'function' ? scatter.velocityParts() : undefined;
  if (!device || !parts)
    throw margoError(
      'state',
      'readScatter needs a Scatter attached to this WebGPU engine that has drawn a frame; attach it and call engine.render() first',
    );
  const { instances, commands } = parts.cull,
    sizes = instances.map((b) => b.size),
    total = 64 + sizes.reduce((a, b) => a + b, 0),
    buffer = device.createBuffer({ size: total, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(commands, 0, buffer, 0, 60);
    let at = 64;
    instances.forEach((b, i) => {
      encoder.copyBufferToBuffer(b, 0, buffer, at, sizes[i]);
      at += sizes[i];
    });
    device.queue.submit([encoder.finish()]);
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal!.reason);
      signal?.addEventListener('abort', abort, { once: true });
      buffer.mapAsync(GPUMapMode.READ).then(
        () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        },
        (error: unknown) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
    const words = new Uint32Array(buffer.getMappedRange().slice(0)),
      floats = new Float32Array(words.buffer);
    buffer.unmap();
    const align = parts.values[72];
    let base = 16;
    const rings = instances.map((_, ring) => {
      const count = Math.min(words[ring * 5 + 1], sizes[ring] / 32),
        out = new Float32Array(count * 16);
      let n = 0;
      for (let k = 0; k < count; k++) {
        const f = base + k * 8;
        // Fade mode 2 is the far copy of an instance drawn in two rings; its near copy (mode 1) stands for it.
        if (floats[f + 7] === 2) continue;
        instanceMatrix(floats, f, align, out, n++ * 16);
      }
      base += sizes[ring] / 4;
      return { geometry: parts.geometries[ring], transforms: n === count ? out : out.slice(0, n * 16) };
    });
    const material = scatter.options.material?.data,
      v = parts.values;
    return {
      rings,
      color: material ? [material[0], material[1], material[2]] : [v[40], v[41], v[42]],
      roughness: material ? material[4] : 1,
      metalness: material ? material[5] : 0,
    };
  } finally {
    buffer.destroy();
  }
}

/**
 * Writes the world transform of the instance at `floats[f..f + 8)` (position xyz, scale, yaw, packed ground normal,
 * fade, fade mode) into `out` at `o`, with `align` the scatter's `alignToGround`.
 */
export function instanceMatrix(floats: ArrayLike<number>, f: number, align: number, out: Float32Array, o = 0): void {
  const scale = floats[f + 3],
    c = Math.cos(floats[f + 4]),
    s = Math.sin(floats[f + 4]),
    packed = floats[f + 5],
    gz = Math.floor(packed / 4096),
    gx = (packed - gz * 4096) / 2047.5 - 1,
    gzz = gz / 2047.5 - 1,
    gy = Math.sqrt(Math.max(0, 1 - gx * gx - gzz * gzz)),
    ux = gx * align,
    uy = 1 + (gy - 1) * align,
    uz = gzz * align,
    ul = Math.hypot(ux, uy, uz),
    x = ux / ul,
    y = uy / ul,
    z = uz / ul;
  // Columns: scatterTurn of the yawed basis vectors, k = (up.z, 0, -up.x).
  for (let a = 0; a < 3; a++) {
    const rx = a === 0 ? c : a === 2 ? s : 0,
      ry = a === 1 ? 1 : 0,
      rz = a === 0 ? -s : a === 2 ? c : 0,
      kx = z,
      kz = -x,
      kr = kx * rx + kz * rz,
      // cross(k, r) with k.y = 0.
      cx = -kz * ry,
      cy = kz * rx - kx * rz,
      cz = kx * ry;
    out[o + a * 4] = (rx * y + cx + (kx * kr) / (1 + y)) * scale;
    out[o + a * 4 + 1] = (ry * y + cy) * scale;
    out[o + a * 4 + 2] = (rz * y + cz + (kz * kr) / (1 + y)) * scale;
    out[o + a * 4 + 3] = 0;
  }
  out[o + 12] = floats[f];
  out[o + 13] = floats[f + 1];
  out[o + 14] = floats[f + 2];
  out[o + 15] = 1;
}
