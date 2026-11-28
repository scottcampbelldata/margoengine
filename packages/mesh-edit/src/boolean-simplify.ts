// Takes out of an exact boolean's result the points its trees cut that are no corner of the solid, before anything is
// rounded: a point inside one input triangle's part of the surface, and a point on a straight edge between two such
// parts. A BSP tree cuts faces along planes of faces far from them, so these points can lie a few float steps from a
// real corner and become needles and caps once rounded. Vertex removal with a local retriangulation follows Schroeder,
// Zarge and Lorensen, "Decimation of triangle meshes", SIGGRAPH 1992 (https://doi.org/10.1145/142920.134010), here
// with exact tests only, so the surface stays the same point set; ears are clipped fattest first (Meisters, "Polygons
// have ears", American Mathematical Monthly 82, 1975, https://doi.org/10.2307/2319703). Cleaning an exact result before
// it is rounded is the order Lévy, "Exact predicates, exact constructions and combinatorics for mesh CSG", 2024
// (https://arxiv.org/abs/2405.12949), and Milenkovic and Sacks, "Geometric rounding and feature separation in meshes",
// Computer-Aided Design 108, 2019 (https://doi.org/10.1016/j.cad.2018.10.003), argue for.

/** A face of the exact result: its corners as exact point IDs, and the input triangle it lies in. */
interface Fragment<S> {
  ids: number[];
  source: S;
}

/** The part of the star of one point that lies in one input triangle, as one polygon without that point. */
interface Part<S> {
  source: S;
  ids: number[];
  /** Which way the part turns in its projection: 1 or -1. */
  turn: number;
}

/** Points are removed in passes until one changes nothing; a removal can free its neighbors for the next pass. */
const MAX_PASSES = 16;
/** A bound on a float orientation's error as a share of the largest coordinate times the edge lengths: over 2^-49. */
const FILTER = 4e-15;

/**
 * `loops` (closed, every edge matched by its reverse) with every needless point gone, as the same surface. `exact` holds
 * homogeneous integer points (X, Y, Z, W) with W > 0, and `source.axis` names the axis a triangle is projected along.
 * A point whose faces cannot be retriangulated, or where the surface touches itself, is kept.
 */
export function withoutCutPoints<S extends { axis: number }>(
  loops: readonly Fragment<S>[],
  exact: readonly bigint[][],
  tick: () => void,
): Fragment<S>[] {
  const faces: (Fragment<S> | null)[] = [],
    around = new Map<number, Set<number>>(),
    edges = new Map<number, Map<number, number>>(),
    floats: (number[] | undefined)[] = [];
  const count = (p: number, q: number, by: number): void => {
    const low = Math.min(p, q),
      high = Math.max(p, q);
    let map = edges.get(low);
    if (!map) edges.set(low, (map = new Map()));
    map.set(high, (map.get(high) ?? 0) + by);
  };
  const used = (p: number, q: number): number => edges.get(Math.min(p, q))?.get(Math.max(p, q)) ?? 0;
  const add = (face: Fragment<S>): void => {
    const at = faces.push(face) - 1;
    face.ids.forEach((p, i) => {
      let set = around.get(p);
      if (!set) around.set(p, (set = new Set()));
      set.add(at);
      count(p, face.ids[(i + 1) % face.ids.length], 1);
    });
  };
  const drop = (at: number): void => {
    const { ids } = faces[at]!;
    ids.forEach((p, i) => {
      around.get(p)!.delete(at);
      count(p, ids[(i + 1) % ids.length], -1);
    });
    faces[at] = null;
  };
  const near = (id: number): number[] => {
    let f = floats[id];
    if (!f) {
      const [X, Y, Z, W] = exact[id],
        w = Number(W);
      floats[id] = f = [Number(X) / w, Number(Y) / w, Number(Z) / w];
    }
    return f;
  };
  /** Which way p, q, r turn in the projection along `axis`: 1, -1 or exactly 0. */
  const orient = (axis: number, p: number, q: number, r: number): number => {
    const u = (axis + 1) % 3,
      v = (axis + 2) % 3,
      P = near(p),
      Q = near(q),
      R = near(r),
      ax = Q[u] - P[u],
      ay = Q[v] - P[v],
      bx = R[u] - P[u],
      by = R[v] - P[v],
      value = ax * by - ay * bx,
      size = Math.max(Math.abs(P[u]), Math.abs(P[v]), Math.abs(Q[u]), Math.abs(Q[v]), Math.abs(R[u]), Math.abs(R[v])),
      bound = FILTER * size * (Math.abs(ax) + Math.abs(ay) + Math.abs(bx) + Math.abs(by));
    // A coordinate beyond float range gives NaN or an infinite bound, and the exact test decides.
    if (value > bound) return 1;
    if (value < -bound) return -1;
    const A = exact[p],
      B = exact[q],
      C = exact[r],
      det =
        A[u] * (B[v] * C[3] - B[3] * C[v]) - A[v] * (B[u] * C[3] - B[3] * C[u]) + A[3] * (B[u] * C[v] - B[v] * C[u]);
    return det > 0n ? 1 : det < 0n ? -1 : 0;
  };
  /** Whether `v` lies on the segment from `a` to `b`, between them. */
  const between = (a: number, v: number, b: number): boolean => {
    const A = exact[a],
      V = exact[v],
      B = exact[b],
      d = [0, 1, 2].map((k) => V[k] * A[3] - A[k] * V[3]),
      e = [0, 1, 2].map((k) => B[k] * V[3] - V[k] * B[3]);
    return (
      d[1] * e[2] === d[2] * e[1] &&
      d[2] * e[0] === d[0] * e[2] &&
      d[0] * e[1] === d[1] * e[0] &&
      d[0] * e[0] + d[1] * e[1] + d[2] * e[2] > 0n
    );
  };
  /** Height over longest edge, for choosing between valid ears only. */
  const quality = (p: number, q: number, r: number): number => {
    const P = near(p),
      Q = near(q),
      R = near(r),
      a = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]],
      b = [R[0] - P[0], R[1] - P[1], R[2] - P[2]],
      area = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]),
      longest = Math.max(Math.hypot(...a), Math.hypot(...b), Math.hypot(R[0] - Q[0], R[1] - Q[1], R[2] - Q[2]));
    return area / (longest * longest) || 0;
  };
  /** Triangles of a simple polygon, or null; `free` refuses a diagonal that is already an edge elsewhere. */
  const clip = ({ ids, turn, source }: Part<S>, free: (p: number, q: number) => boolean): Fragment<S>[] | null => {
    const ring = [...ids],
      out: Fragment<S>[] = [],
      { axis } = source;
    while (ring.length > 3) {
      tick();
      const n = ring.length,
        ears = ring
          .map((q, i) => ({ i, q: quality(ring[(i + n - 1) % n], q, ring[(i + 1) % n]) }))
          .sort((a, b) => b.q - a.q || a.i - b.i),
        found = ears.find(({ i }) => {
          const p = ring[(i + n - 1) % n],
            q = ring[i],
            r = ring[(i + 1) % n];
          if (orient(axis, p, q, r) !== turn || !free(p, r)) return false;
          return ring.every(
            (w) =>
              w === p ||
              w === q ||
              w === r ||
              orient(axis, p, q, w) === -turn ||
              orient(axis, q, r, w) === -turn ||
              orient(axis, r, p, w) === -turn,
          );
        });
      if (!found) return null;
      const { i } = found;
      out.push({ source, ids: [ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]] });
      ring.splice(i, 1);
    }
    if (orient(axis, ring[0], ring[1], ring[2]) !== turn) return null;
    out.push({ source, ids: ring });
    return out;
  };
  /** Takes out point `v` if its faces allow it. */
  const remove = (v: number): boolean => {
    const star = around.get(v);
    if (!star?.size) return false;
    const groups = new Map<S, number[]>();
    for (const at of star) {
      const { source } = faces[at]!;
      let list = groups.get(source);
      if (!list) {
        if (groups.size === 2) return false;
        groups.set(source, (list = []));
      }
      list.push(at);
    }
    const parts: Part<S>[] = [];
    for (const [source, list] of groups) {
      // Each face's path from the corner after `v` to the corner before it; the next face starts where one ends.
      const paths = new Map<number, number[]>(),
        ends = new Set<number>();
      let turn = 0;
      for (const at of list) {
        const { ids } = faces[at]!,
          i = ids.indexOf(v),
          path = [...ids.slice(i + 1), ...ids.slice(0, i)];
        if (path.includes(v) || paths.has(path[0]) || ends.has(path[path.length - 1])) return false;
        paths.set(path[0], path);
        ends.add(path[path.length - 1]);
        for (let k = 2; !turn && k < ids.length; k++)
          for (let j = 1; !turn && j < k; j++) turn = orient(source.axis, ids[0], ids[j], ids[k]);
      }
      const heads = [...paths.keys()].filter((p) => !ends.has(p));
      // One part goes all the way round the point; two parts meet along a chain of faces each.
      if (!turn || heads.length !== (groups.size === 1 ? 0 : 1)) return false;
      const first = heads[0] ?? paths.keys().next().value!,
        ids = [...paths.get(first)!];
      let walked = 1;
      while (walked < paths.size) {
        const path = paths.get(ids[ids.length - 1]);
        if (!path || path[0] === first) return false;
        for (let k = 1; k < path.length; k++) ids.push(path[k]);
        walked++;
      }
      if (groups.size === 1) {
        if (ids[ids.length - 1] !== first) return false;
        ids.pop();
      }
      if (ids.length < 3 || new Set(ids).size !== ids.length) return false;
      parts.push({ source, ids, turn });
    }
    if (parts.length === 2) {
      const [p, q] = parts,
        a = p.ids[0],
        b = p.ids[p.ids.length - 1];
      if (q.ids[0] !== b || q.ids[q.ids.length - 1] !== a || !between(a, v, b) || used(a, b)) return false;
    }
    const old = [...star].map((at) => faces[at]!),
      gone = [...star];
    for (const at of gone) drop(at);
    const made: Fragment<S>[] = [];
    for (const part of parts) {
      const ring = new Set<number>();
      part.ids.forEach((p, i) => {
        const q = part.ids[(i + 1) % part.ids.length];
        ring.add(Math.min(p, q) * exact.length + Math.max(p, q));
      });
      const triangles = clip(part, (p, q) => ring.has(Math.min(p, q) * exact.length + Math.max(p, q)) || !used(p, q));
      if (!triangles) {
        for (const face of old) add(face);
        return false;
      }
      made.push(...triangles);
    }
    for (const face of made) add(face);
    return true;
  };

  for (const loop of loops) add({ ids: loop.ids, source: loop.source });
  for (let pass = 0, changed = true; changed && pass < MAX_PASSES; pass++) {
    changed = false;
    for (const v of [...around.keys()]) {
      tick();
      if (remove(v)) changed = true;
    }
  }
  return faces.filter((face): face is Fragment<S> => face !== null);
}
