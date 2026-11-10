// Automatic LOD rings for Scatter (`@margoengine/scatter/simplify`): one mesh in, the three ring meshes `Scatter` takes
// out. Ring 0 is the source itself; rings 1 and 2 are quadric-error edge collapses of it (Garland and Heckbert 1997),
// the second simplified from the first so the rings nest. The simplifying is `@margoengine/lod`'s attribute-keeping
// chain over `@margoengine/mesh-edit`, loaded on first use: every ring vertex is a source vertex with its own normal,
// so hard edges and blade shading stay as authored.
import { Geometry } from '@margoengine/core';
import { simplifyAttributes } from '@margoengine/lod/auto';
import { rangeError, typeError } from '../../shared/errors.js';

/** Options of {@link scatterLODs}. */
export interface ScatterLODOptions {
  /**
   * Fractions of the source's triangles rings 1 and 2 keep, decreasing within (0, 1]. Default `[0.4, 0.12]`. A ring
   * keeps more when nothing more can collapse without tearing a seam, as a closed card or a two-triangle quad does.
   */
  ratios?: readonly [ring1: number, ring2: number];
  /** Cancels the wait for the simplifier and the work after it. */
  signal?: AbortSignal;
}
/** What {@link scatterLODs} built. */
export interface ScatterLODs {
  /** Rings 0, 1 and 2, ready for `new Scatter(meshes, options)`. Ring 0 is the source object itself. */
  meshes: [Geometry, Geometry, Geometry];
  /** Triangles of each ring. */
  triangles: [number, number, number];
  /**
   * Largest distance, in the mesh's own units, from a source vertex to the surface of rings 1 and 2 (ring 0 is 0): a
   * one-sided Hausdorff bound over the source vertices, so a ring LOD distance can be chosen by on-screen error.
   */
  deviation: [number, number, number];
}

const SOURCE = 'scatterLODs takes a core Geometry with triangles; pass the near mesh you would give Scatter';
const STRIDE = 20;

/**
 * Builds the three LOD rings `Scatter` draws from one mesh. Loads `@margoengine/lod/auto` and `@margoengine/mesh-edit`
 * on first use (both optional peers: install them with scatter to use this entry).
 * @throws TypeError when `source` is not a core Geometry with triangles; RangeError when `ratios` are not two numbers
 * decreasing within (0, 1] or the source passes 200,000 vertices; the `signal`'s reason when it aborts.
 */
export async function scatterLODs(source: Geometry, options: ScatterLODOptions = {}): Promise<ScatterLODs> {
  if (
    !source ||
    !(source.vertices instanceof Float32Array) ||
    !(source.indices instanceof Uint32Array) ||
    !source.indices.length ||
    source.vertices.length % 6
  )
    throw typeError(SOURCE, 'scatter');
  if (!options || typeof options !== 'object')
    throw typeError('scatterLODs options must be an object; omit it for the defaults', 'scatter');
  const ratios = options.ratios ?? [0.4, 0.12];
  if (
    !Array.isArray(ratios) ||
    ratios.length !== 2 ||
    !(ratios[0] > 0 && ratios[0] <= 1 && ratios[1] > 0 && ratios[1] < ratios[0])
  )
    throw rangeError(
      'scatterLODs ratios are two triangle fractions decreasing within (0, 1], such as [0.4, 0.12]',
      'scatter',
    );
  const count = source.vertices.length / 6;
  if (count > 200_000)
    throw rangeError('scatterLODs takes up to 200000 vertices; split the mesh or decimate it offline first', 'scatter');
  const packed = new Float32Array(count * STRIDE);
  for (let i = 0; i < count; i++) packed.set(source.vertices.subarray(i * 6, i * 6 + 6), i * STRIDE);
  const levels = await simplifyAttributes({ vertices: packed, indices: source.indices }, ratios, {
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  const meshes: Geometry[] = [source],
    deviation = [0];
  for (const { vertices, indices } of levels) {
    const n = vertices.length / STRIDE,
      positions = new Float32Array(n * 3),
      normals = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions.set(vertices.subarray(i * STRIDE, i * STRIDE + 3), i * 3);
      normals.set(vertices.subarray(i * STRIDE + 3, i * STRIDE + 6), i * 3);
    }
    meshes.push(new Geometry(positions, normals, indices));
    deviation.push(farthest(source.vertices, positions, indices));
  }
  return {
    meshes: meshes as ScatterLODs['meshes'],
    triangles: meshes.map((m) => m.indices.length / 3) as ScatterLODs['triangles'],
    deviation: deviation as ScatterLODs['deviation'],
  };
}

/**
 * The largest distance from any source vertex (stride 6) to the nearest triangle of a ring, by the closest-point test
 * of Ericson, Real-Time Collision Detection (2005), section 5.1.5. Every pair is tested: scatter meshes are small.
 */
export function farthest(source: Float32Array, positions: Float32Array, indices: Uint32Array): number {
  let worst = 0;
  for (let v = 0; v < source.length; v += 6) {
    const px = source[v],
      py = source[v + 1],
      pz = source[v + 2];
    let best = Infinity;
    for (let t = 0; t < indices.length && best > worst; t += 3) {
      const d = pointTriangle(px, py, pz, positions, indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3);
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return Math.sqrt(worst);
}

/** Squared distance from p to triangle abc (offsets into `q`), Ericson 2005, 5.1.5, by Voronoi regions. */
function pointTriangle(px: number, py: number, pz: number, q: Float32Array, a: number, b: number, c: number): number {
  const ax = q[a],
    ay = q[a + 1],
    az = q[a + 2];
  const abx = q[b] - ax,
    aby = q[b + 1] - ay,
    abz = q[b + 2] - az;
  const acx = q[c] - ax,
    acy = q[c + 1] - ay,
    acz = q[c + 2] - az;
  const apx = px - ax,
    apy = py - ay,
    apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz,
    d2 = acx * apx + acy * apy + acz * apz;
  const at = (s: number, t: number) => {
    const x = apx - s * abx - t * acx,
      y = apy - s * aby - t * acy,
      z = apz - s * abz - t * acz;
    return x * x + y * y + z * z;
  };
  if (d1 <= 0 && d2 <= 0) return at(0, 0);
  const bpx = px - q[b],
    bpy = py - q[b + 1],
    bpz = pz - q[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz,
    d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return at(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const cpx = px - q[c],
    cpy = py - q[c + 1],
    cpz = pz - q[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz,
    d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return at(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at(1 - w, w);
  }
  const sum = va + vb + vc;
  if (!(sum > 0)) return at(0, 0);
  return at(vb / sum, vc / sum);
}

/**
 * The distance at which a ring's `deviation` (mesh units, times the largest instance scale) covers `pixels` on a
 * screen `height` pixels tall seen through a vertical field of view `fov` (radians): past it, the ring's error is
 * smaller than that. Use it for `ScatterOptions.lod` entries 0 and 1 (each ring starts where the one before ends).
 * @throws RangeError for a non-finite or negative deviation, or a non-positive pixels, height or fov below pi.
 */
export function ringDistance(deviation: number, pixels = 1, height = 1080, fov = Math.PI / 3): number {
  if (!(deviation >= 0 && Number.isFinite(deviation) && pixels > 0 && height > 0 && fov > 0 && fov < Math.PI))
    throw rangeError(
      'ringDistance takes a deviation of 0 or more, pixels and height above 0 and fov in (0, pi) radians',
      'scatter',
    );
  return (deviation * height) / (2 * Math.tan(fov / 2) * pixels);
}
