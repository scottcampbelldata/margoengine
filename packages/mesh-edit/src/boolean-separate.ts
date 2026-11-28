// Takes out the places where rounding an exact boolean's result left triangles crossing. Rounding each corner on its own
// moves it past faces that were closer than a float step, which a snap rounding prevents by joining such features:
// J. D. Hobby, "Practical segment intersection with finite precision output", Computational Geometry 13, 1999, in the
// plane, and D. Halperin and E. Packer, "Iterated snap rounding", Computational Geometry 23, 2002,
// https://doi.org/10.1016/S0925-7721(01)00064-5, which repeats it until features are apart. In 3D a rounding with no
// new intersection exists (O. Devillers, S. Lazard and W. Lenhart, "Rounding meshes in 3D", Discrete and Computational
// Geometry 64, 2020, https://doi.org/10.1007/s00454-020-00202-2) at a size far above the input's, so L. Valque and
// S. Lazard, "Resolving self-intersections in 3D meshes while preserving floating-point coordinates", Computer Graphics
// Forum 44, 2025, https://doi.org/10.1111/cgf70192, round, find the new crossings and repeat. This module does the same
// kind of loop with local mesh edits, which keep the surface closed: for each crossing pair, corners within a reach
// join, a corner within it of an edge or face of the other triangle is put into that edge or face, and edges passing
// within it are both split at a shared point; the reach doubles until no pair crosses or it comes to its limit.
import type { MutableVec2, MutableVec3 } from '@margoengine/math';
import type { BooleanLoop } from './boolean.js';
import { withoutFlatTriangles } from './flat-triangles.js';
import { crossingTriangles } from './self-intersections.js';

/** The first reach, as a share of the largest coordinate of the two triangles: one to two float32 steps. */
const FIRST_REACH = 2 ** -23;
/** Reaches tried, each twice the one before: the last is 2^-16 of the coordinates. */
const REACHES = 8;
/** Edits at one reach while the number of crossing pairs falls. */
const PASSES = 4;

type Point = readonly number[];
const minus = (a: Point, b: Point): number[] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point, b: Point): number[] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const mix = (a: MutableVec2, b: MutableVec2, t: number): MutableVec2 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/** A corner to put into an edge (`other` two corners) or a face (three), `off` away from it. */
interface Insert {
  v: number;
  other: number[];
  off: number;
}

/** Two edges passing each other, and the point both are split at. */
interface Crossed {
  edges: [number, number, number, number];
  point: MutableVec3;
  off: number;
}

/** The triangles with `v` put into the edge from `p` to `q`, on every face of that edge. */
function splitEdge(
  triangles: readonly BooleanLoop[],
  vertices: readonly MutableVec3[],
  p: number,
  q: number,
  v: number,
): BooleanLoop[] {
  const out: BooleanLoop[] = [];
  for (const triangle of triangles) {
    const { vertices: t, uv } = triangle,
      e = [0, 1, 2].find((k) => (t[k] === p && t[(k + 1) % 3] === q) || (t[k] === q && t[(k + 1) % 3] === p));
    if (e === undefined) {
      out.push(triangle);
      continue;
    }
    const [i, j, k] = [e, (e + 1) % 3, (e + 2) % 3];
    // A face with the point as its third corner folds onto the edge's two halves and goes.
    if (t[k] === v) continue;
    const d = minus(vertices[t[j]], vertices[t[i]]),
      at = Math.min(1, Math.max(0, dot(minus(vertices[v], vertices[t[i]]), d) / dot(d, d))) || 0,
      between = mix(uv[i], uv[j], at);
    out.push(
      { ...triangle, vertices: [t[i], v, t[k]], uv: [uv[i], between, uv[k]] },
      { ...triangle, vertices: [v, t[j], t[k]], uv: [[between[0], between[1]], uv[j], [uv[k][0], uv[k][1]]] },
    );
  }
  return out;
}

/** One round of edits at `reach` for the crossing `pairs`. */
function edit(
  start: BooleanLoop[],
  vertices: MutableVec3[],
  pairs: readonly [number, number][],
  share: number,
  pointOf: (point: MutableVec3) => number,
): BooleanLoop[] {
  const parent = new Map<number, number>(),
    find = (v: number): number => {
      let root = v;
      while (parent.has(root)) root = parent.get(root)!;
      return root;
    },
    inserts: Insert[] = [],
    crossed: Crossed[] = [];
  for (const [i, j] of pairs) {
    const first = start[i].vertices,
      second = start[j].vertices,
      six = [...new Set([...first, ...second])];
    let size = 0;
    for (const v of six) for (const x of vertices[v]) size = Math.max(size, Math.abs(x));
    const reach = size * share;
    for (let a = 0; a < six.length; a++)
      for (let b = a + 1; b < six.length; b++) {
        if (Math.hypot(...minus(vertices[six[a]], vertices[six[b]])) > reach) continue;
        const x = find(six[a]),
          y = find(six[b]);
        if (x !== y) parent.set(Math.max(x, y), Math.min(x, y));
      }
    for (const [from, onto] of [
      [first, second],
      [second, first],
    ]) {
      const [A, B, C] = onto.map((v) => vertices[v]),
        normal = cross(minus(B, A), minus(C, A)),
        length = Math.hypot(...normal);
      for (const v of from) {
        if (onto.includes(v)) continue;
        const P = vertices[v];
        for (let e = 0; e < 3; e++) {
          const p = onto[e],
            q = onto[(e + 1) % 3],
            d = minus(vertices[q], vertices[p]),
            r = minus(P, vertices[p]),
            at = dot(r, d) / dot(d, d);
          if (!(at > 0 && at < 1)) continue;
          const off = Math.hypot(r[0] - at * d[0], r[1] - at * d[1], r[2] - at * d[2]);
          if (off <= reach) inserts.push({ v, other: [p, q], off });
        }
        const off = Math.abs(dot(minus(P, A), normal)) / length;
        if (
          off <= reach &&
          [
            [A, B],
            [B, C],
            [C, A],
          ].every(([x, y]) => dot(cross(minus(y, x), minus(P, x)), normal) > 0)
        )
          inserts.push({ v, other: [...onto], off });
      }
    }
    for (let e = 0; e < 3; e++)
      for (let f = 0; f < 3; f++) {
        const edges: Crossed['edges'] = [first[e], first[(e + 1) % 3], second[f], second[(f + 1) % 3]];
        if (new Set(edges).size < 4) continue;
        const [a, b, c, d] = edges.map((v) => vertices[v]),
          u = minus(b, a),
          w = minus(d, c),
          r = minus(a, c),
          uu = dot(u, u),
          uw = dot(u, w),
          ww = dot(w, w),
          det = uu * ww - uw * uw;
        // Parallel edges meet at a corner, which the corner and edge cases above take.
        if (!(det > 1e-12 * uu * ww)) continue;
        const s = (uw * dot(w, r) - ww * dot(u, r)) / det,
          t = (uu * dot(w, r) - uw * dot(u, r)) / det;
        if (!(s > 0 && s < 1 && t > 0 && t < 1)) continue;
        const near = a.map((x, k) => x + s * u[k]),
          far = c.map((x, k) => x + t * w[k]),
          off = Math.hypot(...minus(near, far));
        if (off <= reach)
          crossed.push({ edges, off, point: near.map((x, k) => Math.fround((x + far[k]) / 2) + 0) as MutableVec3 });
      }
  }
  let triangles: BooleanLoop[] = [];
  for (const triangle of start) {
    const mapped = triangle.vertices.map(find);
    if (new Set(mapped).size === 3) triangles.push({ ...triangle, vertices: mapped });
  }
  // The nearest first; a feature an earlier edit removed no longer matches and is found again in the next round.
  for (const { v: raw, other } of inserts.sort((a, b) => a.off - b.off)) {
    const v = find(raw),
      corners = other.map(find);
    if (corners.includes(v)) continue;
    if (corners.length === 2) {
      triangles = splitEdge(triangles, vertices, corners[0], corners[1], v);
      continue;
    }
    const at = triangles.findIndex((t) => corners.every((c) => t.vertices.includes(c)));
    if (at < 0 || triangles[at].vertices.includes(v)) continue;
    const triangle = triangles[at],
      { vertices: t, uv } = triangle,
      [A, B, C] = t.map((c) => vertices[c]),
      u = minus(B, A),
      w = minus(C, A),
      r = minus(vertices[v], A),
      uu = dot(u, u),
      uw = dot(u, w),
      ww = dot(w, w),
      det = uu * ww - uw * uw,
      s = (ww * dot(u, r) - uw * dot(w, r)) / det || 0,
      q = (uu * dot(w, r) - uw * dot(u, r)) / det || 0,
      middle: MutableVec2 = [0, 1].map((k) => uv[0][k] + (uv[1][k] - uv[0][k]) * s + (uv[2][k] - uv[0][k]) * q) as [
        number,
        number,
      ];
    triangles.splice(
      at,
      1,
      ...[0, 1, 2].map((k) => ({
        ...triangle,
        vertices: [t[k], t[(k + 1) % 3], v],
        uv: [uv[k], uv[(k + 1) % 3], [middle[0], middle[1]] as MutableVec2],
      })),
    );
  }
  const used = new Set<number>();
  for (const { edges, point } of crossed.sort((a, b) => a.off - b.off)) {
    const [a, b, c, d] = edges.map(find);
    if (new Set([a, b, c, d]).size < 4 || [a, b, c, d].some((v) => used.has(v))) continue;
    const joined = (p: number, q: number): boolean =>
      triangles.some((t) => t.vertices.includes(p) && t.vertices.includes(q));
    if (!joined(a, b) || !joined(c, d)) continue;
    const v = pointOf(point);
    if ([a, b, c, d].includes(v)) continue;
    for (const k of [a, b, c, d]) used.add(k);
    triangles = splitEdge(splitEdge(triangles, vertices, a, b, v), vertices, c, d, v);
  }
  return triangles;
}

/**
 * Closed `triangles` with their crossing pairs edited away, and the number of pairs still crossing (0 unless the edits
 * cannot join features within the last reach, as with sheets that rounding put into one plane). `clean` removes what an edit leaves behind, such as fins of no thickness.
 * `vertices` gains the points where two edges were joined.
 */
export function withoutCrossings(
  start: BooleanLoop[],
  vertices: MutableVec3[],
  grain: number,
  clean: (triangles: BooleanLoop[]) => BooleanLoop[],
  tick: () => void,
): { loops: BooleanLoop[]; crossings: number } {
  const pairsOf = (triangles: readonly BooleanLoop[]): [number, number][] =>
    crossingTriangles(
      vertices,
      triangles.map((t) => t.vertices),
      undefined,
      tick,
    );
  let loops = start,
    pairs = pairsOf(loops);
  if (!pairs.length) return { loops, crossings: 0 };
  let ids: Map<string, number> | undefined;
  const pointOf = (point: MutableVec3): number => {
    ids ??= new Map(vertices.map((p, i) => [`${p}`, i]));
    let v = ids.get(`${point}`);
    if (v === undefined) {
      v = vertices.length;
      ids.set(`${point}`, v);
      vertices.push(point);
    }
    return v;
  };
  // An edit can add pairs where sheets lie in one plane, so the state with the fewest is the one returned.
  let best = { loops, crossings: pairs.length };
  for (let level = 0; pairs.length && level < REACHES; level++)
    for (let pass = 0; pairs.length && pass < PASSES; pass++) {
      tick();
      const edited = edit(loops, vertices, pairs, FIRST_REACH * 2 ** level, pointOf),
        faces = edited.map(({ vertices: corners, uv }, i) => ({ id: String(i), vertices: corners, uv })),
        { mesh, origin } = withoutFlatTriangles({ vertices, faces }, grain),
        before = pairs.length;
      loops = clean(
        mesh.faces.map(({ id, vertices: corners, uv }) => ({
          ...edited[Number(origin?.get(id) ?? id)],
          vertices: corners,
          uv,
        })),
      );
      pairs = pairsOf(loops);
      if (pairs.length < best.crossings) best = { loops, crossings: pairs.length };
      if (pairs.length >= before) break;
    }
  return best;
}
