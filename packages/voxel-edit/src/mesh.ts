// Export meshing: greedy quads per palette index with optional corner ambient occlusion and smoothed normals.
import type { MutableVec3, Vec3 } from '@margoengine/math';
import { checkGrid, checkPoint, type VoxelGrid } from './grid.js';
import { SparseGrid } from './sparse.js';

/** Options of {@link meshGrid}. */
export interface GridMeshOptions {
  /** Point subtracted from every vertex, in cells (the model's pivot). Default [0, 0, 0]. */
  pivot?: Vec3;
  /** Bake corner ambient occlusion into {@link GridMesh.ao}; quads only merge across equal shading. Default false. */
  ambientOcclusion?: boolean;
  /** Average normals across edges between quads meeting within `creaseAngle`. Default false (flat faces). */
  smoothNormals?: boolean;
  /** Largest angle in degrees, 0 to 180, smoothed across. Default 180. */
  creaseAngle?: number;
  /** Most quads, 0 to 1,000,000. Default 1,000,000. */
  maxQuads?: number;
  /** Most cells scanned, 1 to 134,217,728 (a sparse grid scans its chunks). Default 134,217,728. */
  maxCells?: number;
}

/** A voxel mesh: 4 vertices and 2 triangles per quad, quads in order, wound counterclockwise seen from outside. */
export interface GridMesh {
  /** xyz per vertex, in cells, minus the pivot. */
  positions: Float32Array;
  /** Unit xyz per vertex. */
  normals: Float32Array;
  /** Per-vertex ambient light, 0.4 (corner closed in) to 1 (open), with `ambientOcclusion`; empty otherwise. */
  ao: Float32Array;
  /** Triangle vertex indexes. */
  indices: Uint32Array;
  /** Palette index of each quad (its 4 vertices). */
  paletteIndexes: Uint8Array;
  /** Bounds of `positions`; [0, 0, 0] for both when the mesh is empty. */
  min: MutableVec3;
  max: MutableVec3;
}

/** Counts of a {@link meshGrid} call. */
export interface MeshStats {
  /** Filled cells scanned. */
  voxels: number;
  quads: number;
  triangles: number;
  vertices: number;
}

type Sample = (x: number, y: number, z: number) => number;
interface Parts {
  positions: number[];
  normals: number[];
  ao: number[];
  indices: number[];
  palette: number[];
}

const MAX_QUADS = 1_000_000,
  MAX_SCAN = 134_217_728;

/**
 * Meshes the faces between filled cells and air, merging same-index faces into rectangles (greedy meshing). Faces
 * between two filled cells are never emitted, so a sparse grid's chunk seams leave no inner walls. The grid is read,
 * never changed.
 */
export function meshGrid(
  source: VoxelGrid | SparseGrid,
  options: GridMeshOptions = {},
): { mesh: GridMesh; stats: MeshStats } {
  if (typeof options !== 'object' || options === null)
    throw new TypeError('meshGrid options are not an object; pass them');
  const pivot = options.pivot ?? [0, 0, 0],
    maxQuads = options.maxQuads ?? MAX_QUADS,
    maxCells = options.maxCells ?? MAX_SCAN,
    crease = options.creaseAngle ?? 180;
  checkPoint(pivot, 'meshGrid pivot');
  if (!Number.isInteger(maxQuads) || maxQuads < 0 || maxQuads > MAX_QUADS)
    throw new RangeError(`meshGrid maxQuads must be an integer from 0 to ${MAX_QUADS}; pass one`);
  if (!Number.isInteger(maxCells) || maxCells < 1 || maxCells > MAX_SCAN)
    throw new RangeError(`meshGrid maxCells must be an integer from 1 to ${MAX_SCAN}; pass one`);
  if (!Number.isFinite(crease) || crease < 0 || crease > 180)
    throw new RangeError('meshGrid creaseAngle must be 0 to 180 degrees; pass one');
  for (const key of ['ambientOcclusion', 'smoothNormals'] as const)
    if (options[key] !== undefined && typeof options[key] !== 'boolean')
      throw new TypeError(`meshGrid ${key} is not a boolean; pass true or false`);
  const sparse = source instanceof SparseGrid;
  if (!sparse) checkGrid(source, MAX_SCAN);
  const [sx, sy, sz] = source.size,
    sample: Sample = sparse
      ? (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : source.get(x, y, z))
      : (x, y, z) =>
          x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : source.voxels[x + sx * (z + sz * y)],
    regions: Iterable<{ origin: Vec3; size: Vec3; voxels: Uint8Array }> = sparse
      ? source.windows()
      : [{ origin: [0, 0, 0], size: source.size, voxels: source.voxels }],
    parts: Parts = { positions: [], normals: [], ao: [], indices: [], palette: [] },
    stats: MeshStats = { voxels: 0, quads: 0, triangles: 0, vertices: 0 };
  let scanned = 0;
  for (const region of regions) {
    scanned += region.voxels.length;
    if (scanned > maxCells) throw new RangeError('meshGrid scans more than maxCells; mesh less or raise maxCells');
    greedy(
      sample,
      pivot,
      region.origin,
      region.size,
      region.voxels,
      options.ambientOcclusion ?? false,
      maxQuads,
      parts,
      stats,
    );
  }
  if (options.smoothNormals && parts.indices.length) smooth(parts, crease);
  const positions = Float32Array.from(parts.positions),
    min: MutableVec3 = [0, 0, 0],
    max: MutableVec3 = [0, 0, 0];
  if (positions.length) {
    min.fill(Infinity);
    max.fill(-Infinity);
    for (let i = 0; i < positions.length; i++) {
      const axis = i % 3;
      if (positions[i] < min[axis]) min[axis] = positions[i];
      if (positions[i] > max[axis]) max[axis] = positions[i];
    }
  }
  return {
    mesh: {
      positions,
      normals: Float32Array.from(parts.normals),
      ao: Float32Array.from(parts.ao),
      indices: Uint32Array.from(parts.indices),
      paletteIndexes: Uint8Array.from(parts.palette),
      min,
      max,
    },
    stats,
  };
}

/** Corner orders of a quad, counterclockwise for a face toward +axis and toward -axis. */
const FRONT = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ],
  BACK = [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0],
  ];

/** Meshes one region (the whole grid, or one sparse chunk): only faces on its own cells, neighbours read through `sample`. */
function greedy(
  sample: Sample,
  pivot: Vec3,
  offset: Vec3,
  size: Vec3,
  owned: Uint8Array,
  ambientOcclusion: boolean,
  maxQuads: number,
  out: Parts,
  stats: MeshStats,
): void {
  for (const value of owned) if (value) stats.voxels++;
  const at = (p: number[]) => sample(p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]),
    solid = (p: number[]) => (at(p) ? 1 : 0),
    p = [0, 0, 0],
    q = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3,
      v = (axis + 2) % 3,
      width = size[u],
      height = size[v],
      // Face mask of one plane: +index for a face toward +axis, -index toward -axis, 0 for none.
      mask = new Int16Array(width * height),
      shade = ambientOcclusion ? new Uint8Array(width * height) : undefined;
    for (let plane = 0; plane <= size[axis]; plane++) {
      for (let j = 0; j < height; j++)
        for (let i = 0; i < width; i++) {
          p[u] = i;
          p[v] = j;
          p[axis] = plane - 1;
          const below = at(p);
          p[axis] = plane;
          const above = at(p),
            face = below && !above && plane > 0 ? below : above && !below && plane < size[axis] ? -above : 0;
          mask[i + j * width] = face;
          if (!shade || !face) continue;
          // Two bits per corner: 3 open to 0 closed (both sides filled count as closed, as the corner is hidden).
          let packed = 0;
          for (let corner = 0; corner < 4; corner++) {
            const [a, b] = FRONT[corner];
            q[axis] = face > 0 ? plane : plane - 1;
            q[u] = i + (a ? 1 : -1);
            q[v] = j;
            const side1 = solid(q);
            q[u] = i;
            q[v] = j + (b ? 1 : -1);
            const side2 = solid(q);
            q[u] = i + (a ? 1 : -1);
            const level = side1 && side2 ? 0 : 3 - side1 - side2 - solid(q);
            packed |= level << (corner * 2);
          }
          shade[i + j * width] = packed;
        }
      for (let j = 0; j < height; j++)
        for (let i = 0; i < width; ) {
          const face = mask[i + j * width];
          if (!face) {
            i++;
            continue;
          }
          // A quad with unequal corner shading would interpolate across its merged area, so it stays one cell.
          const corners = shade?.[i + j * width] ?? 255,
            flat = corners === 0 || corners === 85 || corners === 170 || corners === 255,
            same = (k: number) => mask[k] === face && (!shade || shade[k] === corners);
          let w = 1,
            h = 1;
          while (flat && i + w < width && same(i + w + j * width)) w++;
          grow: while (flat && j + h < height) {
            for (let k = 0; k < w; k++) if (!same(i + k + (j + h) * width)) break grow;
            h++;
          }
          if (++stats.quads > maxQuads)
            throw new RangeError('meshGrid exceeds maxQuads; mesh a smaller grid or raise maxQuads');
          const base = out.positions.length / 3;
          for (const [a, b] of face > 0 ? FRONT : BACK) {
            const corner = [0, 0, 0];
            corner[axis] = plane;
            corner[u] = i + a * w;
            corner[v] = j + b * h;
            for (let d = 0; d < 3; d++) out.positions.push(Math.fround(offset[d] + corner[d] - pivot[d]));
            out.normals.push(
              axis === 0 ? Math.sign(face) : 0,
              axis === 1 ? Math.sign(face) : 0,
              axis === 2 ? Math.sign(face) : 0,
            );
            if (shade) out.ao.push(0.4 + ((corners >>> ((a ? (b ? 2 : 1) : b ? 3 : 0) * 2)) & 3) * 0.2);
          }
          out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
          out.palette.push(Math.abs(face));
          stats.triangles += 2;
          stats.vertices += 4;
          for (let y = 0; y < h; y++) mask.fill(0, i + (j + y) * width, i + w + (j + y) * width);
          i += w;
        }
    }
  }
}

/**
 * Smooths normals: at each vertex position, the quads reachable through shared edges (positive overlap, so greedy T
 * junctions count and corner-only contacts do not) within `creaseAngle` share the average of their distinct normals.
 * Edges shared by more than two quads stay hard.
 */
function smooth(parts: Parts, creaseAngle: number): void {
  type Segment = { face: number; low: number; high: number };
  type Line = { axis: number; fixed: number[]; segments: Segment[] };
  const { positions, normals } = parts,
    quads = parts.palette.length,
    lines = new Map<
      string,
      { axis: number; fixed: number[]; events: Map<number, { start: number[]; end: number[] }> }
    >(),
    edges: Line[][] = Array.from({ length: quads }, () => []);
  // Bucket each quad edge by the line it lies on, then sweep each line to find which quads share an interval.
  for (let face = 0; face < quads; face++)
    for (let corner = 0; corner < 4; corner++) {
      const a = face * 12 + corner * 3,
        b = face * 12 + ((corner + 1) % 4) * 3,
        axis = [0, 1, 2].find((k) => positions[a + k] !== positions[b + k])!,
        fixed = [positions[a], positions[a + 1], positions[a + 2]];
      fixed[axis] = 0;
      const key = `${axis}:${fixed.join(',')}`;
      let line = lines.get(key);
      if (!line) lines.set(key, (line = { axis, fixed, events: new Map() }));
      const low = Math.min(positions[a + axis], positions[b + axis]),
        high = Math.max(positions[a + axis], positions[b + axis]);
      for (const [at, end] of [
        [low, false],
        [high, true],
      ] as const) {
        let event = line.events.get(at);
        if (!event) line.events.set(at, (event = { start: [], end: [] }));
        (end ? event.end : event.start).push(face);
      }
    }
  for (const { axis, fixed, events } of lines.values()) {
    const stops = [...events.keys()].sort((a, b) => a - b),
      active = new Map<number, number>(),
      byFace = new Map<number, Line>();
    for (let k = 0; k < stops.length - 1; k++) {
      const event = events.get(stops[k])!;
      for (const face of event.end) {
        const left = active.get(face)! - 1;
        if (left) active.set(face, left);
        else active.delete(face);
      }
      for (const face of event.start) active.set(face, (active.get(face) ?? 0) + 1);
      if (active.size !== 2) continue;
      const [a, b] = [...active.keys()];
      for (const [face, other] of [
        [a, b],
        [b, a],
      ]) {
        let line = byFace.get(face);
        if (!line) {
          byFace.set(face, (line = { axis, fixed, segments: [] }));
          edges[face].push(line);
        }
        line.segments.push({ face: other, low: stops[k], high: stops[k + 1] });
      }
    }
  }
  const atPoint = new Map<string, number[]>();
  for (let i = 0; i < positions.length; i += 3) {
    const key = `${positions[i]},${positions[i + 1]},${positions[i + 2]}`;
    let group = atPoint.get(key);
    if (!group) atPoint.set(key, (group = []));
    group.push(i);
  }
  const flat = normals.slice(),
    threshold = Math.cos((creaseAngle * Math.PI) / 180) - 1e-7,
    faceNormal = (face: number) => flat.slice(face * 12, face * 12 + 3);
  for (const group of atPoint.values()) {
    const point = positions.slice(group[0], group[0] + 3),
      done = new Map<number, number[]>();
    for (const index of group) {
      const face = Math.floor(index / 12);
      if (!done.has(face)) {
        const reached = new Set([face]),
          pending = [face],
          directions = new Set<string>(),
          sum = [0, 0, 0];
        while (pending.length) {
          const current = pending.pop()!,
            n = faceNormal(current),
            key = n.join(',');
          if (!directions.has(key)) {
            directions.add(key);
            for (let k = 0; k < 3; k++) sum[k] += n[k];
          }
          for (const line of edges[current]) {
            if (!point.every((value, k) => k === line.axis || value === line.fixed[k])) continue;
            // Segments are sorted along the line: binary-search the first one that can hold this point.
            const along = point[line.axis];
            let lo = 0,
              hi = line.segments.length;
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              if (line.segments[mid].high < along) lo = mid + 1;
              else hi = mid;
            }
            for (let s = lo; s < line.segments.length && line.segments[s].low <= along; s++) {
              const other = line.segments[s].face;
              if (reached.has(other)) continue;
              const m = faceNormal(other);
              if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] >= threshold) {
                reached.add(other);
                pending.push(other);
              }
            }
          }
        }
        const length = Math.hypot(sum[0], sum[1], sum[2]);
        for (const member of reached) done.set(member, length > 1e-9 ? sum.map((v) => v / length) : faceNormal(member));
      }
      const n = done.get(face)!;
      normals[index] = n[0];
      normals[index + 1] = n[1];
      normals[index + 2] = n[2];
    }
  }
}
