import type { MutableVec2, Vec2 } from '@margoengine/math';
import { assertOptions } from './edit-support.js';
import { assertPolygonMesh, collectPolygonEdges, newellNormal } from './polygon.js';
import { triangulateLoop } from './polygon-split.js';
import type { PolygonMesh } from './types.js';

/** A UV pin: every corner of `vertex` in its chart is fixed at `uv` (normalized, top-left origin). */
export interface UVPin {
  vertex: number;
  uv: Vec2;
}

/** Options shared by {@link unwrapMesh} and {@link meshLightmapUVs}. */
export interface ChartOptions {
  /** Edge IDs (`"low:high"`) to cut. Open borders always cut. Default none. */
  seams?: readonly string[];
  /** Edges whose two faces meet at more than this many degrees (0 to 180) are cut too. Default 66; 180 turns it off. */
  angle?: number;
  /** Atlas side in texels that `padding` is measured in. Default 1024 for unwrap, 256 for lightmaps. */
  resolution?: number;
  /** Empty texels between charts and at the atlas border. Default 4 for unwrap, 2 for lightmaps. */
  padding?: number;
  /** Checked between charts and solver iterations; aborting throws the signal's reason. */
  signal?: AbortSignal;
}

/** Options for {@link unwrapMesh}. */
export interface UnwrapOptions extends ChartOptions {
  /** Fixed corners. A chart with two or more pins is solved through them and stays where they put it; one pin only
   * places its chart (unpacked, at the packed charts' texel density). Default none. */
  pins?: readonly UVPin[];
}

/** One chart (UV island) of an unwrap. */
export interface UVChart {
  /** Face IDs, in mesh order. */
  faces: string[];
  /** Number of pins in the chart (pinned charts are not packed). */
  pins: number;
  /** Normalized top-left bounds: [uMin, vMin, uMax, vMax]. */
  bounds: [number, number, number, number];
  /** Surface area in local units squared. */
  area: number;
  /** Largest over smallest triangle scale (square root of UV area over surface area); 1 is perfectly even. */
  stretch: number;
}

/** Result of {@link unwrapMesh}. */
export interface UnwrapResult {
  /** The input mesh with new corner UVs; vertices, faces, IDs and winding are unchanged. */
  mesh: PolygonMesh;
  charts: UVChart[];
  /** Edges where the output UVs are discontinuous (cuts that opened), sorted. Open borders are not listed. */
  seams: string[];
  /** Texels per local unit of the packed charts at `resolution`. */
  texelsPerUnit: number;
  /** Notes about charts that could not be laid out without folds (only possible with conflicting pins). */
  diagnostics: string[];
}

/** Result of {@link meshLightmapUVs}. */
export interface LightmapUVResult {
  /** A second UV set: `uv[f][c]` is corner `c` of `mesh.faces[f]`, normalized with a top-left origin. */
  uv: MutableVec2[][];
  charts: UVChart[];
  seams: string[];
  /** Texels per local unit, the same for every chart. */
  texelsPerUnit: number;
  resolution: number;
}

interface Link {
  f: number;
  c: number;
  g: number;
  d: number;
}

interface Chart {
  faces: number[];
  /** Per chart face, the local vertex of each corner. */
  local: number[][];
  vertexOf: number[];
  uv: Float64Array;
  pins: number;
}

function validate(mesh: PolygonMesh, options: ChartOptions, label: string, resolution: number, padding: number) {
  assertPolygonMesh(mesh, true, true);
  assertOptions(options, label);
  const angle = options.angle ?? 66;
  if (typeof angle !== 'number' || !(angle >= 0 && angle <= 180))
    throw new RangeError(`${label} angle must be from 0 to 180 degrees; 180 cuts only seams and borders.`);
  if (!Number.isInteger(resolution) || resolution < 8 || resolution > 16384)
    throw new RangeError(`${label} resolution must be a whole number of texels from 8 to 16384; choose an atlas size.`);
  if (!Number.isInteger(padding) || padding < 0 || padding * 4 >= resolution)
    throw new RangeError(`${label} padding must be whole texels, at least 0 and under a quarter of the resolution.`);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw new TypeError(`${label} signal must be an AbortSignal; pass controller.signal or omit it.`);
  if (options.seams !== undefined && !Array.isArray(options.seams))
    throw new TypeError(`${label} seams need an array of edge IDs; supply "low:high" edge IDs.`);
  return angle;
}

/** Charts by cutting seams, borders, sharp, nonmanifold and inconsistently wound edges. */
function makeCharts(mesh: PolygonMesh, angle: number, seams: readonly string[], label: string) {
  const P = mesh.vertices,
    F = mesh.faces,
    normals = F.map((face) => newellNormal(face.vertices.map((v) => P[v]))),
    edges = collectPolygonEdges(mesh),
    known = new Set(edges.map((edge) => edge.id)),
    faceIndex = new Map(F.map((face, i) => [face.id, i])),
    cutIds = new Set<string>(),
    limit = Math.cos((angle * Math.PI) / 180) - 1e-12;
  for (const id of seams) {
    if (typeof id !== 'string' || !known.has(id))
      throw new TypeError(`${label} seam ${String(id)} is not an edge of the mesh; select existing edge IDs.`);
    cutIds.add(id);
  }
  const links: Link[] = [],
    faceLinks: number[][] = F.map(() => []);
  for (const edge of edges) {
    if (edge.incidences.length !== 2 || cutIds.has(edge.id)) continue;
    const [p, q] = edge.incidences;
    if (p.from !== q.to || p.to !== q.from) continue;
    const f = faceIndex.get(p.faceId)!,
      g = faceIndex.get(q.faceId)!,
      a = normals[f],
      b = normals[g];
    if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < limit) continue;
    faceLinks[f].push(links.length);
    faceLinks[g].push(links.length);
    links.push({ f, c: p.corner, g, d: q.corner });
  }
  return { links, faceLinks };
}

/** Union-find over integers. */
const finder = (n: number) => {
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  return { find, union: (a: number, b: number) => void (parent[find(a)] = find(b)) };
};

/**
 * Lay out every face in charts: each chart is a topological disk flattened by least squares conformal maps (Lévy,
 * Petitjean, Ray and Maillot, 2002), split until it has no folded triangle and its border does not cross itself.
 */
function layout(
  mesh: PolygonMesh,
  angle: number,
  seams: readonly string[],
  pins: ReadonlyMap<number, Vec2>,
  label: string,
  signal: AbortSignal | undefined,
) {
  const F = mesh.faces,
    P = mesh.vertices,
    { links, faceLinks } = makeCharts(mesh, angle, seams, label),
    cut = new Uint8Array(links.length),
    base: number[] = [];
  let corners = 0;
  for (const face of F) {
    base.push(corners);
    corners += face.vertices.length;
  }
  const triangulation = F.map((face) =>
    face.vertices.length === 3 ? [[0, 1, 2]] : (triangulateLoop(face.vertices.map((v) => P[v])) ?? []),
  );
  const chartOf = new Int32Array(F.length).fill(-1),
    done: Chart[] = [],
    diagnostics: string[] = [];
  let marks = 1_000_000;
  // Initial charts: connected faces over uncut links.
  const queue: number[][] = [];
  {
    const uf = finder(F.length);
    for (const link of links) uf.union(link.f, link.g);
    const groups = new Map<number, number[]>();
    for (let f = 0; f < F.length; f++) {
      const root = uf.find(f);
      const list = groups.get(root) ?? [];
      list.push(f);
      groups.set(root, list);
    }
    queue.push(...groups.values());
  }
  while (queue.length) {
    signal?.throwIfAborted();
    const faces = queue.pop()!;
    const mark = marks++; // marks are above any finished chart index
    for (const f of faces) chartOf[f] = mark;
    // Local vertices: corners joined across the chart's uncut links.
    const uf = finder(corners);
    for (const f of faces)
      for (const l of faceLinks[f]) {
        const link = links[l];
        if (cut[l] || chartOf[link.f] !== mark || chartOf[link.g] !== mark || link.f !== f) continue;
        const nf = F[link.f].vertices.length,
          ng = F[link.g].vertices.length;
        uf.union(base[link.f] + link.c, base[link.g] + ((link.d + 1) % ng));
        uf.union(base[link.f] + ((link.c + 1) % nf), base[link.g] + link.d);
      }
    const id = new Map<number, number>(),
      vertexOf: number[] = [],
      local = faces.map((f) =>
        F[f].vertices.map((v, c) => {
          const root = uf.find(base[f] + c);
          let i = id.get(root);
          if (i === undefined) {
            i = vertexOf.length;
            id.set(root, i);
            vertexOf.push(v);
          }
          return i;
        }),
      );
    // Topology: a disk has Euler characteristic 1 and one border loop through simple border vertices.
    const half = new Set<string>(),
      edgeSet = new Set<string>();
    let manifold = true;
    for (const loop of local)
      loop.forEach((a, i) => {
        const b = loop[(i + 1) % loop.length];
        if (half.has(`${a}>${b}`)) manifold = false;
        half.add(`${a}>${b}`);
        edgeSet.add(a < b ? `${a}:${b}` : `${b}:${a}`);
      });
    const next = new Map<number, number>();
    for (const loop of local)
      loop.forEach((a, i) => {
        const b = loop[(i + 1) % loop.length];
        if (half.has(`${b}>${a}`)) return;
        if (next.has(a)) manifold = false;
        next.set(a, b);
      });
    let loops = 0;
    const seen = new Set<number>();
    for (const start of next.keys()) {
      if (seen.has(start)) continue;
      loops++;
      for (let v: number | undefined = start; v !== undefined && !seen.has(v); v = next.get(v)) seen.add(v);
    }
    const disk = manifold && loops === 1 && vertexOf.length - edgeSet.size + faces.length === 1;
    let uv: Float64Array | null = null,
      count = 0;
    if (disk) {
      count = [...new Set(vertexOf.filter((v) => pins.has(v)))].length;
      uv = solveChart(P, faces, local, triangulation, vertexOf, [...next.keys()], count >= 2 ? pins : null, signal);
    }
    const ok = uv !== null && valid(uv, local, triangulation, faces, next);
    if (uv && (ok || faces.length === 1 || count >= 2)) {
      if (!ok)
        diagnostics.push(
          `Chart with face ${F[faces[0]].id} folds under its ${count} pins; move the pins so they keep their layout.`,
        );
      faces.forEach((f) => (chartOf[f] = done.length));
      done.push({ faces, local, vertexOf, uv, pins: count });
      continue;
    }
    // Split in two by growing regions from the two faces farthest apart.
    const parts = splitChart(F, P, faces, faceLinks, links, cut, chartOf, mark);
    queue.push(...parts);
  }
  return { charts: done, diagnostics };
}

/** Grow two regions from the two faces farthest apart (centroid distances over uncut links); cut between them. */
function splitChart(
  F: PolygonMesh['faces'],
  P: PolygonMesh['vertices'],
  faces: number[],
  faceLinks: number[][],
  links: Link[],
  cut: Uint8Array,
  chartOf: Int32Array,
  mark: number,
): number[][] {
  const centre = new Map(
    faces.map((f) => {
      const c = [0, 0, 0];
      for (const v of F[f].vertices) for (let k = 0; k < 3; k++) c[k] += P[v][k] / F[f].vertices.length;
      return [f, c];
    }),
  );
  const grow = (seeds: number[]) => {
    const dist = new Map<number, number>(),
      label = new Map<number, number>(),
      heap: [number, number, number][] = [];
    const push = (item: [number, number, number]) => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0],
        last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1,
            r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    seeds.forEach((s, i) => push([0, s, i]));
    let last = seeds[0];
    while (heap.length) {
      const [d, f, l] = pop();
      if (dist.has(f)) continue;
      dist.set(f, d);
      label.set(f, l);
      last = f;
      for (const k of faceLinks[f]) {
        if (cut[k]) continue;
        const link = links[k],
          g = link.f === f ? link.g : link.f;
        if (chartOf[g] !== mark || dist.has(g)) continue;
        const a = centre.get(f)!,
          b = centre.get(g)!;
        push([d + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), g, l]);
      }
    }
    return { last, label };
  };
  const a = grow([faces[0]]).last,
    b = grow([a]).last,
    { label } = grow([a, b]);
  for (const f of faces)
    for (const k of faceLinks[f]) {
      const link = links[k];
      if (!cut[k] && chartOf[link.f] === mark && chartOf[link.g] === mark && label.get(link.f) !== label.get(link.g))
        cut[k] = 1;
    }
  return [0, 1].map((l) => faces.filter((f) => label.get(f) === l));
}

/** Twice the signed area of a UV triangle. */
const uvTurn = (uv: Float64Array, a: number, b: number, c: number) =>
  (uv[2 * b] - uv[2 * a]) * (uv[2 * c + 1] - uv[2 * a + 1]) - (uv[2 * b + 1] - uv[2 * a + 1]) * (uv[2 * c] - uv[2 * a]);

/** No folded or collapsed triangle, and a border that does not touch or cross itself. */
function valid(
  uv: Float64Array,
  local: number[][],
  triangulation: number[][][],
  faces: number[],
  next: ReadonlyMap<number, number>,
): boolean {
  let total = 0;
  const areas: number[] = [];
  faces.forEach((f, i) => {
    for (const [a, b, c] of triangulation[f]) {
      const t = uvTurn(uv, local[i][a], local[i][b], local[i][c]);
      areas.push(t);
      total += Math.abs(t);
    }
  });
  if (areas.some((t) => !(t > total * 1e-12))) return false;
  // Border self-intersection through a uniform grid of segment boxes.
  const segments = [...next].map(([a, b]) => [a, b]);
  if (segments.length < 4) return true;
  let minU = Infinity,
    minV = Infinity,
    maxU = -Infinity,
    maxV = -Infinity,
    length = 0;
  for (const [a, b] of segments) {
    minU = Math.min(minU, uv[2 * a]);
    maxU = Math.max(maxU, uv[2 * a]);
    minV = Math.min(minV, uv[2 * a + 1]);
    maxV = Math.max(maxV, uv[2 * a + 1]);
    length += Math.hypot(uv[2 * b] - uv[2 * a], uv[2 * b + 1] - uv[2 * a + 1]);
  }
  const cell = Math.max(length / segments.length, (maxU - minU + maxV - minV) / 4096, 1e-300),
    grid = new Map<string, number[]>();
  segments.forEach(([a, b], s) => {
    const u0 = Math.floor((Math.min(uv[2 * a], uv[2 * b]) - minU) / cell),
      u1 = Math.floor((Math.max(uv[2 * a], uv[2 * b]) - minU) / cell),
      v0 = Math.floor((Math.min(uv[2 * a + 1], uv[2 * b + 1]) - minV) / cell),
      v1 = Math.floor((Math.max(uv[2 * a + 1], uv[2 * b + 1]) - minV) / cell);
    for (let i = u0; i <= u1; i++)
      for (let j = v0; j <= v1; j++) {
        const key = `${i},${j}`,
          list = grid.get(key) ?? [];
        list.push(s);
        grid.set(key, list);
      }
  });
  const scale = (maxU - minU + maxV - minV) ** 2 * 1e-14;
  const orient = (a: number, b: number, c: number) => {
    const t = uvTurn(uv, a, b, c);
    return t > scale ? 1 : t < -scale ? -1 : 0;
  };
  const onSegment = (a: number, b: number, c: number) =>
    Math.min(uv[2 * a], uv[2 * b]) <= uv[2 * c] &&
    uv[2 * c] <= Math.max(uv[2 * a], uv[2 * b]) &&
    Math.min(uv[2 * a + 1], uv[2 * b + 1]) <= uv[2 * c + 1] &&
    uv[2 * c + 1] <= Math.max(uv[2 * a + 1], uv[2 * b + 1]);
  for (const list of grid.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = segments[list[i]],
          [c, d] = segments[list[j]];
        if (a === c || a === d || b === c || b === d) continue;
        const o1 = orient(a, b, c),
          o2 = orient(a, b, d),
          o3 = orient(c, d, a),
          o4 = orient(c, d, b);
        if (o1 !== o2 && o3 !== o4) return false;
        if (
          (o1 === 0 && onSegment(a, b, c)) ||
          (o2 === 0 && onSegment(a, b, d)) ||
          (o3 === 0 && onSegment(c, d, a)) ||
          (o4 === 0 && onSegment(c, d, b))
        )
          return false;
      }
  return true;
}

/**
 * Least squares conformal map of one disk chart. Per triangle, with g_j the gradient of corner j's barycentric
 * coordinate in the triangle's own plane, the residual of the Cauchy-Riemann equations grad v = rot90(grad u) is
 * weighted by the triangle's area; the normal equations are solved by Jacobi-preconditioned conjugate gradients.
 * Without two pins, the two border vertices farthest apart are pinned at their true distance (no other scale is
 * imposed). Returns UVs in a frame with v up (orientation preserving), local units for unpinned charts.
 */
function solveChart(
  P: PolygonMesh['vertices'],
  faces: number[],
  local: number[][],
  triangulation: number[][][],
  vertexOf: number[],
  border: number[],
  pins: ReadonlyMap<number, Vec2> | null,
  signal: AbortSignal | undefined,
): Float64Array {
  const n = vertexOf.length,
    x = new Float64Array(2 * n),
    fixed = new Uint8Array(2 * n);
  if (pins) {
    for (let i = 0; i < n; i++) {
      const pin = pins.get(vertexOf[i]);
      if (!pin) continue;
      x[2 * i] = pin[0];
      x[2 * i + 1] = -pin[1];
      fixed[2 * i] = fixed[2 * i + 1] = 1;
    }
  } else {
    const at = (i: number) => P[vertexOf[i]],
      far = (from: number) => {
        let best = border[0],
          d = -1;
        for (const i of border) {
          const p = at(i),
            q = at(from),
            e = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
          if (e > d) {
            d = e;
            best = i;
          }
        }
        return [best, d] as const;
      };
    const [a] = far(border[0]),
      [b, d] = far(a);
    x[2 * b] = d;
    fixed[2 * a] = fixed[2 * a + 1] = fixed[2 * b] = fixed[2 * b + 1] = 1;
  }
  // Assemble the normal matrix, one sparse row per unknown.
  const rows: Map<number, number>[] = Array.from({ length: 2 * n }, () => new Map());
  const add = (i: number, j: number, value: number) => rows[i].set(j, (rows[i].get(j) ?? 0) + value);
  faces.forEach((f, k) => {
    for (const tri of triangulation[f]) {
      const ids = tri.map((c) => local[k][c]),
        [p0, p1, p2] = ids.map((i) => P[vertexOf[i]]),
        e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]],
        e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]],
        l1 = Math.hypot(e1[0], e1[1], e1[2]),
        nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]],
        twice = Math.hypot(nrm[0], nrm[1], nrm[2]);
      if (!(twice > 0) || !(l1 > 0)) continue;
      // Corners in the triangle's plane: q0 = 0, q1 on the x axis, q2 = (e2.x, |e1 x e2| / |e1|).
      const q = [
          [0, 0],
          [l1, 0],
          [(e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / l1, twice / l1],
        ],
        g = [0, 1, 2].map((j) => {
          const a = q[(j + 1) % 3],
            b = q[(j + 2) % 3];
          // rot90(b - a) / (2A)
          return [-(b[1] - a[1]) / twice, (b[0] - a[0]) / twice];
        }),
        weight = Math.sqrt(twice / 2),
        // r1 = sum v_j gx_j + u_j gy_j ; r2 = sum v_j gy_j - u_j gx_j
        r1 = ids.flatMap((i, j) => [
          [2 * i, weight * g[j][1]],
          [2 * i + 1, weight * g[j][0]],
        ]),
        r2 = ids.flatMap((i, j) => [
          [2 * i, -weight * g[j][0]],
          [2 * i + 1, weight * g[j][1]],
        ]);
      for (const r of [r1, r2]) for (const [i, a] of r) for (const [j, b] of r) add(i, j, a * b);
    }
  });
  // Partition into free unknowns; pinned ones move to the right-hand side.
  const free: number[] = [],
    slot = new Int32Array(2 * n).fill(-1);
  for (let i = 0; i < 2 * n; i++)
    if (!fixed[i]) {
      slot[i] = free.length;
      free.push(i);
    }
  const m = free.length,
    start = new Int32Array(m + 1),
    cols: number[] = [],
    vals: number[] = [],
    rhs = new Float64Array(m),
    diag = new Float64Array(m);
  free.forEach((i, r) => {
    for (const [j, value] of rows[i]) {
      if (fixed[j]) rhs[r] -= value * x[j];
      else {
        cols.push(slot[j]);
        vals.push(value);
        if (j === i) diag[r] = value;
      }
    }
    start[r + 1] = cols.length;
  });
  const multiply = (v: Float64Array, out: Float64Array) => {
    for (let r = 0; r < m; r++) {
      let s = 0;
      for (let k = start[r]; k < start[r + 1]; k++) s += vals[k] * v[cols[k]];
      out[r] = s;
    }
  };
  const y = new Float64Array(m),
    res = new Float64Array(rhs),
    z = new Float64Array(m),
    dir = new Float64Array(m),
    q = new Float64Array(m);
  const inv = diag.map((d) => (d > 0 ? 1 / d : 1));
  let norm = 0;
  for (let r = 0; r < m; r++) norm += rhs[r] * rhs[r];
  const goal = norm * 1e-26;
  for (let r = 0; r < m; r++) dir[r] = z[r] = res[r] * inv[r];
  let rz = 0;
  for (let r = 0; r < m; r++) rz += res[r] * z[r];
  for (let it = 0, max = 10 * m + 100; it < max; it++) {
    let rr = 0;
    for (let r = 0; r < m; r++) rr += res[r] * res[r];
    if (!(rr > goal)) break;
    if (signal && it % 64 === 63) signal.throwIfAborted();
    multiply(dir, q);
    let dq = 0;
    for (let r = 0; r < m; r++) dq += dir[r] * q[r];
    if (!(dq > 0)) break;
    const alpha = rz / dq;
    for (let r = 0; r < m; r++) {
      y[r] += alpha * dir[r];
      res[r] -= alpha * q[r];
      z[r] = res[r] * inv[r];
    }
    let next = 0;
    for (let r = 0; r < m; r++) next += res[r] * z[r];
    const beta = next / rz;
    rz = next;
    for (let r = 0; r < m; r++) dir[r] = z[r] + beta * dir[r];
  }
  free.forEach((i, r) => (x[i] = y[r]));
  return x;
}

/** Rotation of a chart's points that gives the smallest bounding box (over its convex hull's edge directions). */
function bestRotation(uv: Float64Array): number {
  const n = uv.length / 2,
    points = Array.from({ length: n }, (_, i) => [uv[2 * i], uv[2 * i + 1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]),
    hull: number[][] = [];
  for (const pass of [points, [...points].reverse()]) {
    const startLength = hull.length;
    for (const p of pass) {
      while (hull.length >= startLength + 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
  }
  let best = 0,
    bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i],
      b = hull[(i + 1) % hull.length],
      angle = Math.atan2(b[1] - a[1], b[0] - a[0]),
      c = Math.cos(-angle),
      s = Math.sin(-angle);
    let u0 = Infinity,
      u1 = -Infinity,
      v0 = Infinity,
      v1 = -Infinity;
    for (const p of hull) {
      const u = c * p[0] - s * p[1],
        v = s * p[0] + c * p[1];
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < bestArea - 1e-12 * area) {
      bestArea = area;
      best = -angle + (v1 - v0 > u1 - u0 ? Math.PI / 2 : 0);
    }
  }
  return best;
}

/** Shelf-pack rectangles (texels) with `padding` between them and at the border; null when they do not fit. */
function shelfPack(sizes: [number, number][], order: number[], resolution: number, padding: number) {
  const at: [number, number][] = new Array(sizes.length);
  let x = 0,
    y = 0,
    shelf = 0;
  for (const i of order) {
    const [w, h] = sizes[i];
    if (w + 2 * padding > resolution) return null;
    if (x + w + 2 * padding > resolution) {
      y += shelf;
      x = 0;
      shelf = 0;
    }
    at[i] = [x + padding, y + padding];
    x += w + padding;
    shelf = Math.max(shelf, h + padding);
  }
  return y + shelf + padding <= resolution ? at : null;
}

/** Scale, rotate, pack and write charts; returns corner UVs per face and chart summaries. */
function place(
  mesh: PolygonMesh,
  charts: Chart[],
  pins: ReadonlyMap<number, Vec2>,
  resolution: number,
  padding: number,
  label: string,
) {
  const F = mesh.faces,
    P = mesh.vertices;
  // Unpinned and single-pin charts: rescale to true surface area and rotate to their smallest box.
  const area3 = charts.map((chart) => {
    let sum = 0;
    for (const f of chart.faces) {
      const n = [0, 0, 0],
        o = P[F[f].vertices[0]];
      for (let i = 1; i < F[f].vertices.length - 1; i++) {
        const b = P[F[f].vertices[i]],
          c = P[F[f].vertices[i + 1]],
          e = [b[0] - o[0], b[1] - o[1], b[2] - o[2]],
          g = [c[0] - o[0], c[1] - o[1], c[2] - o[2]];
        n[0] += e[1] * g[2] - e[2] * g[1];
        n[1] += e[2] * g[0] - e[0] * g[2];
        n[2] += e[0] * g[1] - e[1] * g[0];
      }
      sum += Math.hypot(n[0], n[1], n[2]) / 2;
    }
    return sum;
  });
  const boxes: [number, number, number, number][] = charts.map((chart, k) => {
    const uv = chart.uv;
    if (chart.pins < 2) {
      let twice = 0;
      chart.local.forEach((loop) => {
        for (let i = 1; i < loop.length - 1; i++) twice += uvTurn(uv, loop[0], loop[i], loop[i + 1]);
      });
      const s = twice > 0 ? Math.sqrt((2 * area3[k]) / twice) : 1,
        angle = bestRotation(uv),
        c = Math.cos(angle) * s,
        sn = Math.sin(angle) * s;
      for (let i = 0; i < uv.length; i += 2) {
        const u = uv[i],
          v = uv[i + 1];
        uv[i] = c * u - sn * v;
        uv[i + 1] = sn * u + c * v;
      }
    }
    let u0 = Infinity,
      v0 = Infinity,
      u1 = -Infinity,
      v1 = -Infinity;
    for (let i = 0; i < uv.length; i += 2) {
      u0 = Math.min(u0, uv[i]);
      u1 = Math.max(u1, uv[i]);
      v0 = Math.min(v0, uv[i + 1]);
      v1 = Math.max(v1, uv[i + 1]);
    }
    return [u0, v0, u1, v1];
  });
  let packed = charts.map((_, k) => k).filter((k) => charts[k].pins === 0);
  if (!packed.length) packed = charts.map((_, k) => k).filter((k) => charts[k].pins === 1);
  const order = [...packed].sort(
      (a, b) =>
        boxes[b][3] - boxes[b][1] - (boxes[a][3] - boxes[a][1]) ||
        boxes[b][2] - boxes[b][0] - (boxes[a][2] - boxes[a][0]) ||
        a - b,
    ),
    sizes: [number, number][] = charts.map(() => [0, 0]);
  const attempt = (s: number) => {
    for (const k of packed)
      sizes[k] = [
        Math.max(1, Math.ceil((boxes[k][2] - boxes[k][0]) * s)),
        Math.max(1, Math.ceil((boxes[k][3] - boxes[k][1]) * s)),
      ];
    return shelfPack(sizes, order, resolution, padding);
  };
  let largest = 0;
  for (const k of packed) largest = Math.max(largest, boxes[k][2] - boxes[k][0], boxes[k][3] - boxes[k][1]);
  let lo = 0,
    hi = packed.length ? (resolution - 2 * padding) / largest : 0,
    at = packed.length ? attempt(hi) : [];
  if (!at) {
    if (!attempt(1e-12 / (largest || 1)))
      throw new RangeError(
        `${label} has ${packed.length} charts, too many for ${resolution} texels with ${padding} padding; raise resolution, lower padding or angle-cut less.`,
      );
    lo = 1e-12 / (largest || 1);
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (attempt(mid)) lo = mid;
      else hi = mid;
    }
    at = attempt(lo)!;
    // The largest density that keeps every chart inside the texels it was given.
    hi = Infinity;
    for (const k of packed)
      hi = Math.min(hi, sizes[k][0] / (boxes[k][2] - boxes[k][0]), sizes[k][1] / (boxes[k][3] - boxes[k][1]));
  }
  const s = hi,
    corner: MutableVec2[][] = F.map((face) => face.vertices.map(() => [0, 0] as MutableVec2)),
    summaries: UVChart[] = [];
  const packedSet = new Set(charts[packed[0]]?.pins === 0 ? packed : []);
  charts.forEach((chart, k) => {
    const uv = chart.uv,
      out = new Float64Array(uv.length),
      [u0, , , v1] = boxes[k];
    if (packedSet.has(k)) {
      const [x, y] = at![k];
      for (let i = 0; i < uv.length; i += 2) {
        out[i] = (x + (uv[i] - u0) * s) / resolution;
        out[i + 1] = (y + (v1 - uv[i + 1]) * s) / resolution;
      }
    } else if (chart.pins === 1) {
      const anchor = chart.vertexOf.findIndex((v) => pins.has(v)),
        target = pins.get(chart.vertexOf[anchor])!;
      for (let i = 0; i < uv.length; i += 2) {
        out[i] = target[0] + ((uv[i] - uv[2 * anchor]) * s) / resolution;
        out[i + 1] = target[1] - ((uv[i + 1] - uv[2 * anchor + 1]) * s) / resolution;
      }
    } else for (let i = 0; i < uv.length; i += 2) [out[i], out[i + 1]] = [uv[i], -uv[i + 1]];
    for (let i = 0; i < out.length; i++)
      if (!(out[i] >= 0 && out[i] <= 1))
        throw new RangeError(`${label} pins put a chart outside the unit square; move the pins inward.`);
    let small = Infinity,
      large = 0,
      b0 = Infinity,
      b1 = Infinity,
      b2 = -Infinity,
      b3 = -Infinity;
    chart.faces.forEach((f, i) => {
      chart.local[i].forEach((l, c) => (corner[f][c] = [out[2 * l], out[2 * l + 1]]));
      const loop = chart.local[i];
      for (let t = 1; t < loop.length - 1; t++) {
        const a = P[chart.vertexOf[loop[0]]],
          b = P[chart.vertexOf[loop[t]]],
          c = P[chart.vertexOf[loop[t + 1]]],
          e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
          g = [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
          surface = Math.hypot(e[1] * g[2] - e[2] * g[1], e[2] * g[0] - e[0] * g[2], e[0] * g[1] - e[1] * g[0]),
          flat = Math.abs(uvTurn(out, loop[0], loop[t], loop[t + 1]));
        if (!(surface > 2e-12 * area3[k])) continue;
        const ratio = Math.sqrt(flat / surface);
        small = Math.min(small, ratio);
        large = Math.max(large, ratio);
      }
    });
    for (let i = 0; i < out.length; i += 2) {
      b0 = Math.min(b0, out[i]);
      b2 = Math.max(b2, out[i]);
      b1 = Math.min(b1, out[i + 1]);
      b3 = Math.max(b3, out[i + 1]);
    }
    summaries.push({
      faces: chart.faces.map((f) => F[f].id),
      pins: chart.pins,
      bounds: [b0, b1, b2, b3],
      area: area3[k],
      stretch: small > 0 && large > 0 ? large / small : 1,
    });
  });
  return { corner, summaries, texelsPerUnit: s };
}

/** Edges whose two corner UV pairs differ: the seams of a layout. */
function seamList(mesh: PolygonMesh, corner: MutableVec2[][]): string[] {
  const faceIndex = new Map(mesh.faces.map((face, i) => [face.id, i])),
    same = (a: MutableVec2, b: MutableVec2) => a[0] === b[0] && a[1] === b[1],
    out: string[] = [];
  for (const edge of collectPolygonEdges(mesh)) {
    if (edge.incidences.length < 2) continue;
    if (edge.incidences.length > 2) {
      out.push(edge.id);
      continue;
    }
    const [p, q] = edge.incidences,
      f = faceIndex.get(p.faceId)!,
      g = faceIndex.get(q.faceId)!,
      nf = mesh.faces[f].vertices.length,
      ng = mesh.faces[g].vertices.length,
      flipped = q.from === p.from,
      gFrom = flipped ? q.corner : (q.corner + 1) % ng,
      gTo = flipped ? (q.corner + 1) % ng : q.corner;
    if (!same(corner[f][p.corner], corner[g][gFrom]) || !same(corner[f][(p.corner + 1) % nf], corner[g][gTo]))
      out.push(edge.id);
  }
  return out.sort();
}

/**
 * Unwrap a mesh into a fresh UV layout: cut it into charts along `seams`, borders and edges sharper than `angle`,
 * flatten each chart with least squares conformal maps (Lévy et al., 2002), split any chart that is not a disk or
 * that would fold or overlap itself until none does, then rotate each to its smallest box and shelf-pack them in the
 * unit square with `padding` texels around each at `resolution`, at one texel density for all. Pinned charts keep the
 * pins' placement. Positions, faces and IDs are unchanged; input UVs may be missing (draft) and are ignored.
 * @throws TypeError for bad structure, options, seams or pins; RangeError for a bad angle, resolution or padding,
 * pins outside the unit square or too many charts for the resolution; the signal's reason when aborted.
 */
export function unwrapMesh(mesh: PolygonMesh, options: UnwrapOptions = {}): UnwrapResult {
  const resolution = options?.resolution ?? 1024,
    padding = options?.padding ?? 4,
    angle = validate(mesh, options, 'Unwrap', resolution, padding),
    pins = new Map<number, Vec2>();
  if (options.pins !== undefined) {
    if (!Array.isArray(options.pins))
      throw new TypeError('Unwrap pins need an array of { vertex, uv }; supply pins or omit them.');
    for (const pin of options.pins) {
      if (
        !pin ||
        !Number.isInteger(pin.vertex) ||
        pin.vertex < 0 ||
        pin.vertex >= mesh.vertices.length ||
        !Array.isArray(pin.uv) ||
        !pin.uv.every((x: unknown) => typeof x === 'number' && x >= 0 && x <= 1)
      )
        throw new TypeError('Unwrap pins need an existing vertex index and a uv pair from 0 to 1; repair the pin.');
      pins.set(pin.vertex, [pin.uv[0], pin.uv[1]]);
    }
  }
  options.signal?.throwIfAborted();
  const { charts, diagnostics } = layout(mesh, angle, options.seams ?? [], pins, 'Unwrap', options.signal),
    { corner, summaries, texelsPerUnit } = place(mesh, charts, pins, resolution, padding, 'Unwrap'),
    output: PolygonMesh = {
      vertices: mesh.vertices.map((p) => [p[0], p[1], p[2]]),
      faces: mesh.faces.map((face, f) => ({ id: face.id, vertices: [...face.vertices], uv: corner[f] })),
    };
  assertPolygonMesh(output);
  return { mesh: output, charts: summaries, seams: seamList(mesh, corner), texelsPerUnit, diagnostics };
}

/**
 * Lightmap UVs: a second UV set where every chart has its own texels. Charts are cut and flattened as in
 * {@link unwrapMesh} (no pins), every chart gets the same texel density, starts on a texel corner and keeps
 * `padding` empty texels to its neighbors and the atlas border at `resolution`, so bilinear filtering never bleeds.
 * The mesh is not changed; pair `uv` with its faces when exporting (for example as glTF `TEXCOORD_1`).
 * @throws as {@link unwrapMesh}.
 */
export function meshLightmapUVs(mesh: PolygonMesh, options: ChartOptions = {}): LightmapUVResult {
  const resolution = options?.resolution ?? 256,
    padding = options?.padding ?? 2,
    angle = validate(mesh, options, 'Lightmap UVs', resolution, padding);
  options.signal?.throwIfAborted();
  const none = new Map<number, Vec2>(),
    { charts } = layout(mesh, angle, options.seams ?? [], none, 'Lightmap UVs', options.signal),
    { corner, summaries, texelsPerUnit } = place(mesh, charts, none, resolution, padding, 'Lightmap UVs');
  return { uv: corner, charts: summaries, seams: seamList(mesh, corner), texelsPerUnit, resolution };
}
