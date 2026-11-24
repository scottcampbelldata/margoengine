// @margoengine/mesh-edit/remesh: rebuild a messy or scanned mesh into even faces, before sculpting, simulation or
// simplification. Isotropic remeshing keeps the surface and improves the triangles; voxel remeshing rebuilds the
// surface from a grid, which also closes gaps and merges overlapping parts.
import type { MutableVec2, MutableVec3, Vec3 } from '@margoengine/math';
import { MeshBVH } from '@margoengine/bvh/tree';
import { assertOptions } from './edit-support.js';
import { FaceSink } from './face-sink.js';
import { assertPolygonMesh, collectPolygonEdges, compilePolygonMesh, polygonGeometryError } from './polygon.js';
import {
  collapseShortEdges,
  flipTowardValence,
  markSharpEdges,
  polygonMeshOfSurface,
  relaxTangential,
  sameUV,
  splitLongEdges,
  triSurfaceOf,
} from './tri-surface.js';
import type { PolygonFace, PolygonMesh } from './types.js';

/** Options for {@link remeshMesh}. */
export interface RemeshOptions {
  /** Edge length to aim for, positive. Default the mesh's mean edge length. */
  targetLength?: number;
  /** Rounds of split, collapse, flip and relax, 1 to 100. Default 5. */
  iterations?: number;
  /** Edges bent more than this (radians) stay as creases. Default 40 degrees. */
  sharpAngle?: number;
  /** Keep UV seams as edges, so textures stay put. Default true. */
  preserveSeams?: boolean;
  /** Pair the even triangles into quads, so the result is mostly quads. Default false. */
  quads?: boolean;
  /** Face ID generator (default `crypto.randomUUID`). */
  createId?: () => string;
  /** Checked between rounds; aborting throws the signal's reason. */
  signal?: AbortSignal;
}

/** Result of {@link remeshMesh}. */
export interface RemeshResult {
  mesh: PolygonMesh;
  /** For each output face ID, the input face it lies on. */
  sources: Record<string, string>;
  /**
   * With `quads`: every pair as `mesh` vertex indices, in the winding of its faces. A flat pair is one face of `mesh`; a
   * warped one stays two triangles there, because a face must be planar.
   */
  quads?: [number, number, number, number][];
  /** With `quads`: triangles left without a partner. */
  unpaired?: number;
  diagnostics: string[];
}

/** Options for {@link remeshMeshVoxels}. */
export interface VoxelRemeshOptions {
  /** Grid step: the output's edge length, positive. Required. */
  voxelSize: number;
  /** Stop before a grid with more cells than this. Default 16,777,216. */
  maxCells?: number;
  /** Face ID generator (default `crypto.randomUUID`). */
  createId?: () => string;
  /** Checked as the work goes; aborting throws the signal's reason. */
  signal?: AbortSignal;
}

/** Result of {@link remeshMeshVoxels}. */
export interface VoxelRemeshResult {
  /** Planar quads stay quads; warped ones are two triangles, because a face must be planar. */
  mesh: PolygonMesh;
  /** The grid's quads as `mesh` vertex indices, including those `mesh` had to split. */
  quads: [number, number, number, number][];
  /** Output edges joining four faces, where two parts of the surface pass within one voxel. */
  nonManifoldEdges: number;
  diagnostics: string[];
}

function idMaker(createId: (() => string) | undefined, label: string): () => string {
  if (createId !== undefined && typeof createId !== 'function')
    throw new TypeError(`${label} createId must be a function; supply a generator or omit it.`);
  const make = createId ?? (() => globalThis.crypto.randomUUID()),
    used = new Set<string>();
  return () => {
    const id = make();
    if (typeof id !== 'string' || !id.length || used.has(id))
      throw new TypeError('Generated face ID must be nonempty and unique; fix the createId generator.');
    used.add(id);
    return id;
  };
}

function assertSignal(signal: unknown, label: string): void {
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new TypeError(`${label} signal must be an AbortSignal; pass controller.signal or omit it.`);
}

/** Closest-point snapping onto the input surface. */
function surfaceProjector(mesh: PolygonMesh): (p: MutableVec3) => void {
  const compiled = compilePolygonMesh(mesh),
    bvh = MeshBVH.build({
      positions: new Float64Array(compiled.positions),
      indices: compiled.indices,
      precision: 'float64',
    });
  return (p) => {
    const hit = bvh.closestPointToPoint(p);
    if (!hit) return;
    p[0] = hit.point[0];
    p[1] = hit.point[1];
    p[2] = hit.point[2];
  };
}

/** A corner further than this from a right angle, in radians, leaves two triangles apart: they would make a sliver. */
const QUAD_CORNER = (65 * Math.PI) / 180;
/** How many pairs a search for a lone triangle's partner may pass through. */
const PAIR_PATH = 256;

/** Two triangles over a shared edge, as a quad: how far its worst corner is from a right angle. Infinity when not convex. */
function quadSkew(corners: readonly Vec3[]): number {
  const sub = (p: Vec3, q: Vec3): MutableVec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]],
    cross = (u: Vec3, v: Vec3): MutableVec3 => [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ],
    dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2],
    turns = corners.map((corner, i) =>
      cross(sub(corners[(i + 1) % 4], corner), sub(corners[(i + 3) % 4], corner)),
    ),
    axis = turns.reduce((sum, turn) => [sum[0] + turn[0], sum[1] + turn[1], sum[2] + turn[2]], [0, 0, 0]);
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    if (dot(turns[i], axis) <= 0) return Infinity;
    const u = sub(corners[(i + 1) % 4], corners[i]),
      v = sub(corners[(i + 3) % 4], corners[i]),
      angle = Math.atan2(Math.hypot(...turns[i]), dot(u, v));
    worst = Math.max(worst, Math.abs(angle - Math.PI / 2));
  }
  return worst;
}

/**
 * Pairs triangles across edges, the squarest pair first, so each triangle joins at most one quad. A greedy matching
 * with an augmenting search: it leaves a few more triangles alone than an optimal one would, and costs a sort. Creases above `sharpAngle` and UV
 * seams stay edges of the result. `sources` loses the second triangle of each flat pair, which becomes one face.
 */
function pairTriangles(
  mesh: PolygonMesh,
  sharpAngle: number,
  preserveSeams: boolean,
  sources: Record<string, string>,
): { mesh: PolygonMesh; quads: [number, number, number, number][]; unpaired: number } {
  const edges = new Map<number, [number, number][]>(),
    count = mesh.vertices.length;
  mesh.faces.forEach(({ vertices }, face) => {
    for (let corner = 0; corner < 3; corner++) {
      const a = vertices[corner],
        b = vertices[(corner + 1) % 3],
        key = Math.min(a, b) * count + Math.max(a, b),
        list = edges.get(key);
      if (list) list.push([face, corner]);
      else edges.set(key, [[face, corner]]);
    }
  });
  const normal = (face: PolygonFace): MutableVec3 => {
      const [a, b, c] = face.vertices.map((v) => mesh.vertices[v]),
        u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
        n: MutableVec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
        size = Math.hypot(n[0], n[1], n[2]) || 1;
      return [n[0] / size, n[1] / size, n[2] / size];
    },
    pairs: { skew: number; first: number; second: number; quad: [number, number, number, number]; uv: MutableVec2[] }[] = [];
  for (const list of edges.values()) {
    if (list.length !== 2) continue;
    const [[first, i], [second, j]] = list,
      p = mesh.faces[first],
      q = mesh.faces[second],
      a = p.vertices[i],
      b = p.vertices[(i + 1) % 3];
    // Faces that run the shared edge the same way are wound against each other: no quad has both.
    if (q.vertices[j] !== b || q.vertices[(j + 1) % 3] !== a) continue;
    const m = normal(p),
      n = normal(q),
      bend = Math.acos(Math.min(1, Math.max(-1, m[0] * n[0] + m[1] * n[1] + m[2] * n[2])));
    if (bend > sharpAngle) continue;
    if (preserveSeams && !(sameUV(p.uv[i], q.uv[(j + 1) % 3]) && sameUV(p.uv[(i + 1) % 3], q.uv[j]))) continue;
    const quad: [number, number, number, number] = [a, q.vertices[(j + 2) % 3], b, p.vertices[(i + 2) % 3]],
      skew = quadSkew(quad.map((v) => mesh.vertices[v]));
    if (skew <= QUAD_CORNER)
      pairs.push({ skew, first, second, quad, uv: [p.uv[i], q.uv[(j + 2) % 3], p.uv[(i + 1) % 3], p.uv[(i + 2) % 3]] });
  }
  pairs.sort((x, y) => x.skew - y.skew || x.first - y.first || x.second - y.second);
  // Each triangle's pair, or -1. A triangle left alone then follows alternating paths to another lone triangle and flips
  // them (Kuhn's augmenting search; blossoms are not contracted, so a path through an odd cycle can be missed).
  const partner = new Int32Array(mesh.faces.length).fill(-1),
    around: number[][] = mesh.faces.map(() => []),
    seen = new Int32Array(mesh.faces.length).fill(-1),
    other = (pair: number, face: number) => (pairs[pair].first === face ? pairs[pair].second : pairs[pair].first),
    take = (pair: number) => {
      partner[pairs[pair].first] = partner[pairs[pair].second] = pair;
    },
    reach = (face: number, from: number, depth: number): boolean => {
      seen[face] = from;
      for (const near of around[face]) {
        const next = other(near, face);
        if (seen[next] === from) continue;
        seen[next] = from;
        if (partner[next] < 0) {
          take(near);
          return true;
        }
        const freed = other(partner[next], next);
        if (depth < PAIR_PATH && seen[freed] !== from && reach(freed, from, depth + 1)) {
          take(near);
          return true;
        }
      }
      return false;
    };
  pairs.forEach(({ first, second }, i) => {
    around[first].push(i);
    around[second].push(i);
    if (partner[first] < 0 && partner[second] < 0) take(i);
  });
  for (let lone = 0; lone < partner.length; lone++) if (partner[lone] < 0) reach(lone, lone, 0);
  const merged = new Map<number, PolygonFace>(),
    dropped = new Set<number>(),
    quads: [number, number, number, number][] = [];
  for (const { first, second, quad, uv } of pairs.filter((_, i) => partner[_.first] === i)) {
    quads.push(quad);
    if (polygonGeometryError(quad.map((v) => mesh.vertices[v])) === null) {
      merged.set(first, { id: mesh.faces[first].id, vertices: quad, uv });
      dropped.add(second);
      delete sources[mesh.faces[second].id];
    }
  }
  return {
    mesh: {
      vertices: mesh.vertices,
      faces: mesh.faces.flatMap((face, i) => (dropped.has(i) ? [] : [merged.get(i) ?? face])),
    },
    quads,
    unpaired: mesh.faces.length - quads.length * 2,
  };
}

/**
 * Rebuild a surface into even triangles of about `targetLength` (isotropic remeshing; Botsch and Kobbelt, 2004): each
 * round splits long edges, collapses short ones, flips toward six neighbors per vertex and relaxes vertices along the
 * surface, then snaps them back onto the input. Open edges, creases above `sharpAngle` and UV seams stay in place.
 * With `quads`, the triangles then pair up across their edges, the squarest first, for a mostly quad surface.
 * @throws TypeError for a bad mesh or options; RangeError for an option outside its limits; the signal's reason when
 * aborted.
 */
export function remeshMesh(mesh: PolygonMesh, options: RemeshOptions = {}): RemeshResult {
  assertPolygonMesh(mesh);
  assertOptions(options, 'Remesh');
  const { iterations = 5, sharpAngle = (40 * Math.PI) / 180, preserveSeams = true, signal } = options;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100)
    throw new RangeError('Remesh iterations must be an integer from 1 to 100; choose a round count.');
  if (!(sharpAngle >= 0 && sharpAngle <= Math.PI))
    throw new RangeError('Remesh sharpAngle must be 0 to pi radians; choose a crease angle.');
  assertSignal(signal, 'Remesh');
  const createId = idMaker(options.createId, 'Remesh'),
    surface = triSurfaceOf(mesh);
  markSharpEdges(surface, sharpAngle, preserveSeams);
  let target = options.targetLength;
  if (target === undefined) {
    let sum = 0,
      count = 0;
    for (const edge of collectPolygonEdges(mesh)) {
      const [a, b] = edge.vertices.map((v) => mesh.vertices[v]);
      sum += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      count++;
    }
    target = sum / count;
  }
  if (!(target > 0 && Number.isFinite(target)))
    throw new RangeError('Remesh targetLength must be positive; choose an edge length in mesh units.');
  const high = (target * 4) / 3,
    low = (target * 4) / 5,
    project = surfaceProjector(mesh);
  for (let round = 0; round < iterations; round++) {
    signal?.throwIfAborted();
    for (let pass = 0; pass < 8 && splitLongEdges(surface, high); pass++) signal?.throwIfAborted();
    for (let pass = 0; pass < 8 && collapseShortEdges(surface, low, high); pass++) signal?.throwIfAborted();
    for (let pass = 0; pass < 4 && flipTowardValence(surface); pass++) signal?.throwIfAborted();
    relaxTangential(surface, 0.5, project);
  }
  const sources: Record<string, string> = {},
    output = polygonMeshOfSurface(surface, (source) => {
      const id = createId();
      sources[id] = source;
      return id;
    });
  if (options.quads) {
    const paired = pairTriangles(output, sharpAngle, preserveSeams, sources);
    assertPolygonMesh(paired.mesh);
    return { ...paired, sources, diagnostics: [] };
  }
  assertPolygonMesh(output);
  return { mesh: output, sources, diagnostics: [] };
}

/** Closest point on triangle a-b-c to p (Ericson's region test), as a squared distance. */
function triangleDistance2(p: number[], a: number[], b: number[], c: number[]): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
    ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]],
    d1 = ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2],
    d2 = ac[0] * ap[0] + ac[1] * ap[1] + ac[2] * ap[2],
    bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]],
    d3 = ab[0] * bp[0] + ab[1] * bp[1] + ab[2] * bp[2],
    d4 = ac[0] * bp[0] + ac[1] * bp[1] + ac[2] * bp[2],
    cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]],
    d5 = ab[0] * cp[0] + ab[1] * cp[1] + ab[2] * cp[2],
    d6 = ac[0] * cp[0] + ac[1] * cp[1] + ac[2] * cp[2],
    vc = d1 * d4 - d3 * d2,
    vb = d5 * d2 - d1 * d6,
    va = d3 * d6 - d5 * d4,
    at = (s: number, t: number): number => {
      const x = ap[0] - ab[0] * s - ac[0] * t,
        y = ap[1] - ab[1] * s - ac[1] * t,
        z = ap[2] - ab[2] * s - ac[2] * t;
      return x * x + y * y + z * z;
    };
  if (d1 <= 0 && d2 <= 0) return at(0, 0);
  if (d3 >= 0 && d4 <= d3) return at(1, 0);
  if (d6 >= 0 && d5 <= d6) return at(0, 1);
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at(1 - w, w);
  }
  const denominator = 1 / (va + vb + vc);
  return at(vb * denominator, vc * denominator);
}

/** A signed distance grid: negative inside. Nodes sit at `origin + index * step`. */
interface Field {
  nx: number;
  ny: number;
  nz: number;
  origin: number[];
  step: number;
  value: Float32Array;
}

function signedField(mesh: PolygonMesh, step: number, maxCells: number, tick: () => void): Field {
  const compiled = compilePolygonMesh(mesh),
    P = compiled.positions,
    I = compiled.indices,
    lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], P[i + k]);
      hi[k] = Math.max(hi[k], P[i + k]);
    }
  // An odd offset keeps grid lines off the vertices and edges of meshes built on round numbers, so a ray never grazes one.
  const origin = lo.map((x, k) => x - step * (2 + [0.1234567, 0.2345671, 0.3456712][k])),
    [nx, ny, nz] = [0, 1, 2].map((k) => Math.ceil((hi[k] - origin[k]) / step) + 3);
  if (nx * ny * nz > maxCells)
    throw new RangeError(`Voxel grid needs ${nx * ny * nz} cells, over maxCells; raise voxelSize or maxCells.`);
  const value = new Float32Array(nx * ny * nz).fill(Infinity),
    columns = new Map<number, number[]>(),
    node = (x: number, y: number, z: number) => (z * ny + y) * nx + x,
    triangle = (t: number): number[][] =>
      [0, 1, 2].map((c) => {
        const i = I[t * 3 + c] * 3;
        return [P[i], P[i + 1], P[i + 2]];
      });
  for (let t = 0; t < I.length / 3; t++) {
    tick();
    const [a, b, c] = triangle(t),
      from = [0, 1, 2].map((k) => Math.max(0, Math.floor((Math.min(a[k], b[k], c[k]) - origin[k]) / step) - 1)),
      to = [0, 1, 2].map((k, axis) =>
        Math.min([nx, ny, nz][axis] - 1, Math.ceil((Math.max(a[k], b[k], c[k]) - origin[k]) / step) + 1),
      );
    for (let z = from[2]; z <= to[2]; z++)
      for (let y = from[1]; y <= to[1]; y++)
        for (let x = from[0]; x <= to[0]; x++) {
          const p = [origin[0] + x * step, origin[1] + y * step, origin[2] + z * step],
            d = Math.sqrt(triangleDistance2(p, a, b, c)),
            at = node(x, y, z);
          if (d < value[at]) value[at] = d;
        }
    // Parity: where the triangle crosses each +X line of grid nodes.
    const area = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    if (!area) continue;
    for (let z = from[2]; z <= to[2]; z++)
      for (let y = from[1]; y <= to[1]; y++) {
        const py = origin[1] + y * step,
          pz = origin[2] + z * step,
          u = ((py - a[1]) * (c[2] - a[2]) - (pz - a[2]) * (c[1] - a[1])) / area,
          v = ((b[1] - a[1]) * (pz - a[2]) - (b[2] - a[2]) * (py - a[1])) / area;
        if (u < 0 || v < 0 || u + v > 1) continue;
        const x = a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v,
          key = z * ny + y,
          list = columns.get(key);
        if (list) list.push(x);
        else columns.set(key, [x]);
      }
  }
  const far = step * 2;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++) {
      tick();
      const crossings = (columns.get(z * ny + y) ?? []).sort((p, q) => p - q);
      let next = 0;
      for (let x = 0; x < nx; x++) {
        const px = origin[0] + x * step;
        while (next < crossings.length && crossings[next] < px) next++;
        const at = node(x, y, z),
          d = Math.min(value[at], far);
        value[at] = next % 2 ? -d : d;
      }
    }
  return { nx, ny, nz, origin, step, value };
}

/**
 * Rebuild a closed mesh from a voxel grid (signed distance, then surface nets; Gibson, 1998): an even all-quad surface
 * of edge about `voxelSize`, whatever the input's triangles were. Gaps narrower than a voxel close, parts that overlap
 * merge and details under a voxel go. UVs do not carry over: every corner gets the unit square.
 * @throws TypeError for a mesh with open edges (fill them with `fillMeshHoles` first) or bad options; RangeError for a
 * bad `voxelSize` or a grid above `maxCells`; the signal's reason when aborted.
 */
export function remeshMeshVoxels(mesh: PolygonMesh, options: VoxelRemeshOptions): VoxelRemeshResult {
  assertPolygonMesh(mesh);
  assertOptions(options, 'Voxel remesh');
  const { voxelSize, maxCells = 2 ** 24, signal } = options;
  if (!(voxelSize > 0 && Number.isFinite(voxelSize)))
    throw new RangeError('Voxel remesh voxelSize must be positive; choose a step in mesh units.');
  if (!(maxCells > 0)) throw new RangeError('Voxel remesh maxCells must be positive; choose a cell limit.');
  assertSignal(signal, 'Voxel remesh');
  if (collectPolygonEdges(mesh).some((edge) => edge.incidences.length !== 2))
    throw new TypeError('Voxel remesh needs a closed mesh to tell inside from outside; close it with fillMeshHoles.');
  const createId = idMaker(options.createId, 'Voxel remesh');
  let ticks = 0;
  const tick = () => {
      if (signal && ++ticks % 256 === 0) signal.throwIfAborted();
    },
    field = signedField(mesh, voxelSize, maxCells, tick),
    { nx, ny, nz, origin, step, value } = field,
    node = (x: number, y: number, z: number) => (z * ny + y) * nx + x,
    vertices: MutableVec3[] = [],
    cellVertex = new Int32Array(nx * ny * nz).fill(-1),
    corners = [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
      [0, 2],
      [1, 3],
      [4, 6],
      [5, 7],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ];
  for (let z = 0; z < nz - 1; z++)
    for (let y = 0; y < ny - 1; y++)
      for (let x = 0; x < nx - 1; x++) {
        const d = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => value[node(x + (i & 1), y + ((i >> 1) & 1), z + (i >> 2))]);
        if (d.every((v) => v < 0) || d.every((v) => v >= 0)) continue;
        let sx = 0,
          sy = 0,
          sz = 0,
          count = 0;
        for (const [p, q] of corners) {
          if (d[p] < 0 === d[q] < 0) continue;
          const t = d[p] / (d[p] - d[q]);
          sx += (p & 1) + ((q & 1) - (p & 1)) * t;
          sy += ((p >> 1) & 1) + (((q >> 1) & 1) - ((p >> 1) & 1)) * t;
          sz += (p >> 2) + ((q >> 2) - (p >> 2)) * t;
          count++;
        }
        cellVertex[node(x, y, z)] = vertices.length;
        vertices.push([
          origin[0] + (x + sx / count) * step,
          origin[1] + (y + sy / count) * step,
          origin[2] + (z + sz / count) * step,
        ]);
      }
  const quads: [number, number, number, number][] = [],
    cell = (x: number, y: number, z: number) => cellVertex[node(x, y, z)],
    emit = (inside: boolean, a: number, b: number, c: number, d: number) => {
      quads.push(inside ? [a, b, c, d] : [d, c, b, a]);
    };
  for (let z = 1; z < nz - 1; z++)
    for (let y = 1; y < ny - 1; y++)
      for (let x = 1; x < nx - 1; x++) {
        tick();
        const here = value[node(x, y, z)] < 0;
        if (here !== value[node(x + 1, y, z)] < 0)
          emit(here, cell(x, y - 1, z - 1), cell(x, y, z - 1), cell(x, y, z), cell(x, y - 1, z));
        if (here !== value[node(x, y + 1, z)] < 0)
          emit(here, cell(x - 1, y, z - 1), cell(x - 1, y, z), cell(x, y, z), cell(x, y, z - 1));
        if (here !== value[node(x, y, z + 1)] < 0)
          emit(here, cell(x - 1, y - 1, z), cell(x, y - 1, z), cell(x, y, z), cell(x - 1, y, z));
      }
  const empty: PolygonMesh = { vertices: [], faces: [] },
    sink = new FaceSink(empty, vertices),
    uv: MutableVec2[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
  for (const quad of quads) sink.add(null, createId(), quad, uv);
  const output: PolygonMesh = { vertices, faces: sink.faces as PolygonFace[] };
  assertPolygonMesh(output);
  const nonManifoldEdges = collectPolygonEdges(output).filter((edge) => edge.incidences.length > 2).length;
  return {
    mesh: output,
    quads,
    nonManifoldEdges,
    diagnostics: nonManifoldEdges
      ? [`${nonManifoldEdges} edges join four faces; a finer voxelSize separates them.`]
      : [],
  };
}
