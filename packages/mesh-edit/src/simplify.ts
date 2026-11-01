import type { MutableVec2, MutableVec3 } from '@margoengine/math';
import { assertOptions } from './edit-support.js';
import { assertPolygonMesh, collectPolygonEdges, polygonGeometryError } from './polygon.js';
import { faceIdFactory } from './result.js';
import type { PolygonFace, PolygonMesh } from './types.js';

/** Options for {@link simplifyMesh}. */
export interface SimplifyOptions {
  /** Keep this fraction of the triangles, 0 to 1 (default 0.5). Ignored when `targetTriangles` is given. */
  ratio?: number;
  /** Stop at this many triangles (or fewer only when nothing more can be collapsed). */
  targetTriangles?: number;
  /** Stop before any collapse whose quadric error (squared distance, local units) exceeds this. Default: no limit. */
  maxError?: number;
  /** Merge coplanar triangles of the same source face back into convex polygons (default true). */
  mergeCoplanar?: boolean;
  /** Face ID generator for faces beyond the first piece of each source face (default `crypto.randomUUID`). */
  createId?: () => string;
  /** Checked as the work goes; aborting throws the signal's reason. */
  signal?: AbortSignal;
}

/** Result of {@link simplifyMesh}. */
export interface SimplifyResult {
  mesh: PolygonMesh;
  /** Input triangle count (faces fanned) and output triangle count. */
  triangles: { before: number; after: number };
  /** Largest quadric error of any collapse made (squared local units). */
  error: number;
  /** For each input face ID, the output faces that carry it on (empty when collapsed away). */
  faceMap: Record<string, string[]>;
  /** For each output vertex, the input vertex it is (collapses keep one end, so positions are input positions). */
  sourceVertices: number[];
}

type Quadric = Float64Array; // 10 terms of the symmetric 4x4 plane quadric

const addPlane = (q: Quadric, a: number, b: number, c: number, d: number, w: number) => {
  q[0] += w * a * a;
  q[1] += w * a * b;
  q[2] += w * a * c;
  q[3] += w * a * d;
  q[4] += w * b * b;
  q[5] += w * b * c;
  q[6] += w * b * d;
  q[7] += w * c * c;
  q[8] += w * c * d;
  q[9] += w * d * d;
};
const evaluate = (q: Quadric, p: readonly number[]) => {
  const [x, y, z] = p;
  return (
    q[0] * x * x +
    2 * q[1] * x * y +
    2 * q[2] * x * z +
    2 * q[3] * x +
    q[4] * y * y +
    2 * q[5] * y * z +
    2 * q[6] * y +
    q[7] * z * z +
    2 * q[8] * z +
    q[9]
  );
};

/** Binary min-heap of collapse candidates. */
class Heap {
  items: { cost: number; from: number; to: number; su: number; sv: number }[] = [];
  push(item: Heap['items'][number]) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items,
      top = a[0],
      last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Simplify a mesh by quadric error edge collapses (Garland and Heckbert, 1997). Faces are fanned into triangles,
 * then the cheapest collapse is applied until `targetTriangles` (or `ratio` of the input) is reached. Each collapse
 * moves one end of an edge onto the other (the paper's vertex-subset placement), so every output position is an
 * input position and every corner UV an input UV: no texture swims. Open borders and UV seams are kept: a border or
 * seam vertex may only slide along its own border or seam, corners where seams meet never move, and border edges
 * add the paper's perpendicular constraint planes. Collapses that would fold a triangle, flip its UVs, pinch the
 * surface (the link condition) or leave a sliver are skipped. Coplanar triangles of one source face are merged back
 * into convex polygons. Works on meshes whose edges have at most two consistently wound faces.
 * @throws RangeError for a ratio outside 0 to 1, a negative target or a bad maxError; TypeError for bad options or
 * nonmanifold or inconsistently wound edges; the signal's reason when aborted.
 */
export function simplifyMesh(mesh: PolygonMesh, options: SimplifyOptions = {}): SimplifyResult {
  assertPolygonMesh(mesh);
  assertOptions(options, 'Simplify');
  const ratio = options.ratio ?? 0.5;
  if (typeof ratio !== 'number' || !(ratio >= 0 && ratio <= 1))
    throw new RangeError('Simplify ratio must be from 0 to 1; choose the fraction of triangles to keep.');
  if (
    options.targetTriangles !== undefined &&
    !(Number.isInteger(options.targetTriangles) && options.targetTriangles >= 0)
  )
    throw new RangeError('Simplify targetTriangles must be a whole number of zero or more; choose a triangle budget.');
  const maxError = options.maxError ?? Infinity;
  if (typeof maxError !== 'number' || Number.isNaN(maxError) || maxError < 0)
    throw new RangeError('Simplify maxError must be zero or more; choose a squared distance or omit it.');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw new TypeError('Simplify signal must be an AbortSignal; pass controller.signal or omit it.');
  for (const edge of collectPolygonEdges(mesh)) {
    if (edge.incidences.length > 2)
      throw new TypeError('Simplify needs manifold edges; repair edges with more than two incident faces.');
    if (edge.incidences.length === 2) {
      const [p, q] = edge.incidences;
      if (p.from !== q.to || p.to !== q.from)
        throw new TypeError('Simplify needs consistent face winding; orient neighboring faces consistently.');
    }
  }
  const signal = options.signal;
  signal?.throwIfAborted();
  const P = mesh.vertices,
    // Triangles: corners (vertex indices), corner UVs and the source face.
    tv: number[][] = [],
    tuv: MutableVec2[][] = [],
    tface: number[] = [],
    alive: boolean[] = [];
  mesh.faces.forEach((face, f) => {
    for (let c = 1; c < face.vertices.length - 1; c++) {
      tv.push([face.vertices[0], face.vertices[c], face.vertices[c + 1]]);
      tuv.push([face.uv[0], face.uv[c], face.uv[c + 1]].map((uv) => [uv[0], uv[1]] as MutableVec2));
      tface.push(f);
      alive.push(true);
    }
  });
  const before = tv.length,
    target = Math.min(before, options.targetTriangles ?? Math.round(before * ratio));
  const around: Set<number>[] = P.map(() => new Set());
  tv.forEach((t, i) => {
    for (const v of t) around[v].add(i);
  });
  const sameUV = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1];
  const cornerUV = (t: number, v: number) => tuv[t][tv[t].indexOf(v)];
  /** Triangles on edge u-v. */
  const edgeTriangles = (u: number, v: number) => [...around[u]].filter((t) => tv[t].includes(v));
  /** An edge is a border (one triangle) or a seam (its two triangles disagree on UVs at either end). */
  const isFeature = (u: number, v: number) => {
    const ts = edgeTriangles(u, v);
    if (ts.length !== 2) return true;
    return !sameUV(cornerUV(ts[0], u), cornerUV(ts[1], u)) || !sameUV(cornerUV(ts[0], v), cornerUV(ts[1], v));
  };
  const neighbors = (u: number) => {
    const out = new Set<number>();
    for (const t of around[u]) for (const w of tv[t]) if (w !== u) out.add(w);
    return out;
  };
  const featureEdges = (u: number) => [...neighbors(u)].filter((w) => isFeature(u, w));
  // Quadrics: area-weighted face planes, plus heavy perpendicular planes along borders and seams.
  const Q: Quadric[] = P.map(() => new Float64Array(10));
  const normalOf = (a: readonly number[], b: readonly number[], c: readonly number[]) => {
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2],
      vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  let scale = 0;
  for (const p of P) for (let k = 0; k < 3; k++) scale = Math.max(scale, Math.abs(p[k]));
  const tiny = (scale || 1) ** 2 * 1e-18;
  tv.forEach(([a, b, c]) => {
    const n = normalOf(P[a], P[b], P[c]),
      l = Math.hypot(n[0], n[1], n[2]);
    if (!(l > 0)) return;
    const nx = n[0] / l,
      ny = n[1] / l,
      nz = n[2] / l,
      d = -(nx * P[a][0] + ny * P[a][1] + nz * P[a][2]);
    for (const v of [a, b, c]) addPlane(Q[v], nx, ny, nz, d, l / 2);
  });
  const handled = new Set<string>();
  for (let u = 0; u < P.length; u++)
    for (const w of featureEdges(u)) {
      const key = u < w ? `${u}:${w}` : `${w}:${u}`;
      if (handled.has(key)) continue;
      handled.add(key);
      for (const t of edgeTriangles(u, w)) {
        const [a, b, c] = tv[t],
          n = normalOf(P[a], P[b], P[c]),
          e = [P[w][0] - P[u][0], P[w][1] - P[u][1], P[w][2] - P[u][2]],
          m = [e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0]],
          l = Math.hypot(m[0], m[1], m[2]);
        if (!(l > 0)) continue;
        const nx = m[0] / l,
          ny = m[1] / l,
          nz = m[2] / l,
          d = -(nx * P[u][0] + ny * P[u][1] + nz * P[u][2]),
          w2 = 1000 * (e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
        addPlane(Q[u], nx, ny, nz, d, w2);
        addPlane(Q[w], nx, ny, nz, d, w2);
      }
    }
  // A vertex may move only along a feature edge when it lies on features: exactly two feature edges (a border or
  // seam runs through it) and the collapse follows one of them. Feature corners never move.
  const canMove = (u: number, v: number): boolean => {
    const features = featureEdges(u);
    if (!features.length) return true;
    return features.length === 2 && features.includes(v);
  };
  const stamp = new Int32Array(P.length),
    heap = new Heap(),
    removed = new Uint8Array(P.length);
  const consider = (u: number) => {
    for (const v of neighbors(u)) {
      if (!canMove(u, v)) continue;
      heap.push({ cost: evaluate(Q[u], P[v]) + evaluate(Q[v], P[v]), from: u, to: v, su: stamp[u], sv: stamp[v] });
    }
  };
  for (let u = 0; u < P.length; u++) if (around[u].size) consider(u);
  let triangles = before,
    error = 0,
    steps = 0;
  /** Check and apply the collapse u -> v; false when it would break the mesh. */
  const collapse = (u: number, v: number): boolean => {
    const shared = edgeTriangles(u, v);
    if (!shared.length) return false;
    // Link condition: the only common neighbors are the opposite corners of the shared triangles.
    const nu = neighbors(u),
      nv = neighbors(v),
      opposite = new Set(shared.flatMap((t) => tv[t].filter((w) => w !== u && w !== v)));
    for (const w of nu) if (w !== v && nv.has(w) && !opposite.has(w)) return false;
    // UV for v in each of u's triangles: the triangle's own UV island's UV at v.
    const replacement = new Map<number, MutableVec2>(),
      fan = [...around[u]].filter((t) => !shared.includes(t));
    const islands = new Map<number, number>(),
      parent = new Map<number, number>();
    const find = (t: number): number => {
      while (parent.get(t) !== t) t = parent.get(t)!;
      return t;
    };
    for (const t of around[u]) parent.set(t, t);
    for (const t of around[u])
      for (const s of around[u]) {
        if (s <= t) continue;
        const common = tv[t].filter((w) => w !== u && tv[s].includes(w));
        for (const w of common)
          if (sameUV(cornerUV(t, u), cornerUV(s, u)) && sameUV(cornerUV(t, w), cornerUV(s, w)))
            parent.set(find(s), find(t));
      }
    for (const t of shared) islands.set(find(t), t);
    for (const t of fan) {
      const source = islands.get(find(t));
      if (source === undefined) return false; // a UV island of u that does not reach v
      replacement.set(t, [...cornerUV(source, v)] as MutableVec2);
    }
    // Geometry and UV checks on the moved triangles.
    for (const t of fan) {
      const corners = tv[t].map((w) => (w === u ? v : w)),
        before = normalOf(P[tv[t][0]], P[tv[t][1]], P[tv[t][2]]),
        after = normalOf(P[corners[0]], P[corners[1]], P[corners[2]]),
        la = Math.hypot(after[0], after[1], after[2]),
        lb = Math.hypot(before[0], before[1], before[2]);
      if (!(la > tiny) || after[0] * before[0] + after[1] * before[1] + after[2] * before[2] <= 0.2 * la * lb)
        return false;
      // Corners a hair apart (a sphere's pole, unwelded by float noise) pass the area test, and the validator refuses them.
      if (polygonGeometryError(corners.map((w) => P[w]))) return false;
      const uv = tv[t].map((w, k) => (w === u ? replacement.get(t)! : tuv[t][k])),
        oldUV = tuv[t],
        cross = (x: readonly number[][]) =>
          (x[1][0] - x[0][0]) * (x[2][1] - x[0][1]) - (x[1][1] - x[0][1]) * (x[2][0] - x[0][0]);
      const ca = cross(uv),
        cb = cross(oldUV);
      if (cb !== 0 && !(ca * cb > 0)) return false;
    }
    for (const t of shared) {
      alive[t] = false;
      for (const w of tv[t]) around[w].delete(t);
      triangles--;
    }
    for (const t of fan) {
      const k = tv[t].indexOf(u);
      tv[t][k] = v;
      tuv[t][k] = replacement.get(t)!;
      around[u].delete(t);
      around[v].add(t);
    }
    removed[u] = 1;
    for (let k = 0; k < 10; k++) Q[v][k] += Q[u][k];
    return true;
  };
  while (triangles > target && heap.items.length) {
    if (signal && ++steps % 256 === 0) signal.throwIfAborted();
    const item = heap.pop();
    if (removed[item.from] || removed[item.to] || item.su !== stamp[item.from] || item.sv !== stamp[item.to]) continue;
    if (item.cost > maxError) break;
    if (!canMove(item.from, item.to) || !collapse(item.from, item.to)) continue;
    error = Math.max(error, item.cost);
    stamp[item.to]++;
    for (const w of neighbors(item.to)) stamp[w]++;
    consider(item.to);
    for (const w of neighbors(item.to)) consider(w);
  }
  // Output: compact used vertices, merge coplanar triangles of one source face, name faces.
  const remap = new Map<number, number>(),
    vertices: MutableVec3[] = [],
    sourceVertices: number[] = [];
  const index = (v: number) => {
    let i = remap.get(v);
    if (i === undefined) {
      i = vertices.length;
      remap.set(v, i);
      vertices.push([...P[v]] as MutableVec3);
      sourceVertices.push(v);
    }
    return i;
  };
  const groups = new Map<number, { vertices: number[]; uv: MutableVec2[] }[]>();
  tv.forEach((t, i) => {
    if (!alive[i]) return;
    const list = groups.get(tface[i]) ?? [];
    list.push({ vertices: t.map(index), uv: tuv[i].map((uv) => [...uv] as MutableVec2) });
    groups.set(tface[i], list);
  });
  const createId = faceIdFactory(mesh, { createId: options.createId }),
    faces: PolygonFace[] = [],
    faceMap: Record<string, string[]> = Object.fromEntries(mesh.faces.map((face) => [face.id, []]));
  for (const [f, list] of [...groups].sort((a, b) => a[0] - b[0])) {
    const merged = options.mergeCoplanar === false ? list : mergePieces(list, vertices);
    merged.forEach((piece, k) => {
      const id = k === 0 ? mesh.faces[f].id : createId();
      faces.push({ id, vertices: piece.vertices, uv: piece.uv });
      faceMap[mesh.faces[f].id].push(id);
    });
  }
  const output: PolygonMesh = { vertices, faces };
  assertPolygonMesh(output);
  return { mesh: output, triangles: { before, after: triangles }, error, faceMap, sourceVertices };
}

/** Greedy merge of triangles across shared edges with continuous UVs while the union is a valid convex face. */
function mergePieces(
  list: { vertices: number[]; uv: MutableVec2[] }[],
  vertices: MutableVec3[],
): { vertices: number[]; uv: MutableVec2[] }[] {
  const pieces: ({ vertices: number[]; uv: MutableVec2[] } | null)[] = [...list];
  let changed = pieces.length > 1;
  while (changed) {
    changed = false;
    const owner = new Map<string, number>();
    pieces.forEach((piece, p) => {
      if (piece)
        piece.vertices.forEach((v, i) => owner.set(`${v}>${piece.vertices[(i + 1) % piece.vertices.length]}`, p));
    });
    for (let p = 0; p < pieces.length && !changed; p++) {
      const piece = pieces[p];
      if (!piece) continue;
      for (let i = 0; i < piece.vertices.length; i++) {
        const n = piece.vertices.length,
          x = piece.vertices[i],
          y = piece.vertices[(i + 1) % n],
          q = owner.get(`${y}>${x}`);
        if (q === undefined || q === p) continue;
        const other = pieces[q]!,
          j = other.vertices.indexOf(x),
          k = other.vertices.indexOf(y),
          same = (a: MutableVec2, b: MutableVec2) => a[0] === b[0] && a[1] === b[1];
        if (!same(piece.uv[i], other.uv[j]) || !same(piece.uv[(i + 1) % n], other.uv[k])) continue;
        const start = (i + 1) % n,
          rotate = <T>(items: T[], at: number) => [...items.slice(at), ...items.slice(0, at)],
          verts = [...rotate(piece.vertices, start), ...rotate(other.vertices, j).slice(1, -1)],
          uv = [...rotate(piece.uv, start), ...rotate(other.uv, j).slice(1, -1)];
        if (verts.length > 64 || new Set(verts).size !== verts.length) continue;
        if (polygonGeometryError(verts.map((v) => vertices[v]))) continue;
        pieces[p] = { vertices: verts, uv };
        pieces[q] = null;
        changed = true;
        break;
      }
    }
  }
  return pieces.filter((piece): piece is { vertices: number[]; uv: MutableVec2[] } => piece !== null);
}

/** Options for {@link meshLODChain}. */
export interface LODChainOptions extends Omit<SimplifyOptions, 'ratio' | 'targetTriangles'> {
  /** Fraction of the input's triangles each level keeps, decreasing (default [0.5, 0.25, 0.125]). */
  ratios?: readonly number[];
}

/**
 * A chain of levels of detail: each level simplifies the previous one (so levels nest and seams stay identical) to
 * its fraction of the input's triangles. Level 0 of the returned list is the first ratio, not the input.
 * @throws RangeError for ratios that are not decreasing within 0 to 1; as {@link simplifyMesh} otherwise.
 */
export function meshLODChain(mesh: PolygonMesh, options: LODChainOptions = {}): SimplifyResult[] {
  assertOptions(options, 'LOD chain');
  const ratios = options.ratios ?? [0.5, 0.25, 0.125];
  if (
    !Array.isArray(ratios) ||
    !ratios.length ||
    ratios.some((r, i) => !(r > 0 && r <= 1) || (i && r >= ratios[i - 1]))
  )
    throw new RangeError('LOD ratios must decrease within (0, 1]; for example [0.5, 0.25, 0.125].');
  let fanned = 0;
  for (const face of mesh.faces) fanned += face.vertices.length - 2;
  const out: SimplifyResult[] = [];
  let current = mesh;
  for (const ratio of ratios) {
    const result = simplifyMesh(current, { ...options, targetTriangles: Math.round(fanned * ratio) });
    out.push(result);
    current = result.mesh;
  }
  return out;
}
