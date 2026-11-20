// Surface Nets (Gibson 1998) over a 35-cubed block of samples (local -1..33 per axis), with the triangles clipped to
// boxes so every mesh ends exactly on its box faces, and those faces closed by caps (the solid part of each face plane),
// so each mesh bounds a closed solid. Shared by `meshSmoothChunk(..., {skirt})` and the far levels of `@margoengine/voxel/smooth-lod`.
// Not a package entry.

/** Samples per axis: local -1..33. Index (x + 1) + 35 (z + 1) + 1225 (y + 1). */
export const G = 35;
const GY = G * G,
  // Net cells per axis: local -1..32 (cell i spans samples i..i + 1).
  NC = 34;

/** One material's triangles. */
export interface ClipPart {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** A box in local cells (inclusive faces) and the faces that get a cap: bit 2a is the low face of axis a, 2a + 1 the high. */
export interface ClipBox {
  lo: readonly [number, number, number];
  hi: readonly [number, number, number];
  skirts: number;
}

// Points on box edges by line `axis:coordinate:coordinate`, keyed by the coordinate along the line.
type Lines = Map<string, Map<number, { p: readonly number[]; n: readonly number[] }>>;

interface Vtx {
  key: string;
  p: [number, number, number];
  n: [number, number, number];
}

/**
 * Meshes the samples with Surface Nets, keeps the parts of the triangles inside each box (a triangle cut by a face is
 * clipped there, Sutherland and Hodgman 1974, so the cut points lie exactly on the face), and closes every face whose
 * bit is set with a cap reaching up to `skirt` cells from the border (see closeFaces): with `skirt` at least the face's
 * size the mesh of each box bounds a closed solid. Positions are local cells times `scale`.
 */
export function meshClipped(
  density: Float32Array,
  material: Uint8Array,
  boxes: readonly ClipBox[],
  skirt: number,
  scale: number,
): { parts: Map<number, ClipPart>; triangles: number } {
  const corner = [0, 1, GY, GY + 1, G, G + 1, G + GY, G + GY + 1],
    ids = new Int32Array(NC * NC * NC).fill(-1),
    points: Vtx[] = [];
  for (let j = -1; j <= 32; j++)
    for (let k = -1; k <= 32; k++)
      for (let i = -1; i <= 32; i++) {
        const base = i + 1 + (k + 1) * G + (j + 1) * GY;
        let mask = 0;
        for (let c = 0; c < 8; c++) if (density[base + corner[c]] > 0) mask |= 1 << c;
        if (mask === 0 || mask === 255) continue;
        let sx = 0,
          sy = 0,
          sz = 0,
          crossings = 0;
        const g = [0, 0, 0];
        for (let c = 0; c < 8; c++) {
          const a = density[base + corner[c]];
          g[0] += c & 1 ? a : -a;
          g[1] += c & 2 ? a : -a;
          g[2] += c & 4 ? a : -a;
          for (let axis = 1; axis <= 4; axis <<= 1) {
            if (c & axis) continue;
            const b = density[base + corner[c | axis]];
            if (a > 0 === b > 0) continue;
            const t = a / (a - b);
            crossings++;
            sx += (c & 1 ? 1 : 0) + (axis === 1 ? t : 0);
            sy += (c & 2 ? 1 : 0) + (axis === 2 ? t : 0);
            sz += (c & 4 ? 1 : 0) + (axis === 4 ? t : 0);
          }
        }
        const len = Math.hypot(g[0], g[1], g[2]) || 1;
        ids[i + 1 + (k + 1) * NC + (j + 1) * NC * NC] = points.length;
        points.push({
          key: String(points.length),
          p: [i + sx / crossings, j + sy / crossings, k + sz / crossings],
          n: [-g[0] / len, -g[1] / len, -g[2] / len],
        });
      }
  // Triangles [a, b, c, material] of every quad that can reach into [0, 32]: the quad of the edge from sample s along
  // axis a joins the net cells at s along a and s - 1, s along the other two, so s runs 0..31 along a and 0..32 across.
  const net = (i: number, j: number, k: number) => ids[i + 1 + (k + 1) * NC + (j + 1) * NC * NC],
    tris: number[] = [],
    step = [1, GY, G];
  for (let y = 0; y <= 32; y++)
    for (let z = 0; z <= 32; z++)
      for (let x = 0; x <= 32; x++) {
        const p = x + 1 + (z + 1) * G + (y + 1) * GY,
          inside = density[p] > 0,
          at = [x, y, z];
        for (let a = 0; a < 3; a++) {
          if (at[a] > 31 || inside === density[p + step[a]] > 0) continue;
          const u = (a + 1) % 3,
            v = (a + 2) % 3,
            cell = (du: number, dv: number) => {
              const n = [at[0], at[1], at[2]];
              n[u] += du - 1;
              n[v] += dv - 1;
              return net(n[0], n[1], n[2]);
            },
            ring = [cell(0, 0), cell(1, 0), cell(1, 1), cell(0, 1)];
          // Counterclockwise seen from the air side.
          if (!inside) ring.reverse();
          const m = material[inside ? p : p + step[a]];
          tris.push(ring[0], ring[1], ring[2], m, ring[0], ring[2], ring[3], m);
        }
      }

  const parts = new Map<number, { pos: number[]; nor: number[]; idx: number[] }>(),
    partOf = (m: number) => {
      let part = parts.get(m);
      if (!part) parts.set(m, (part = { pos: [], nor: [], idx: [] }));
      return part;
    };
  let triangles = 0;
  const closing = skirt > 0 && boxes.some((box) => box.skirts),
    lines: Lines = new Map(),
    made: { box: ClipBox; pool: Vtx[]; out: number[]; add: (v: Vtx) => number; finish?: () => void }[] = [];
  for (const box of boxes) {
    // Vertices of this box: one per key, so clipped triangles that share an edge share its cut point.
    const pool: Vtx[] = [],
      byKey = new Map<string, number>(),
      add = (v: Vtx) => {
        let at = byKey.get(v.key);
        if (at === undefined) {
          byKey.set(v.key, (at = pool.length));
          pool.push(v);
        }
        return at;
      },
      cut = (A: Vtx, B: Vtx, a: number, w: number): Vtx => {
        // The same pair cuts to the same point whichever triangle asks: order the ends by key.
        if (A.key > B.key) [A, B] = [B, A];
        const key = `${A.key}|${B.key}|${a}:${w}`,
          at = byKey.get(key);
        if (at !== undefined) return pool[at];
        const t = (w - A.p[a]) / (B.p[a] - A.p[a]),
          p: [number, number, number] = [0, 0, 0],
          n: [number, number, number] = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          p[c] = A.p[c] + t * (B.p[c] - A.p[c]);
          n[c] = A.n[c] + t * (B.n[c] - A.n[c]);
        }
        p[a] = w;
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        return { key, p, n: [n[0] / len, n[1] / len, n[2] / len] };
      },
      out: number[] = []; // [v0, v1, v2, material]
    for (let t = 0; t < tris.length; t += 4) {
      let poly = [points[tris[t]], points[tris[t + 1]], points[tris[t + 2]]];
      for (let f = 0; f < 6 && poly.length >= 3; f++) {
        const a = f >> 1,
          high = f & 1,
          w = high ? box.hi[a] : box.lo[a],
          keep = (v: Vtx) => (high ? v.p[a] <= w : v.p[a] >= w);
        if (poly.every(keep)) continue;
        const next: Vtx[] = [];
        for (let e = 0; e < poly.length; e++) {
          const A = poly[e],
            B = poly[(e + 1) % poly.length],
            inA = keep(A);
          if (inA) next.push(A);
          if (inA !== keep(B)) next.push(cut(A, B, a, w));
        }
        poly = next;
      }
      if (poly.length < 3) continue;
      const vs = poly.map(add);
      for (let e = 1; e + 1 < vs.length; e++) out.push(vs[0], vs[e], vs[e + 1], tris[t + 3]);
    }
    made.push({ box, pool, out, add });
  }
  // Every face with its bit set is closed by the solid part of its plane, so the node's mesh bounds a closed solid.
  if (closing) {
    snapSurface(made, boxes);
    for (const m of made) m.finish = closeFaces(m.box, m.pool, m.out, m.add, density, material, skirt, lines);
  }
  for (const { pool, out, finish } of made) {
    finish?.();
    // Into the material parts.
    const remap = new Map<number, number>();
    for (let t = 0; t < out.length; t += 4) {
      const part = partOf(out[t + 3]);
      for (let e = 0; e < 3; e++) {
        const v = out[t + e],
          code = v * 256 + out[t + 3];
        let at = remap.get(code);
        if (at === undefined) {
          remap.set(code, (at = part.pos.length / 3));
          const V = pool[v];
          part.pos.push(V.p[0] * scale, V.p[1] * scale, V.p[2] * scale);
          part.nor.push(V.n[0], V.n[1], V.n[2]);
        }
        part.idx.push(at);
      }
      triangles++;
    }
  }
  const result = new Map<number, ClipPart>();
  for (const m of [...parts.keys()].sort((x, y) => x - y)) {
    const part = parts.get(m)!;
    result.set(m, {
      positions: Float32Array.from(part.pos),
      normals: Float32Array.from(part.nor),
      indices: Uint32Array.from(part.idx),
    });
  }
  return { parts: result, triangles };
}

// One border segment of a face: a mesh edge P -> Q lying in the face plane that the mesh uses k more times in that
// direction than in the other (k > 0), in the face's (u, v) coordinates, with the plane direction toward its solid side
// s = (Q - P) x e (e the outward face normal): the side whose winding number is k higher.
interface Seg {
  i: number;
  j: number;
  k: number;
  m: number;
  uP: number;
  vP: number;
  uQ: number;
  vQ: number;
  sU: number;
  sV: number;
}

type Ring = { ids: number[]; m: number; a: number; w: number; sigma: number; flip: boolean };

const ekey = (i: number, j: number) => (i < j ? `${i},${j}` : `${j},${i}`);

/**
 * Makes coordinates of points on the boxes' surfaces that differ by rounding only (1e-9 cells) equal, per axis over all
 * the boxes of the call at once, a box face's own coordinate preferred: a point the clip left a hair off a face goes onto
 * it, and the same place reached by cuts in a different order becomes one point, the same in every box (else a cap
 * corner and a border vertex a rounding apart meet only through a sliver no triangle can fill).
 */
function snapSurface(made: { box: ClipBox; pool: Vtx[]; out: number[] }[], boxes: readonly ClipBox[]): void {
  const surface = made.map(({ box, pool, out }) =>
    [...new Set(out.filter((_, k) => k % 4 !== 3))].filter((id) =>
      pool[id].p.some((x, c) => Math.abs(x - box.lo[c]) < 1e-9 || Math.abs(x - box.hi[c]) < 1e-9),
    ),
  );
  for (let c = 0; c < 3; c++) {
    const raw = [...new Set(made.flatMap(({ pool }, b) => surface[b].map((id) => pool[id].p[c])))].sort(
        (x, y) => x - y,
      ),
      faces = boxes.flatMap((box) => [box.lo[c], box.hi[c]]),
      snap = new Map<number, number>();
    for (let k = 0; k < raw.length; ) {
      let end = k;
      while (end + 1 < raw.length && raw[end + 1] - raw[end] < 1e-9) end++;
      let to = raw[k];
      for (const f of faces) if (raw[k] - f < 1e-9 && f - raw[end] < 1e-9) to = f;
      for (let q = k; q <= end; q++) snap.set(raw[q], to);
      k = end + 1;
    }
    made.forEach(({ pool }, b) => {
      for (const id of surface[b]) {
        const v = pool[id],
          to = snap.get(v.p[c])!;
        if (to === v.p[c]) continue;
        const p: [number, number, number] = [v.p[0], v.p[1], v.p[2]];
        p[c] = to;
        pool[id] = { key: v.key, p, n: v.n };
      }
    });
  }
}

/**
 * Closes each face of `box` whose bit is set with the part of the face plane inside the solid (a cap, as when a clipped
 * solid is capped at its section plane), counted by winding number: the mesh's border is a chain (each edge's uses
 * counted with their direction), every point of the box's surface has a winding number about it that steps by an edge's
 * count where the point crosses that edge, and a cap covers each region of a face as many times as its winding number
 * (turned over where it is negative), so the mesh with its caps has every edge used as often in each direction.
 * The numbers along each box edge are found once per box edge, from the border points on it and the density samples on
 * it (a sample's winding number is its solid flag), and both faces meeting there start from them, so the two caps agree
 * on every box edge whatever the surface does inside a cell. Each face is cut into slabs at every border vertex u (Dobkin
 * and Lipton 1976), the border segments crossing a slab are sorted along v and the winding number is carried up from the
 * box edge below; each span with a number other than zero is filled with a trapezoid (Seidel 1991). The cap's corners on a
 * border edge split every triangle on that edge, and its corners on a slab line are shared by the trapezoids on both
 * sides, so the cap meets the mesh and itself with no T-junction. Each trapezoid reaches at most `depth` cells from the
 * border that sweeps it; a depth of the face's size closes the face whole.
 */
function closeFaces(
  box: ClipBox,
  pool: Vtx[],
  out: number[],
  add: (v: Vtx) => number,
  density: Float32Array,
  material: Uint8Array,
  depth: number,
  lines: Lines,
): () => void {
  // One vertex per position (snapSurface has made points a rounding apart on the box surface equal).
  const byPos = new Map<string, number>();
  for (let t = 0; t < out.length; t += 4)
    for (let e = 0; e < 3; e++) {
      const p = pool[out[t + e]].p,
        key = `${p[0]},${p[1]},${p[2]}`,
        at = byPos.get(key);
      if (at === undefined) byPos.set(key, out[t + e]);
      else out[t + e] = at;
    }
  // Every point the caps add goes through here too, so the caps of two faces meet on a box edge at one vertex.
  const place = (v: Vtx): number => {
    const key = `${v.p[0]},${v.p[1]},${v.p[2]}`;
    let id = byPos.get(key);
    if (id === undefined) byPos.set(key, (id = add(v)));
    return id;
  };
  // Drop the triangles that collapse to a line or a point (clipping near a box corner makes some).
  let kept = 0;
  for (let t = 0; t < out.length; t += 4) {
    if (out[t] === out[t + 1] || out[t + 1] === out[t + 2] || out[t + 2] === out[t]) continue;
    for (let c = 0; c < 4; c++) out[kept + c] = out[t + c];
    kept += 4;
  }
  out.length = kept;
  // The border as a chain: per edge, its uses from the lower vertex id minus those from the higher, with a material
  // for each direction. A fold can use an edge twice the same way (count 2) or three times (count 1).
  const uses = new Map<string, { lo: number; hi: number; n: number; m: [number, number] }>();
  for (let t = 0; t < out.length; t += 4)
    for (let e = 0; e < 3; e++) {
      const i = out[t + e],
        j = out[t + ((e + 1) % 3)],
        up = i < j ? 0 : 1,
        key = ekey(i, j);
      let use = uses.get(key);
      if (!use) uses.set(key, (use = { lo: Math.min(i, j), hi: Math.max(i, j), n: 0, m: [-1, -1] }));
      use.n += up ? -1 : 1;
      if (use.m[up] < 0) use.m[up] = out[t + 3];
    }
  const capped = (f: number) => (box.skirts & (1 << f)) !== 0,
    // A border edge on a box edge lies in two faces and is counted in one: a capped one, else the lower.
    owner = (f: number, g: number) => (capped(f) !== capped(g) ? (capped(f) ? f : g) : Math.min(f, g)),
    frame = (f: number) => {
      const a = f >> 1,
        e = [0, 0, 0];
      e[a] = f & 1 ? 1 : -1;
      return {
        a,
        sigma: f & 1 ? 1 : -1,
        w: f & 1 ? box.hi[a] : box.lo[a],
        U: a === 1 ? 0 : a === 0 ? 2 : 0,
        V: a === 1 ? 2 : 1,
        e,
      };
    },
    cross = (d: readonly number[], e: readonly number[]) => [
      d[1] * e[2] - d[2] * e[1],
      d[2] * e[0] - d[0] * e[2],
      d[0] * e[1] - d[1] * e[0],
    ];
  const faceSegs: Seg[][] = [[], [], [], [], [], []];
  for (const use of uses.values()) {
    if (!use.n) continue;
    const i = use.n > 0 ? use.lo : use.hi,
      j = use.n > 0 ? use.hi : use.lo,
      P = pool[i].p,
      Q = pool[j].p,
      faces: number[] = [];
    for (let f = 0; f < 6; f++) {
      const a = f >> 1,
        w = f & 1 ? box.hi[a] : box.lo[a];
      if (P[a] === w && Q[a] === w) faces.push(f);
    }
    if (!faces.length) continue;
    const f = faces.length === 1 ? faces[0] : owner(faces[0], faces[1]),
      { U, V, e } = frame(f),
      s = cross([Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]], e);
    if (P[U] === Q[U] && P[V] === Q[V]) continue;
    faceSegs[f].push({
      i,
      j,
      k: Math.abs(use.n),
      m: use.m[use.n > 0 ? 0 : 1],
      uP: P[U],
      vP: P[V],
      uQ: Q[U],
      vQ: Q[V],
      sU: s[U],
      sV: s[V],
    });
  }
  // Winding numbers along each box edge, by line `axis:coordinate:coordinate`: [steps at border points, base]. The
  // number is the one seen from the face that does not count the border edges lying on the line, which steps by every
  // border segment of that face ending on the line; its base is fixed by the samples on the line away from border
  // points, each 1 where solid and 0 where air (the most common answer wins; all agree unless a sample sits on the
  // surface).
  const boxLines = new Map<string, { steps: [number, number][]; base: number }>(),
    lineAt = (c: number, q: readonly number[], x: number): number => {
      const c1 = (c + 1) % 3,
        c2 = (c + 2) % 3,
        key = `${c}:${q[c1]}:${q[c2]}`;
      let line = boxLines.get(key);
      if (!line) {
        const fA = 2 * c1 + (q[c1] === box.hi[c1] ? 1 : 0),
          fB = 2 * c2 + (q[c2] === box.hi[c2] ? 1 : 0),
          own = owner(fA, fB),
          other = own === fA ? fB : fA,
          on = (p: readonly number[]) => p[c1] === q[c1] && p[c2] === q[c2],
          { e } = frame(other),
          steps = new Map<number, number>(),
          held: [number, number][] = [];
        for (const s of faceSegs[other]) {
          const P = pool[s.i].p,
            Q = pool[s.j].p,
            side = cross([Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]], e)[c];
          for (const X of [P, Q]) {
            if (!on(X)) continue;
            held.push([X[c], X[c]]);
            // Past X along +c lies on the segment's solid side when its solid direction has a +c part.
            if (side) steps.set(X[c], (steps.get(X[c]) ?? 0) + Math.sign(side) * s.k);
          }
        }
        for (const s of faceSegs[own]) {
          const P = pool[s.i].p,
            Q = pool[s.j].p;
          if (on(P) && on(Q)) held.push([Math.min(P[c], Q[c]), Math.max(P[c], Q[c])]);
          else for (const X of [P, Q]) if (on(X)) held.push([X[c], X[c]]);
        }
        const list = [...steps].sort((x, y) => x[0] - y[0]),
          votes = new Map<number, number>(),
          p = [q[0], q[1], q[2]];
        for (let x = box.lo[c]; x <= box.hi[c]; x++) {
          if (held.some(([l, h]) => x >= l && x <= h)) continue;
          let n = 0;
          for (const [y, d] of list) if (y < x) n += d;
          p[c] = x;
          const solid = density[p[0] + 1 + (p[2] + 1) * G + (p[1] + 1) * GY] > 0 ? 1 : 0;
          votes.set(solid - n, (votes.get(solid - n) ?? 0) + 1);
        }
        let base = 0,
          most = 0;
        for (const [b, count] of votes) if (count > most) [base, most] = [b, count];
        boxLines.set(key, (line = { steps: list, base }));
      }
      let n = line.base;
      for (const [y, d] of line.steps) if (y < x) n += d;
      return n;
    };
  // Points inserted on border edges, by edge: every triangle on the edge takes them.
  const splits = new Map<string, Set<number>>(),
    split = (i: number, j: number, v: number) => {
      if (v === i || v === j) return;
      const key = ekey(i, j);
      let set = splits.get(key);
      if (!set) splits.set(key, (set = new Set()));
      set.add(v);
    },
    rings: Ring[] = [];
  for (let f = 0; f < 6; f++) {
    if (!capped(f)) continue;
    const { a, sigma, w, U, V, e } = frame(f),
      u0 = box.lo[U],
      u1 = box.hi[U],
      v0 = box.lo[V],
      v1 = box.hi[V],
      segs = faceSegs[f],
      floor = [0, 0, 0];
    floor[a] = w;
    floor[V] = v0;
    // A point of the face plane at (u, v), with normal n.
    const at = (u: number, v: number, n: readonly number[], key: string): number => {
      const p: [number, number, number] = [0, 0, 0];
      p[a] = w;
      p[U] = u;
      p[V] = v;
      return place({ key, p, n: [n[0], n[1], n[2]] });
    };
    // Slabs between consecutive border-vertex u, and the non-vertical segments spanning each.
    const xs = [...new Set([u0, u1, ...segs.flatMap((s) => [s.uP, s.uQ])])].sort((x, y) => x - y),
      slabOf = new Map(xs.map((x, k) => [x, k])),
      spans: Seg[][] = xs.map(() => []);
    for (const s of segs) {
      if (s.uP === s.uQ) continue;
      const k0 = slabOf.get(Math.min(s.uP, s.uQ))!,
        k1 = slabOf.get(Math.max(s.uP, s.uQ))!;
      for (let k = k0; k < k1; k++) spans[k].push(s);
    }
    const vAt = (s: Seg, x: number) =>
        x === s.uP ? s.vP : x === s.uQ ? s.vQ : s.vP + ((s.vQ - s.vP) * (x - s.uP)) / (s.uQ - s.uP),
      // Below means toward lower v: the solid side has a negative v component.
      solidBelow = (s: Seg) => s.sV < 0;
    // A point on segment s at u = x: its end, or a new vertex on the edge (which splits the edge's triangles).
    const onSeg = (s: Seg, x: number): number => {
      if (x === s.uP) return s.i;
      if (x === s.uQ) return s.j;
      const A = pool[s.i],
        B = pool[s.j],
        r = (x - s.uP) / (s.uQ - s.uP),
        key = `${A.key < B.key ? A.key : B.key}|${A.key < B.key ? B.key : A.key}@${a}:${w}~${x}`,
        p: [number, number, number] = [0, 0, 0],
        n: [number, number, number] = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        p[c] = A.p[c] + r * (B.p[c] - A.p[c]);
        n[c] = A.n[c] + r * (B.n[c] - A.n[c]);
      }
      p[a] = w;
      p[U] = x;
      p[V] = vAt(s, x);
      const len = Math.hypot(n[0], n[1], n[2]) || 1,
        v = place({ key, p, n: [n[0] / len, n[1] / len, n[2] / len] });
      split(s.i, s.j, v);
      return v;
    };
    const normalOn = (s: Seg, x: number): number[] => {
      const A = pool[s.i].n,
        B = pool[s.j].n,
        r = s.uP === s.uQ ? 0 : (x - s.uP) / (s.uQ - s.uP),
        n = [A[0] + r * (B[0] - A[0]), A[1] + r * (B[1] - A[1]), A[2] + r * (B[2] - A[2])],
        len = Math.hypot(n[0], n[1], n[2]) || 1;
      return [n[0] / len, n[1] / len, n[2] / len];
    };
    // The material of a span no segment bounds: the nearest segment's across a line of constant v through it (a line
    // through no vertex), else the sample at the face's centre.
    const vs = [...new Set([v0, v1, ...segs.flatMap((s) => [s.vP, s.vQ])])].sort((x, y) => x - y),
      near = (xl: number, xr: number): number => {
        for (let k = 0; k + 1 < vs.length; k++) {
          const vm = (vs[k] + vs[k + 1]) / 2;
          let best: Seg | undefined,
            bestD = Infinity;
          for (const s of segs) {
            if (!(Math.min(s.vP, s.vQ) < vm && vm < Math.max(s.vP, s.vQ))) continue;
            const u = s.uP + ((s.uQ - s.uP) * (vm - s.vP)) / (s.vQ - s.vP),
              d = u <= xl ? xl - u : u - xr;
            if (d >= 0 && d < bestD) [best, bestD] = [s, d];
          }
          if (best) return best.m;
        }
        const q = [0, 0, 0];
        q[a] = w;
        q[U] = Math.round((xl + xr) / 2);
        q[V] = Math.round((v0 + v1) / 2);
        return material[q[0] + 1 + (q[2] + 1) * G + (q[1] + 1) * GY];
      };
    // Spans to fill, each with its winding number n: [slab, lower segment or null, upper or null, bottom l, top l,
    // bottom r, top r].
    type Span = { k: number; lo: Seg | null; hi: Seg | null; by: Seg | null; m: number; n: number; c: number[] };
    const fills: Span[] = [];
    for (let k = 0; k + 1 < xs.length; k++) {
      const xl = xs[k],
        xr = xs[k + 1],
        list = spans[k].sort((s, t) => vAt(s, xl) + vAt(s, xr) - vAt(t, xl) - vAt(t, xr));
      // The winding number from the box edge below, stepped across each segment going up.
      let n = lineAt(U, floor, (xl + xr) / 2);
      for (let c = 0; c <= list.length; c++) {
        const B = c > 0 ? list[c - 1] : null,
          T = c < list.length ? list[c] : null,
          count = n;
        if (T) n += solidBelow(T) ? -T.k : T.k;
        if (!count) continue;
        // The segment whose solid side the span is on: the cap reaches `depth` cells from it.
        const by = T && solidBelow(T) ? T : B && !solidBelow(B) ? B : null;
        if (!by && depth < v1 - v0) continue;
        const m = (by ?? T ?? B)?.m ?? near(xl, xr),
          ends = [xl, xr].map((x) => {
            let bot = B ? vAt(B, x) : v0,
              top = T ? vAt(T, x) : v1;
            if (by === T && T) bot = Math.max(bot, top - depth);
            else if (by === B && B) top = Math.min(top, bot + depth);
            return [bot, Math.max(bot, top)];
          });
        if (ends[0][1] === ends[0][0] && ends[1][1] === ends[1][0]) continue;
        fills.push({ k, lo: B, hi: T, by, m, n: count, c: [ends[0][0], ends[0][1], ends[1][0], ends[1][1]] });
      }
    }
    // Vertices: segment points where the span is bounded by a segment, else plane points keyed by position.
    const corner = (span: Span, side: number, top: boolean): number => {
      const x = xs[span.k + side],
        v = span.c[side * 2 + (top ? 1 : 0)],
        s = top ? span.hi : span.lo;
      if (s && vAt(s, x) === v) return onSeg(s, x);
      return at(x, v, span.by ? normalOn(span.by, x) : e, `cap${f}:${x}:${v}`);
    };
    const made = fills.map((span) => [
      corner(span, 0, false),
      corner(span, 0, true),
      corner(span, 1, false),
      corner(span, 1, true),
    ]);
    // Every vertex on each slab line, so a span's side takes the points of the spans across the line.
    const line = xs.map(() => new Map<number, number>());
    // Border vertices too, so a span's side passes through the ends of a border segment lying along it.
    for (const s of segs) {
      line[slabOf.get(s.uP)!].set(s.i, s.vP);
      line[slabOf.get(s.uQ)!].set(s.j, s.vQ);
    }
    fills.forEach((span, n) => {
      const [bl, tl, br, tr] = made[n];
      line[span.k].set(bl, pool[bl].p[V]).set(tl, pool[tl].p[V]);
      line[span.k + 1].set(br, pool[br].p[V]).set(tr, pool[tr].p[V]);
    });
    // A border segment along a slab line takes the span corners between its ends.
    for (const s of segs) {
      if (s.uP !== s.uQ) continue;
      for (const [id, v] of line[slabOf.get(s.uP)!])
        if (v > Math.min(s.vP, s.vQ) && v < Math.max(s.vP, s.vQ)) split(s.i, s.j, id);
    }
    fills.forEach((span, n) => {
      const [bl, tl, br, tr] = made[n],
        side = (k: number, from: number, to: number, up: boolean) =>
          [...line[k]]
            .filter(([, v]) => (up ? v > from && v < to : v < from && v > to))
            .sort((p, q) => (up ? p[1] - q[1] : q[1] - p[1]))
            .map(([id]) => id),
        ring = [bl, br, ...side(span.k + 1, pool[br].p[V], pool[tr].p[V], true), tr, tl];
      ring.push(...side(span.k, pool[tl].p[V], pool[bl].p[V], false));
      // Drop repeated points (a zero-height side).
      const corners = ring.filter((id, q) => {
        const nx = pool[ring[(q + 1) % ring.length]].p,
          p = pool[id].p;
        return id !== ring[(q + 1) % ring.length] && !(nx[U] === p[U] && nx[V] === p[V]);
      });
      if (corners.length < 3) return;
      // A region the border winds about n times is covered n times, turned over where n is negative.
      for (let copy = 0; copy < Math.abs(span.n); copy++)
        rings.push({ ids: corners, m: span.m, a, w, sigma, flip: span.n < 0 });
    });
  }
  // Points on the box's edges (two coordinates on its faces), by line, shared by every box of the call: the caps of two
  // faces, the mesh and the next box meet there, and every edge along such a line takes the others' points between its
  // ends.
  const bound = (p: readonly number[], c: number) => p[c] === box.lo[c] || p[c] === box.hi[c],
    lineOf = (A: readonly number[], B: readonly number[]): number => {
      for (let c = 0; c < 3; c++) {
        const c1 = (c + 1) % 3,
          c2 = (c + 2) % 3;
        if (A[c1] === B[c1] && A[c2] === B[c2] && bound(A, c1) && bound(A, c2) && A[c] !== B[c]) return c;
      }
      return -1;
    },
    note = (id: number) => {
      const { p, n } = pool[id];
      for (let c = 0; c < 3; c++) {
        const c1 = (c + 1) % 3,
          c2 = (c + 2) % 3;
        if (!bound(p, c1) || !bound(p, c2)) continue;
        const key = `${c}:${p[c1]}:${p[c2]}`;
        let line = lines.get(key);
        if (!line) lines.set(key, (line = new Map()));
        if (!line.has(p[c])) line.set(p[c], { p, n });
      }
    };
  for (const ring of rings) for (const id of ring.ids) note(id);
  for (let t = 0; t < out.length; t += 4) for (let e = 0; e < 3; e++) note(out[t + e]);
  for (const set of splits.values()) for (const id of set) note(id);
  return () => finishFaces(pool, out, add, lines, rings, splits, split, lineOf);
}

// Second step of closeFaces, once every box of the call has noted its points on box edges: edges along a box edge take
// the points there, the caps are triangulated and the split triangles made again.
function finishFaces(
  pool: Vtx[],
  out: number[],
  add: (v: Vtx) => number,
  lines: Lines,
  rings: Ring[],
  splits: Map<string, Set<number>>,
  split: (i: number, j: number, v: number) => void,
  lineOf: (A: readonly number[], B: readonly number[]) => number,
): void {
  const local = new Map<string, number>();
  pool.forEach((v, id) => {
    const key = `${v.p[0]},${v.p[1]},${v.p[2]}`;
    if (!local.has(key)) local.set(key, id);
  });
  const here = ({ p, n }: { p: readonly number[]; n: readonly number[] }): number => {
      const key = `${p[0]},${p[1]},${p[2]}`;
      let id = local.get(key);
      if (id === undefined) {
        local.set(key, (id = add({ key: `at:${key}`, p: [p[0], p[1], p[2]], n: [n[0], n[1], n[2]] })));
      }
      return id;
    },
    between = (A: number, B: number): number[] => {
      const P = pool[A].p,
        Q = pool[B].p,
        c = lineOf(P, Q);
      if (c < 0) return [];
      const line = lines.get(`${c}:${P[(c + 1) % 3]}:${P[(c + 2) % 3]}`);
      if (!line) return [];
      const lo = Math.min(P[c], Q[c]),
        hi = Math.max(P[c], Q[c]);
      return [...line]
        .filter(([x]) => x > lo && x < hi)
        .sort((x, y) => (P[c] < Q[c] ? x[0] - y[0] : y[0] - x[0]))
        .map(([, point]) => here(point));
    };
  // Mesh edges along a box edge take the points there.
  for (let t = 0; t < out.length; t += 4)
    for (let e = 0; e < 3; e++) {
      const A = out[t + e],
        B = out[t + ((e + 1) % 3)];
      for (const id of between(A, B)) split(A, B, id);
    }
  // The caps: each ring (convex, maybe with points along its sides), facing out of the box (into it when turned over).
  const capTris: number[] = [];
  for (const { ids, m, a, sigma, flip } of rings) {
    const ring: number[] = [];
    for (let k = 0; k < ids.length; k++) ring.push(ids[k], ...between(ids[k], ids[(k + 1) % ids.length]));
    const tri = (A: number, B: number, C: number) => {
      const pa = pool[A].p,
        pb = pool[B].p,
        pc = pool[C].p,
        n =
          (pb[(a + 1) % 3] - pa[(a + 1) % 3]) * (pc[(a + 2) % 3] - pa[(a + 2) % 3]) -
          (pb[(a + 2) % 3] - pa[(a + 2) % 3]) * (pc[(a + 1) % 3] - pa[(a + 1) % 3]);
      if (n === 0) return;
      if (n * sigma > 0 !== flip) capTris.push(A, B, C, m);
      else capTris.push(A, C, B, m);
    };
    const t = clipEars(ring, pool);
    for (let k = 0; k < t.length; k += 3) tri(t[k], t[k + 1], t[k + 2]);
  }
  // Split the triangles whose edges took points: every triangle on such an edge, so the edge stays used as often in
  // each direction.
  const count = out.length;
  for (let t = 0; t < count; t += 4) {
    const v = [out[t], out[t + 1], out[t + 2]],
      m = out[t + 3],
      ring: number[] = [];
    let any = false;
    for (let e = 0; e < 3; e++) {
      ring.push(v[e]);
      const set = splits.get(ekey(v[e], v[(e + 1) % 3]));
      if (!set) continue;
      const P = pool[v[e]].p,
        Q = pool[v[(e + 1) % 3]].p,
        d = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]],
        dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2],
        r = (id: number) => {
          const p = pool[id].p;
          return ((p[0] - P[0]) * d[0] + (p[1] - P[1]) * d[1] + (p[2] - P[2]) * d[2]) / dd;
        };
      const add = [...set].sort((x, y) => r(x) - r(y));
      if (add.length) any = true;
      ring.push(...add);
    }
    if (!any) continue;
    const tris = clipEars(ring, pool);
    if (!tris.length) continue;
    out[t] = tris[0];
    out[t + 1] = tris[1];
    out[t + 2] = tris[2];
    for (let k = 3; k < tris.length; k += 3) out.push(tris[k], tris[k + 1], tris[k + 2], m);
  }
  for (const x of capTris) out.push(x);
}

/**
 * Triangles of a convex ring whose sides may carry extra points in line (ear clipping, Meisters 1975): each step cuts
 * off a corner whose chord passes through no other point of the ring, so only the ring's own points are used and every
 * side keeps all its points (no T-junction). Triangles keep the ring's turning order; a ring in a line gives none.
 */
function clipEars(ring: number[], pool: Vtx[]): number[] {
  const r = ring.filter((id, k) => id !== ring[(k + 1) % ring.length]),
    out: number[] = [],
    // Zero when A, B and C are in line to within the rounding of a point cut on a line: the triangle's least height (twice
    // its area over its longest side) is at most 1e-11 cells. A height, not an angle: a sliver a few cells long and 1e-9
    // wide is a real triangle that float32 positions keep, and leaving it out opens the surface.
    cross = (A: number, B: number, C: number) => {
      const a = pool[A].p,
        b = pool[B].p,
        c = pool[C].p,
        u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
        x = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]),
        long = Math.max(
          Math.hypot(u[0], u[1], u[2]),
          Math.hypot(v[0], v[1], v[2]),
          Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]),
        );
      return x <= 1e-11 * long ? 0 : x;
    };
  // C lies between A and B along their line.
  const inside = (A: number, B: number, C: number) => {
    const a = pool[A].p,
      b = pool[B].p,
      c = pool[C].p,
      d = (c[0] - a[0]) * (b[0] - a[0]) + (c[1] - a[1]) * (b[1] - a[1]) + (c[2] - a[2]) * (b[2] - a[2]);
    return d > 0 && d < (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2;
  };
  while (r.length > 3) {
    const n = r.length;
    let pick = -1;
    for (let k = 0; k < n && pick < 0; k++) {
      const prev = r[(k + n - 1) % n],
        next = r[(k + 1) % n];
      if (cross(prev, r[k], next) === 0) continue;
      let clear = true;
      for (let q = 0; q < n && clear; q++)
        if (q !== k && r[q] !== prev && r[q] !== next && cross(prev, next, r[q]) === 0 && inside(prev, next, r[q]))
          clear = false;
      if (clear) pick = k;
    }
    if (pick < 0) return out;
    out.push(r[(pick + n - 1) % n], r[pick], r[(pick + 1) % n]);
    r.splice(pick, 1);
  }
  if (r.length === 3 && cross(r[0], r[1], r[2]) !== 0) out.push(r[0], r[1], r[2]);
  return out;
}
