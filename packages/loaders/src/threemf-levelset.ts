// Meshes a 3MF level set (volumetric extension chapter 4): the part of the domain mesh, or of its box, where the
// function is below zero, polygonized by `@margoengine/procedural`'s Marching Cubes on max(function, domain distance).
// The grid's points are multiples of a power of two, so blocks of it meshed one after another meet in the same
// vertices.
import { compileField, type FieldScope } from './threemf-functions.js';
import type { ThreeMFSampledField } from './threemf-volumetric.js';
import type { ThreeMFMesh } from './threemf.js';
import { LoaderError } from './types.js';
import { floats, throwIfAborted, uints } from './util.js';

const F = '3MF';
/** Cells along the side of a block: the most points `marchingCubes` takes on one axis is 128. */
const BLOCK = 32;
/** The most cells along the longest side. */
export const MAX_CELLS = 512;
const NONE = 0xffffffff;

export interface LevelSetOptions {
  /** Cells wanted along the longest side of the domain. */
  resolution: number;
  maxTriangles: number;
  signal?: AbortSignal;
}

type Distance = (x: number, y: number, z: number) => number;

/** The signed distance to an axis-aligned box, negative inside. */
const boxDistance =
  (low: readonly number[], high: readonly number[]): Distance =>
  (x, y, z) => {
    const a = Math.max(low[0] - x, x - high[0]),
      b = Math.max(low[1] - y, y - high[1]),
      c = Math.max(low[2] - z, z - high[2]),
      inner = Math.max(a, b, c);
    return inner <= 0 ? inner : Math.hypot(Math.max(a, 0), Math.max(b, 0), Math.max(c, 0));
  };

/**
 * The triangles of a level set in its object's coordinates, and whether its grid is too coarse for the
 * `minfeaturesize` the file asks for (two cells to a feature).
 */
export async function meshLevelSet(
  scope: FieldScope,
  levelSet: ThreeMFSampledField & { meshId: string; boundingBoxOnly: boolean },
  domain: ArrayLike<number>,
  { resolution, maxTriangles, signal }: LevelSetOptions,
): Promise<{ mesh: ThreeMFMesh; cell: number; coarse: boolean }> {
  const { marchingCubes } = await import('@margoengine/procedural/marching-cubes');
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < domain.length; i++) {
    low[i % 3] = Math.min(low[i % 3], domain[i]);
    high[i % 3] = Math.max(high[i % 3], domain[i]);
  }
  const longest = Math.max(...high.map((v, k) => v - low[k]));
  if (!(longest > 0)) throw new LoaderError(F, 'syntax', `the domain mesh ${levelSet.meshId.slice(0, 32)} is empty`);
  const { minFeatureSize, fallback, transform } = levelSet,
    wanted = Math.max(
      longest / MAX_CELLS,
      Math.min(longest / resolution, minFeatureSize > 0 ? minFeatureSize / 2 : Infinity),
    ),
    cell = 2 ** Math.floor(Math.log2(wanted));
  const inside: Distance = levelSet.boundingBoxOnly ? boxDistance(low, high) : scope.distance(levelSet.meshId, true);
  const pos = new Float64Array(3),
    program = compileField(scope, levelSet.functionId, new Map([['pos', pos]])),
    output = program.outputs.get(levelSet.channel) as Float64Array;
  const m = transform ?? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const first = low.map((v) => Math.floor(v / cell) - 1),
    last = high.map((v) => Math.ceil(v / cell) + 1);
  // The domain distance at the centres of cubes of 8 cells: a distance changes no faster than its point moves, so a
  // cube whose centre is farther from the domain's surface than its corners lies wholly inside or outside it.
  const coarseCell = 8 * cell,
    corner = (Math.sqrt(3) / 2) * coarseCell,
    centres = new Map<string, number>();
  const bound = (x: number, y: number, z: number): number => {
    const i = Math.floor(x / coarseCell),
      j = Math.floor(y / coarseCell),
      k = Math.floor(z / coarseCell),
      key = `${i} ${j} ${k}`;
    let centre = centres.get(key);
    if (centre === undefined)
      centres.set(key, (centre = inside((i + 0.5) * coarseCell, (j + 0.5) * coarseCell, (k + 0.5) * coarseCell)));
    return centre < -corner ? -Infinity : centre > corner ? centre - corner : inside(x, y, z);
  };
  // max(function, domain distance) in sign; the domain is asked only where the function is not already outside.
  const field = (x: number, y: number, z: number): number => {
    for (let k = 0; k < 3; k++) pos[k] = x * m[k] + y * m[3 + k] + z * m[6 + k] + m[9 + k];
    program.run();
    const value = Number.isFinite(output[0]) ? output[0] : fallback;
    return value > 0 ? value : Math.max(value, bound(x, y, z));
  };
  const vertices = floats(),
    triangles = uints(),
    welded = new Map<string, number>();
  for (let z = first[2]; z < last[2]; z += BLOCK)
    for (let y = first[1]; y < last[1]; y += BLOCK)
      for (let x = first[0]; x < last[0]; x += BLOCK) {
        throwIfAborted(signal, F);
        const from = [x, y, z],
          cells = from.map((v, k) => Math.max(2, Math.min(BLOCK, last[k] - v))),
          centre = from.map((v, k) => (v + cells[k] / 2) * cell),
          reach = (Math.hypot(...cells) / 2) * cell;
        // A distance changes no faster than its point moves: a block this far outside the domain holds no surface.
        if (inside(centre[0], centre[1], centre[2]) > reach) continue;
        const surface = marchingCubes(field, {
          resolution: [cells[0] + 1, cells[1] + 1, cells[2] + 1],
          bounds: [
            [from[0] * cell, from[1] * cell, from[2] * cell],
            [(from[0] + cells[0]) * cell, (from[1] + cells[1]) * cell, (from[2] + cells[2]) * cell],
          ],
        });
        if (!surface) continue;
        const points = surface.vertices,
          stride = 6,
          ids: number[] = [];
        for (let i = 0; i < points.length; i += stride) {
          const key = `${points[i]},${points[i + 1]},${points[i + 2]}`;
          let id = welded.get(key);
          if (id === undefined) {
            id = vertices.length / 3;
            welded.set(key, id);
            vertices.push3(points[i], points[i + 1], points[i + 2]);
          }
          ids.push(id);
        }
        const index = surface.indices;
        for (let t = 0; t < index.length; t += 3) {
          const a = ids[index[t]],
            b = ids[index[t + 1]],
            c = ids[index[t + 2]];
          if (a === b || b === c || c === a) continue;
          if (triangles.length / 3 >= maxTriangles)
            throw new LoaderError(
              F,
              'limit',
              `a level set exceeds ${maxTriangles} triangles; lower levelSetResolution or raise maxTriangles`,
            );
          triangles.push3(a, b, c);
        }
      }
  const count = triangles.length / 3,
    pid = uints(),
    p = uints();
  for (let t = 0; t < count; t++) {
    pid.push(NONE);
    p.push3(NONE, NONE, NONE);
  }
  return {
    mesh: { vertices, triangles, pid, p },
    cell,
    coarse: minFeatureSize > 0 && cell > minFeatureSize / 2,
  };
}
