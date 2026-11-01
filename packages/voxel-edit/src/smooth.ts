// Smooth voxel meshing: Surface Nets over cell occupancy, optional box blur, relaxation kept inside each net cell.
import type { MutableVec3, Vec3 } from '@margoengine/math';
import { cellLimit, checkGrid, checkOptions, checkPoint, type GridLimits, sizeCells, type VoxelGrid } from './grid.js';
import type { GridMesh, MeshStats } from './mesh.js';

/** Options of {@link smoothGrid}. */
export interface SmoothGridOptions extends GridLimits {
  /** Relaxation passes moving each vertex toward its neighbours' mean, always inside its net cell, 0 to 64. Default 2. */
  iterations?: number;
  /** Box blur radius in cells over the occupancy, 0 to 8. Rounder shapes; parts thinner than `2 * blur + 1` fade. Default 0. */
  blur?: number;
  /** Point subtracted from every vertex, in cells (the model's pivot). Default [0, 0, 0]. */
  pivot?: Vec3;
  /** Most quads, 0 to 1,000,000. Default 1,000,000. */
  maxQuads?: number;
}

/** Counts of a {@link smoothGrid} call. */
export interface SmoothStats extends MeshStats {
  /** Distinct surface points. Each quad still has its own 4 mesh vertices, so `vertices` is `4 * quads`. */
  surfaceVertices: number;
}

const MAX_QUADS = 1_000_000;

/**
 * Mesh a grid into a smooth surface with Surface Nets: one point per net cell the surface passes through, one quad per
 * filled-to-air cell pair. Normals follow the density gradient and each quad takes the palette index of the nearest
 * filled voxel. The result has the {@link GridMesh} shape, so `partitionMesh` and `gridToExportSource` take it. The grid
 * is read, never changed. Cells touching only along an edge or corner share a surface point there.
 *
 * @param grid The voxels.
 * @param options Relaxation, blur, pivot and limits.
 * @returns The mesh, in cells minus the pivot, and its counts.
 * @throws RangeError when the grid or quad count passes its limit or an option is out of range.
 *
 * @example
 * ```ts
 * import { smoothGrid } from '@margoengine/voxel-edit/smooth';
 *
 * const grid = { size: [2, 2, 2] as const, voxels: new Uint8Array(8).fill(1) };
 * const { mesh, stats } = smoothGrid(grid, { iterations: 4 });
 * console.log(mesh.positions.length, stats.quads);
 * ```
 */
export function smoothGrid(grid: VoxelGrid, options: SmoothGridOptions = {}): { mesh: GridMesh; stats: SmoothStats } {
  checkOptions(options, 'smoothGrid');
  const { iterations = 2, blur = 0, pivot = [0, 0, 0], maxQuads = MAX_QUADS } = options;
  if (!Number.isInteger(iterations) || iterations < 0 || iterations > 64)
    throw new RangeError('iterations is out of range; pass an integer from 0 to 64');
  if (!Number.isInteger(blur) || blur < 0 || blur > 8)
    throw new RangeError('blur is out of range; pass an integer from 0 to 8');
  if (!Number.isInteger(maxQuads) || maxQuads < 0 || maxQuads > MAX_QUADS)
    throw new RangeError(`maxQuads is out of range; pass an integer from 0 to ${MAX_QUADS}`);
  checkPoint(pivot, 'pivot');
  const limit = cellLimit(options);
  checkGrid(grid, limit);
  const [sx, sy, sz] = grid.size,
    { voxels } = grid;
  // One layer of air all round closes the surface; a blurred value there never reaches the threshold.
  const px = sx + 2,
    py = sy + 2,
    pz = sz + 2,
    density = new Float32Array(sizeCells([px, py, pz], limit, 'Padded grid'));
  const stepZ = px,
    stepY = px * pz;
  let solid = 0;
  for (let y = 0, i = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++, i++)
        if (voxels[i]) {
          solid++;
          density[x + 1 + stepZ * (z + 1) + stepY * (y + 1)] = 1;
        }
  if (blur) boxBlur(density, [px, py, pz], blur);

  // Net cell (i, j, k) has its 8 corners at padded samples i..i + 1 and spans i - 0.5 to i + 0.5 in cells.
  const nx = sx + 1,
    ny = sy + 1,
    nz = sz + 1,
    ids = new Int32Array(nx * ny * nz).fill(-1),
    points: number[] = [],
    gradient: number[] = [],
    corner = [0, 1, stepZ, stepZ + 1, stepY, stepY + 1, stepY + stepZ, stepY + stepZ + 1],
    bit = [1, 4, 2]; // Corner bits are x = 1, z = 2, y = 4; bit[a] is that of axis a (x, y, z).
  for (let j = 0, id = 0; j < ny; j++)
    for (let k = 0; k < nz; k++)
      for (let i = 0; i < nx; i++, id++) {
        const base = i + stepZ * k + stepY * j;
        let mask = 0;
        for (let c = 0; c < 8; c++) if (density[base + corner[c]] >= 0.5) mask |= 1 << c;
        if (mask === 0 || mask === 255) continue;
        const sum = [0, 0, 0],
          grad = [0, 0, 0];
        let crossings = 0;
        for (let c = 0; c < 8; c++) {
          const value = density[base + corner[c]];
          for (let a = 0; a < 3; a++) {
            const up = c & bit[a];
            grad[a] += up ? value : -value;
            if (up || !(mask & (1 << c)) === !(mask & (1 << (c | bit[a])))) continue;
            const t = (0.5 - value) / (density[base + corner[c | bit[a]]] - value);
            crossings++;
            for (let b = 0; b < 3; b++) sum[b] += (c & bit[b] ? 1 : 0) + (b === a ? t : 0);
          }
        }
        ids[id] = points.length / 3;
        points.push(i - 0.5 + sum[0] / crossings, j - 0.5 + sum[1] / crossings, k - 0.5 + sum[2] / crossings);
        gradient.push(0 - grad[0], 0 - grad[1], 0 - grad[2]);
      }
  const count = points.length / 3;

  // One quad per sample pair across the threshold, wound counterclockwise seen from the air side.
  const quads: number[] = [],
    palette: number[] = [],
    netId = (i: number, j: number, k: number) => ids[i + nx * (k + nz * j)],
    steps = [1, stepY, stepZ];
  const owner = (x: number, y: number, z: number): number => {
    if (x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz && voxels[x + sx * (z + sz * y)])
      return voxels[x + sx * (z + sz * y)];
    let best = 0,
      nearest = Infinity;
    for (let b = Math.max(0, y - blur); b <= Math.min(sy - 1, y + blur); b++)
      for (let c = Math.max(0, z - blur); c <= Math.min(sz - 1, z + blur); c++)
        for (let a = Math.max(0, x - blur); a <= Math.min(sx - 1, x + blur); a++) {
          const value = voxels[a + sx * (c + sz * b)],
            distance = (a - x) ** 2 + (b - y) ** 2 + (c - z) ** 2;
          if (value && distance < nearest) {
            nearest = distance;
            best = value;
          }
        }
    return best;
  };
  for (let y = 0; y < py; y++)
    for (let z = 0; z < pz; z++)
      for (let x = 0; x < px; x++) {
        const here = x + stepZ * z + stepY * y,
          inside = density[here] >= 0.5;
        for (let a = 0; a < 3; a++) {
          const at = [x, y, z];
          if (at[a] + 1 >= [px, py, pz][a] || inside === density[here + steps[a]] >= 0.5) continue;
          if (quads.length / 4 >= maxQuads)
            throw new RangeError(`The mesh passes maxQuads (${maxQuads}); raise maxQuads or pass a smaller grid`);
          const u = (a + 1) % 3,
            v = (a + 2) % 3,
            cell = (du: number, dv: number) => {
              const c = [x, y, z];
              c[u] += du - 1;
              c[v] += dv - 1;
              return netId(c[0], c[1], c[2]);
            };
          const ring = [cell(0, 0), cell(1, 0), cell(1, 1), cell(0, 1)];
          if (!inside) ring.reverse();
          quads.push(...ring);
          const from = inside ? at : [x, y, z].map((n, b) => (b === a ? n + 1 : n));
          palette.push(owner(from[0] - 1, from[1] - 1, from[2] - 1));
        }
      }
  const quadCount = palette.length;

  let now = Float64Array.from(points);
  if (iterations) {
    const near = new Float64Array(count * 3),
      links = new Uint32Array(count);
    for (let pass = 0; pass < iterations; pass++) {
      near.fill(0);
      links.fill(0);
      for (let q = 0; q < quadCount; q++)
        for (let c = 0; c < 4; c++) {
          const from = quads[4 * q + c],
            to = quads[4 * q + ((c + 1) % 4)];
          for (let a = 0; a < 3; a++) {
            near[3 * from + a] += now[3 * to + a];
            near[3 * to + a] += now[3 * from + a];
          }
          links[from]++;
          links[to]++;
        }
      const next = new Float64Array(count * 3);
      for (let p = 0; p < count; p++)
        for (let a = 0; a < 3; a++) {
          // Rounding the starting point recovers the net cell: every start lies strictly inside its cell.
          const centre = Math.round(points[3 * p + a]);
          next[3 * p + a] = Math.min(centre + 0.5, Math.max(centre - 0.5, near[3 * p + a] / links[p]));
        }
      now = next;
    }
  }

  // Opposite filled corners cancel in the gradient; those points take their quads' facing instead.
  const facing = new Float64Array(count * 3);
  for (let q = 0; q < quadCount; q++) {
    const [a, b, c, d] = [0, 1, 2, 3].map((n) => 3 * quads[4 * q + n]),
      ux = now[c] - now[a],
      uy = now[c + 1] - now[a + 1],
      uz = now[c + 2] - now[a + 2],
      vx = now[d] - now[b],
      vy = now[d + 1] - now[b + 1],
      vz = now[d + 2] - now[b + 2],
      nx2 = uy * vz - uz * vy,
      ny2 = uz * vx - ux * vz,
      nz2 = ux * vy - uy * vx;
    for (const p of [a, b, c, d]) {
      facing[p] += nx2;
      facing[p + 1] += ny2;
      facing[p + 2] += nz2;
    }
  }

  const positions = new Float32Array(quadCount * 12),
    normals = new Float32Array(quadCount * 12),
    indices = new Uint32Array(quadCount * 6);
  const min: MutableVec3 = [Infinity, Infinity, Infinity],
    max: MutableVec3 = [-Infinity, -Infinity, -Infinity];
  for (let q = 0; q < quadCount; q++) {
    indices.set([4 * q, 4 * q + 1, 4 * q + 2, 4 * q, 4 * q + 2, 4 * q + 3], 6 * q);
    for (let c = 0; c < 4; c++) {
      const p = 3 * quads[4 * q + c],
        o = 3 * (4 * q + c),
        n = Math.hypot(gradient[p], gradient[p + 1], gradient[p + 2]) ? gradient : facing,
        length = Math.hypot(n[p], n[p + 1], n[p + 2]) || 1;
      for (let a = 0; a < 3; a++) {
        const value = now[p + a] - pivot[a];
        positions[o + a] = value;
        normals[o + a] = n[p + a] / length;
        if (positions[o + a] < min[a]) min[a] = positions[o + a];
        if (positions[o + a] > max[a]) max[a] = positions[o + a];
      }
    }
  }
  if (!quadCount) for (let a = 0; a < 3; a++) min[a] = max[a] = 0;
  return {
    mesh: {
      positions,
      normals,
      ao: new Float32Array(0),
      indices,
      paletteIndexes: Uint8Array.from(palette),
      min,
      max,
    },
    stats: {
      voxels: solid,
      quads: quadCount,
      triangles: quadCount * 2,
      vertices: quadCount * 4,
      surfaceVertices: count,
    },
  };
}

/** Separable box blur of radius `radius` with air outside, by running sums along each axis in turn. */
function boxBlur(density: Float32Array, size: readonly number[], radius: number): void {
  const [px, py, pz] = size,
    width = 2 * radius + 1,
    stride = [1, px * pz, px],
    temp = new Float32Array(Math.max(px, py, pz));
  for (let a = 0; a < 3; a++) {
    const length = size[a === 2 ? 2 : a],
      step = stride[a],
      u = (a + 1) % 3,
      v = (a + 2) % 3,
      su = size[u],
      sv = size[v];
    for (let i = 0; i < su; i++)
      for (let j = 0; j < sv; j++) {
        const start = i * stride[u] + j * stride[v];
        let sum = 0;
        for (let n = 0; n <= Math.min(radius, length - 1); n++) sum += density[start + n * step];
        for (let n = 0; n < length; n++) {
          temp[n] = sum / width;
          if (n + radius + 1 < length) sum += density[start + (n + radius + 1) * step];
          if (n - radius >= 0) sum -= density[start + (n - radius) * step];
        }
        for (let n = 0; n < length; n++) density[start + n * step] = temp[n];
      }
  }
}
