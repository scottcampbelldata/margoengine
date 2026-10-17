// Constrained Delaunay triangulation (CDT) of a trimmed face in its surface's (u, v) parameter space, written from the
// published algorithms with no third-party triangulation code:
// - Shewchuk, "Adaptive Precision Floating-Point Arithmetic and Fast Robust Geometric Predicates" (1997): orientation
//   and in-circle tests take a floating-point filter and fall back to exact expansion arithmetic, so collinear and
//   cocircular inputs get exact signs (no flip loops, no inverted triangles).
// - Incremental insertion with Lawson flips (de Berg et al., Computational Geometry, ch. 9) inside a bounding
//   super-triangle, in a biased randomized insertion order (Amenta, Choi and Rote 2003: shuffled with a fixed seed, in
//   rounds of doubling size, each round sorted along a Hilbert curve), each point found by a stochastic walk from the
//   previous one (Devillers, Pion and Teillaud 2002).
// - Constraint edges recovered by flipping the edges they cross (Sloan 1993), then Lawson flips of the touched edges
//   restore the constrained Delaunay property. The even-odd rule over the loops picks the triangles of the face.
// Mesh: half-edges, 3 per triangle in counter-clockwise order; half-edge e runs from tv[e] to tv[next(e)] and tw[e] is
// the opposite half-edge (-1 on the super-triangle's border).

// ---- Exact predicates ----

const EPSILON = 2 ** -53; // the relative rounding error of one operation (half an ulp of 1)
const SPLITTER = 2 ** 27 + 1; // splits a double into two halves of 26 bits (Dekker)
const ORIENT_BOUND = (3 + 16 * EPSILON) * EPSILON;
const INCIRCLE_BOUND = (10 + 96 * EPSILON) * EPSILON;

// An expansion is an array of non-overlapping doubles, smallest magnitude first, zeros dropped: its value is their
// exact sum and its last component has the value's sign. Only the near-degenerate cases the filters reject get here.

/** Exact a * b (Two-Product, with Dekker's split). */
function product(a: number, b: number): number[] {
  const x = a * b;
  let c = SPLITTER * a;
  const ahi = c - (c - a),
    alo = a - ahi;
  c = SPLITTER * b;
  const bhi = c - (c - b),
    blo = b - bhi;
  const y = alo * blo - (x - ahi * bhi - alo * bhi - ahi * blo);
  return y !== 0 ? [y, x] : x !== 0 ? [x] : [];
}

/** Exact a - b (Two-Diff). */
function difference(a: number, b: number): number[] {
  const x = a - b,
    bv = a - x,
    y = a - (x + bv) + (bv - b);
  return y !== 0 ? [y, x] : x !== 0 ? [x] : [];
}

/** Exact e + f (Fast-Expansion-Sum with zero elimination): merge by magnitude, then a chain of Two-Sums. */
function sum(e: number[], f: number[]): number[] {
  if (e.length === 0) return f;
  if (f.length === 0) return e;
  const g: number[] = [];
  let i = 0,
    j = 0;
  while (i < e.length && j < f.length) g.push(Math.abs(f[j]) < Math.abs(e[i]) ? f[j++] : e[i++]);
  while (i < e.length) g.push(e[i++]);
  while (j < f.length) g.push(f[j++]);
  const h: number[] = [];
  let q = g[0];
  for (let k = 1; k < g.length; k++) {
    const b = g[k],
      s = q + b,
      bv = s - q,
      y = q - (s - bv) + (b - bv);
    if (y !== 0) h.push(y);
    q = s;
  }
  if (q !== 0) h.push(q);
  return h;
}

/** Exact e * b (Scale-Expansion with zero elimination). */
function scale(e: number[], b: number): number[] {
  const h: number[] = [];
  if (e.length === 0 || b === 0) return h;
  let c = SPLITTER * b;
  const bhi = c - (c - b),
    blo = b - bhi;
  let q = 0;
  for (let i = 0; i < e.length; i++) {
    const a = e[i],
      hi = a * b;
    c = SPLITTER * a;
    const ahi = c - (c - a),
      alo = a - ahi,
      lo = alo * blo - (hi - ahi * bhi - alo * bhi - ahi * blo);
    if (i === 0) {
      if (lo !== 0) h.push(lo);
      q = hi;
      continue;
    }
    // (s, y) = Two-Sum(q, lo), then (q, y) = Two-Sum(hi, s)
    const s = q + lo;
    let bv = s - q,
      y = q - (s - bv) + (lo - bv);
    if (y !== 0) h.push(y);
    q = hi + s;
    bv = q - hi;
    y = hi - (q - bv) + (s - bv);
    if (y !== 0) h.push(y);
  }
  if (q !== 0) h.push(q);
  return h;
}

/** Exact e * f. */
function multiply(e: number[], f: number[]): number[] {
  let h: number[] = [];
  for (let i = 0; i < f.length; i++) h = sum(h, scale(e, f[i]));
  return h;
}

const negate = (e: number[]) => e.map((v) => -v);
const signOf = (e: number[]) => (e.length > 0 ? e[e.length - 1] : 0);

function orientExact(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  // ax by - ay bx + bx cy - by cx + cx ay - cy ax: six exact products, summed exactly
  const ab = sum(product(ax, by), negate(product(ay, bx))),
    bc = sum(product(bx, cy), negate(product(by, cx))),
    ca = sum(product(cx, ay), negate(product(cy, ax)));
  return signOf(sum(sum(ab, bc), ca));
}

function incircleExact(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const adx = difference(ax, dx),
    ady = difference(ay, dy),
    bdx = difference(bx, dx),
    bdy = difference(by, dy),
    cdx = difference(cx, dx),
    cdy = difference(cy, dy);
  const bc = sum(multiply(bdx, cdy), negate(multiply(cdx, bdy))),
    ca = sum(multiply(cdx, ady), negate(multiply(adx, cdy))),
    ab = sum(multiply(adx, bdy), negate(multiply(bdx, ady)));
  const alift = sum(multiply(adx, adx), multiply(ady, ady)),
    blift = sum(multiply(bdx, bdx), multiply(bdy, bdy)),
    clift = sum(multiply(cdx, cdx), multiply(cdy, cdy));
  return signOf(sum(sum(multiply(alift, bc), multiply(blift, ca)), multiply(clift, ab)));
}

/**
 * Orientation of three points: positive when a, b, c turn counter-clockwise, negative when they turn clockwise, zero
 * when they are collinear. The sign is exact (Shewchuk's filtered predicate); the magnitude approximates twice the
 * triangle's signed area.
 */
export function orient2d(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const left = (ax - cx) * (by - cy),
    right = (ay - cy) * (bx - cx),
    det = left - right;
  // When the two products differ in sign (or one is zero), the rounded difference has the exact sign.
  let total: number;
  if (left > 0) {
    if (right <= 0) return det;
    total = left + right;
  } else if (left < 0) {
    if (right >= 0) return det;
    total = -left - right;
  } else return det;
  const bound = ORIENT_BOUND * total;
  if (det >= bound || -det >= bound) return det;
  return orientExact(ax, ay, bx, by, cx, cy);
}

/**
 * In-circle test: positive when d lies inside the circle through a, b, c (given counter-clockwise), negative when it
 * lies outside, zero when the four points are cocircular. The sign is exact (Shewchuk's filtered predicate).
 */
export function incircle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const adx = ax - dx,
    bdx = bx - dx,
    cdx = cx - dx,
    ady = ay - dy,
    bdy = by - dy,
    cdy = cy - dy;
  const bdxcdy = bdx * cdy,
    cdxbdy = cdx * bdy,
    alift = adx * adx + ady * ady;
  const cdxady = cdx * ady,
    adxcdy = adx * cdy,
    blift = bdx * bdx + bdy * bdy;
  const adxbdy = adx * bdy,
    bdxady = bdx * ady,
    clift = cdx * cdx + cdy * cdy;
  const det = alift * (bdxcdy - cdxbdy) + blift * (cdxady - adxcdy) + clift * (adxbdy - bdxady);
  const permanent =
    (Math.abs(bdxcdy) + Math.abs(cdxbdy)) * alift +
    (Math.abs(cdxady) + Math.abs(adxcdy)) * blift +
    (Math.abs(adxbdy) + Math.abs(bdxady)) * clift;
  const bound = INCIRCLE_BOUND * permanent;
  if (det > bound || -det > bound) return det;
  return incircleExact(ax, ay, bx, by, cx, cy, dx, dy);
}

// ---- The mesh ----

const FIXED = 1, // a constraint edge: never flipped
  PARITY = 2; // crossing the edge toggles inside / outside (an odd number of loops run along it)

/** The next half-edge of the same triangle (counter-clockwise). */
const next = (e: number) => (e % 3 === 2 ? e - 2 : e + 1);
/** The previous half-edge of the same triangle. */
const prev = (e: number) => (e % 3 === 0 ? e + 2 : e - 1);
const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);

class Triangulation {
  /** Coordinates, 2 per vertex; the super-triangle's corners are the last 3 vertices. */
  readonly x: Float64Array;
  /** Vertex each half-edge starts from. */
  readonly tv: Int32Array;
  /** Opposite half-edge, or -1 on the super-triangle's border. */
  readonly tw: Int32Array;
  /** FIXED and PARITY bits per half-edge (both halves of an edge carry the same bits). */
  readonly fl: Uint8Array;
  /** One half-edge leaving each vertex (-1 before it is inserted). */
  readonly vh: Int32Array;
  /** Number of real vertices (the super-triangle's corners come after them). */
  readonly real: number;
  /** Triangles in use. */
  nt = 1;
  /** The triangle the next walk starts from. */
  last = 0;
  /** State of the walk's xorshift generator (fixed seed: deterministic output). */
  random = 0x2545f491;
  /** Flips left before the input is declared pathological. */
  budget = 0;

  constructor(x: Float64Array, real: number, triangles: number) {
    this.x = x;
    this.real = real;
    this.tv = new Int32Array(3 * triangles);
    this.tw = new Int32Array(3 * triangles).fill(-1);
    this.fl = new Uint8Array(3 * triangles);
    this.vh = new Int32Array(real + 3).fill(-1);
    for (let k = 0; k < 3; k++) {
      this.tv[k] = real + k;
      this.vh[real + k] = k;
    }
  }

  orient(a: number, b: number, c: number): number {
    const x = this.x;
    return orient2d(x[2 * a], x[2 * a + 1], x[2 * b], x[2 * b + 1], x[2 * c], x[2 * c + 1]);
  }

  inCircle(a: number, b: number, c: number, d: number): number {
    const x = this.x;
    return incircle(x[2 * a], x[2 * a + 1], x[2 * b], x[2 * b + 1], x[2 * c], x[2 * c + 1], x[2 * d], x[2 * d + 1]);
  }

  link(a: number, b: number): void {
    this.tw[a] = b;
    if (b >= 0) this.tw[b] = a;
  }

  /** Where point p lies: 4 * triangle + 3 inside the triangle, or 4 * triangle + k on its edge k. */
  locate(p: number): number {
    const { tv, tw } = this;
    let t = this.last;
    for (let steps = 3 * this.nt + 64; steps > 0; steps--) {
      // Stochastic walk: test the edges from a pseudo-random one, so the walk cannot cycle.
      let r = this.random;
      r ^= r << 13;
      r ^= r >>> 17;
      r ^= r << 5;
      this.random = r;
      const k0 = (r >>> 0) % 3;
      let exit = -1,
        on = -1;
      for (let i = 0; i < 3; i++) {
        const k = (k0 + i) % 3,
          e = 3 * t + k,
          o = this.orient(tv[e], tv[next(e)], p);
        if (o < 0) {
          exit = e;
          break;
        }
        if (o === 0) on = k;
      }
      if (exit < 0) return 4 * t + (on < 0 ? 3 : on);
      const g = tw[exit];
      if (g < 0) break;
      t = (g / 3) | 0;
    }
    return this.scan(p);
  }

  /** `locate` by testing every triangle: the fallback when a walk runs too long. */
  scan(p: number): number {
    const tv = this.tv;
    for (let t = 0; t < this.nt; t++) {
      let on = -1,
        k = 0;
      for (; k < 3; k++) {
        const e = 3 * t + k,
          o = this.orient(tv[e], tv[next(e)], p);
        if (o < 0) break;
        if (o === 0) on = k;
      }
      if (k === 3) return 4 * t + (on < 0 ? 3 : on);
    }
    throw new RangeError(
      `triangulate: point ${p} fell outside the bounding triangle; pass coordinates of moderate size`,
    );
  }

  insert(p: number): void {
    const where = this.locate(p),
      t = where >> 2,
      k = where & 3;
    if (k === 3) this.splitTriangle(t, p);
    else this.splitEdge(3 * t + k, p);
  }

  /** Splits triangle t, (a, b, c), at p into (a, b, p), (b, c, p) and (c, a, p), then restores the Delaunay property. */
  splitTriangle(t: number, p: number): void {
    const { tv, tw, fl, vh } = this;
    const e0 = 3 * t,
      e1 = e0 + 1,
      e2 = e0 + 2;
    const a = tv[e0],
      b = tv[e1],
      c = tv[e2];
    const f0 = 3 * this.nt++,
      g0 = 3 * this.nt++;
    tv[f0] = b;
    tv[f0 + 1] = c;
    tv[f0 + 2] = p;
    tv[g0] = c;
    tv[g0 + 1] = a;
    tv[g0 + 2] = p;
    // (b, c, p) takes over the outer edge b→c and (c, a, p) the outer edge c→a
    this.link(f0, tw[e1]);
    fl[f0] = fl[e1];
    this.link(g0, tw[e2]);
    fl[g0] = fl[e2];
    tv[e2] = p;
    this.link(e1, f0 + 2);
    this.link(f0 + 1, g0 + 2);
    this.link(g0 + 1, e2);
    fl[e1] = fl[e2] = fl[f0 + 1] = fl[f0 + 2] = fl[g0 + 1] = fl[g0 + 2] = 0;
    vh[a] = e0;
    vh[b] = f0;
    vh[c] = g0;
    vh[p] = e2;
    this.last = t;
    this.legalize([e0, f0, g0], false);
  }

  /**
   * Splits edge h, a→b between triangles (a, b, c) and (b, a, d), at p into (p, b, c), (p, a, d), (a, p, c) and
   * (b, p, d), then restores the Delaunay property.
   */
  splitEdge(h: number, p: number): void {
    const { tv, tw, fl, vh } = this;
    const g = tw[h],
      h1 = next(h),
      h2 = prev(h),
      g1 = next(g),
      g2 = prev(g);
    const a = tv[h],
      b = tv[h1],
      c = tv[h2],
      d = tv[g2],
      f = fl[h];
    const A = 3 * this.nt++,
      B = 3 * this.nt++;
    tv[A] = a;
    tv[A + 1] = p;
    tv[A + 2] = c;
    tv[B] = b;
    tv[B + 1] = p;
    tv[B + 2] = d;
    // (a, p, c) takes over the outer edge c→a and (b, p, d) the outer edge d→b
    this.link(A + 2, tw[h2]);
    fl[A + 2] = fl[h2];
    this.link(B + 2, tw[g2]);
    fl[B + 2] = fl[g2];
    tv[h] = p;
    tv[g] = p;
    this.link(h, B);
    this.link(g, A);
    this.link(h2, A + 1);
    this.link(g2, B + 1);
    fl[h] = fl[B] = fl[g] = fl[A] = f;
    fl[h2] = fl[A + 1] = fl[g2] = fl[B + 1] = 0;
    vh[p] = h;
    vh[a] = A;
    vh[b] = h1;
    vh[c] = h2;
    vh[d] = g2;
    this.last = (h / 3) | 0;
    this.legalize([h1, g1, A + 2, B + 2], false);
  }

  /**
   * Flips edge h, a→b between triangles (a, b, c) and (b, a, d), to c–d: the triangles become (a, d, c) and (b, c, d).
   * Afterwards h is a→d, next(h) d→c, prev(h) c→a; tw[h] (call it g) is b→c, next(g) c→d, prev(g) d→b.
   */
  flip(h: number): void {
    const { tv, tw, fl, vh } = this;
    const g = tw[h],
      h1 = next(h),
      h2 = prev(h),
      g1 = next(g),
      g2 = prev(g);
    const a = tv[h],
      b = tv[g],
      c = tv[h2],
      d = tv[g2];
    const ad = tw[g1],
      bc = tw[h1],
      fad = fl[g1],
      fbc = fl[h1];
    tv[h1] = d;
    tv[g1] = c;
    this.link(h, ad);
    fl[h] = fad;
    this.link(g, bc);
    fl[g] = fbc;
    this.link(h1, g1);
    fl[h1] = fl[g1] = 0;
    vh[a] = h;
    vh[b] = g;
    vh[c] = h2;
    vh[d] = g2;
  }

  /**
   * Lawson's flips: pops edges and flips each whose opposite vertex lies strictly inside the circumcircle of the
   * triangle on the popped half-edge's side (constraint edges stay). After an insertion the stack holds the edges
   * opposite the new point and only the two edges opposite it are pushed back (`all` false); otherwise all four outer
   * edges of each flipped quadrilateral are.
   */
  legalize(stack: number[], all: boolean): void {
    const { tv, tw, fl } = this;
    while (stack.length > 0) {
      const e = stack.pop() as number,
        g = tw[e];
      if (g < 0 || fl[e] & FIXED) continue;
      if (this.inCircle(tv[e], tv[next(e)], tv[prev(e)], tv[prev(g)]) <= 0) continue;
      if (--this.budget < 0)
        throw new RangeError(
          'triangulate: gave up after too many edge flips; the input is pathological (check for self-intersecting loops or extreme coordinates)',
        );
      this.flip(e);
      stack.push(e, prev(g));
      if (all) stack.push(prev(e), g);
    }
  }

  /** The half-edge u→w, or -1 when u and w are not neighbours. */
  find(u: number, w: number): number {
    const { tv, tw } = this,
      first = this.vh[u];
    let e = first;
    do {
      if (tv[next(e)] === w) return e;
      e = tw[prev(e)];
    } while (e >= 0 && e !== first);
    // A super-triangle corner's fan is open: turn clockwise from the first half-edge too.
    if (e < 0)
      for (let g = tw[first]; g >= 0; g = tw[e]) {
        e = next(g);
        if (e === first) break;
        if (tv[next(e)] === w) return e;
      }
    return -1;
  }

  /** The half-edge u→w of an edge with triangles on both sides (searched around its real end). */
  edge(u: number, w: number): number {
    return u < this.real ? this.find(u, w) : this.tw[this.find(w, u)];
  }

  /** Whether v lies on the ray from a through b (given that a, b and v are collinear and v is not a). */
  ahead(a: number, b: number, v: number): boolean {
    const x = this.x;
    return (
      sign(x[2 * v] - x[2 * a]) * sign(x[2 * b] - x[2 * a]) >= 0 &&
      sign(x[2 * v + 1] - x[2 * a + 1]) * sign(x[2 * b + 1] - x[2 * a + 1]) >= 0
    );
  }

  /** Whether segments c–d and a–b cross at a point interior to both. */
  crosses(c: number, d: number, a: number, b: number): boolean {
    return (
      sign(this.orient(a, b, c)) * sign(this.orient(a, b, d)) < 0 &&
      sign(this.orient(c, d, a)) * sign(this.orient(c, d, b)) < 0
    );
  }

  /** Makes segment a–b a chain of mesh edges (split at the vertices on it) and marks them as constraints. */
  constrain(a: number, b: number, seeds: number[]): void {
    const { tw, fl } = this;
    for (let guard = this.real; a !== b; guard--) {
      if (guard < 0)
        throw new RangeError(`triangulate: boundary edge ${a}-${b} could not be recovered; report this input`);
      const v = this.recover(a, b, seeds),
        e = this.find(a, v),
        g = tw[e];
      fl[e] = (fl[e] | FIXED) ^ PARITY;
      fl[g] = (fl[g] | FIXED) ^ PARITY;
      a = v;
    }
  }

  /**
   * Makes a–v an edge, where v is b or the vertex nearest a on segment a–b, by flipping the edges the segment crosses
   * (Sloan 1993); returns v. Every flipped edge's quadrilateral goes on `seeds` for the final Lawson pass.
   */
  recover(a: number, b: number, seeds: number[]): number {
    const { tv, tw, fl } = this;
    // Around a: the edge to b, an edge along a–b, or the triangle segment a–b leaves a through.
    const first = this.vh[a];
    let e = first,
      h = -1;
    do {
      const x = tv[next(e)];
      if (x === b) return b;
      const o = this.orient(a, b, x);
      if (o === 0 && this.ahead(a, b, x)) return x;
      if (o < 0 && this.orient(a, b, tv[prev(e)]) > 0) {
        h = next(e); // crossed from its right end to its left end (seen along a→b)
        break;
      }
      e = tw[prev(e)];
    } while (e >= 0 && e !== first);
    if (h < 0) throw new RangeError(`triangulate: boundary edge ${a}-${b} could not be started; report this input`);
    // Walk along a→b, collecting the crossed edges as (right, left) vertex pairs, up to b or a vertex on the segment.
    const crossed: number[] = [];
    let v = -1;
    for (let steps = this.nt; ; steps--) {
      if (steps < 0)
        throw new RangeError(`triangulate: boundary edge ${a}-${b} could not be followed; report this input`);
      if (fl[h] & FIXED)
        throw new TypeError(
          `triangulate: boundary edges ${a}-${b} and ${tv[h]}-${tv[next(h)]} cross; loops may share points but must not intersect`,
        );
      crossed.push(tv[h], tv[next(h)]);
      const g = tw[h],
        z = tv[prev(g)];
      if (z === b) {
        v = b;
        break;
      }
      const o = this.orient(a, b, z);
      if (o === 0) {
        v = z;
        break;
      }
      h = o > 0 ? next(g) : prev(g);
    }
    // Sloan: flip crossed edges whose quadrilateral is strictly convex; a new diagonal that still crosses goes back on
    // the queue, as does an edge that cannot be flipped yet.
    const k = crossed.length / 2;
    let limit = 10000 + 64 * k * k;
    for (let i = 0; i < crossed.length; i += 2) {
      if (--limit < 0)
        throw new RangeError(
          `triangulate: boundary edge ${a}-${b} needs too many flips; the input is pathological (check for self-intersecting loops)`,
        );
      const u = crossed[i],
        w = crossed[i + 1],
        f = this.edge(u, w),
        g = tw[f],
        c = tv[prev(f)],
        d = tv[prev(g)];
      if (sign(this.orient(c, d, u)) * sign(this.orient(c, d, w)) >= 0) {
        crossed.push(u, w);
        continue;
      }
      this.flip(f);
      if (this.crosses(c, d, a, v)) crossed.push(c, d);
      seeds.push(f, next(f), prev(f), g, prev(g));
    }
    return v;
  }
}

/** Hilbert-curve index of a cell of a 65536 x 65536 grid (the published xy-to-d conversion). */
function hilbert(qx: number, qy: number): number {
  let x = qx,
    y = qy,
    d = 0;
  for (let s = 0x8000; s > 0; s >>= 1) {
    const rx = x & s ? 1 : 0,
      ry = y & s ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = 0xffff - x;
        y = 0xffff - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

/**
 * Biased randomized insertion order: the points shuffled with a fixed seed, split into rounds of doubling size (the
 * last half, the quarter before it, ...), each round sorted along a Hilbert curve so consecutive points are close.
 */
function insertionOrder(points: Uint32Array, x: Float64Array, box: readonly number[]): Uint32Array {
  const m = points.length;
  let r = 0x6d2b79f5;
  for (let i = m - 1; i > 0; i--) {
    r ^= r << 13;
    r ^= r >>> 17;
    r ^= r << 5;
    const j = (r >>> 0) % (i + 1),
      t = points[i];
    points[i] = points[j];
    points[j] = t;
  }
  const [minX, minY, maxX, maxY] = box,
    sx = maxX > minX ? 0x10000 / (maxX - minX) : 0,
    sy = maxY > minY ? 0x10000 / (maxY - minY) : 0,
    key = new Float64Array(x.length / 2); // by point index
  for (let i = 0; i < m; i++) {
    const p = points[i],
      qx = Math.min(0xffff, Math.floor((x[2 * p] - minX) * sx)),
      qy = Math.min(0xffff, Math.floor((x[2 * p + 1] - minY) * sy));
    key[p] = hilbert(qx, qy);
  }
  for (let end = m; end > 0; ) {
    const start = end > 64 ? end >> 1 : 0;
    points.subarray(start, end).sort((p, q) => key[p] - key[q] || p - q);
    end = start;
  }
  return points;
}

/**
 * Constrained Delaunay triangulation of a 2D domain bounded by closed loops: a trimmed B-rep face in its surface's
 * parameter space.
 *
 * - `xy`: interleaved x, y coordinates of every point (Float64Array or number[]).
 * - `loops`: arrays of point indices; each loop is a closed boundary (the last point connects to the first) whose
 *   edges become constraint edges. Orientation does not matter; nesting decides inside by the even-odd rule (a point
 *   is in the domain when it is inside an odd number of loops). Loops may share points and touch at them; repeated
 *   consecutive indices (a degenerate pole) count as one point.
 * - Points no loop references are free interior (Steiner) points; those outside the domain are ignored.
 * - Points with identical coordinates are merged: the triangles use the first (lowest) index. A point lying exactly
 *   on a loop edge splits that edge.
 *
 * Exact predicates make collinear and cocircular inputs safe, and the output is deterministic. Throws a TypeError for
 * non-finite coordinates, a loop with fewer than 3 distinct points, or loops that cross; a RangeError for an index out
 * of range or a pathological input that would need an unbounded number of flips.
 * @returns Triangle vertex indices, 3 per triangle, counter-clockwise in xy, covering exactly the domain.
 * @example
 * // A unit square with a free point in the middle: 4 triangles.
 * const triangles = triangulate([0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5], [[0, 1, 2, 3]]);
 */
export function triangulate(xy: ArrayLike<number>, loops: readonly ArrayLike<number>[]): Uint32Array {
  if (!xy || typeof xy.length !== 'number' || xy.length % 2 !== 0)
    throw new TypeError('triangulate: xy must hold interleaved x, y coordinates; pass an even count of numbers');
  if (!loops || typeof loops.length !== 'number')
    throw new TypeError('triangulate: loops must be an array of point-index arrays; pass [] for no boundary');
  const n = xy.length / 2,
    x = new Float64Array(2 * n + 6);
  let minX = Number.POSITIVE_INFINITY,
    minY = Number.POSITIVE_INFINITY,
    maxX = Number.NEGATIVE_INFINITY,
    maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const u = xy[2 * i],
      v = xy[2 * i + 1];
    if (!Number.isFinite(u) || !Number.isFinite(v))
      throw new TypeError(`triangulate: point ${i} is (${u}, ${v}); pass finite coordinates`);
    x[2 * i] = u;
    x[2 * i + 1] = v;
    if (u < minX) minX = u;
    if (u > maxX) maxX = u;
    if (v < minY) minY = v;
    if (v > maxY) maxY = v;
  }

  // Merge points with identical coordinates into the lowest index.
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((i, j) => x[2 * i] - x[2 * j] || x[2 * i + 1] - x[2 * j + 1] || i - j);
  const rep = new Uint32Array(n);
  for (let k = 0; k < n; k++) {
    const i = order[k],
      j = k > 0 ? order[k - 1] : i;
    rep[i] = k > 0 && x[2 * i] === x[2 * j] && x[2 * i + 1] === x[2 * j + 1] ? rep[j] : i;
  }

  // The loops in merged indices, without repeated consecutive points.
  const rings: number[][] = [],
    stamp = new Int32Array(n).fill(-1);
  for (let l = 0; l < loops.length; l++) {
    const loop = loops[l];
    if (!loop || typeof loop.length !== 'number')
      throw new TypeError(`triangulate: loop ${l} is not an array of point indices; pass one index array per loop`);
    const ring: number[] = [];
    let distinct = 0;
    for (let k = 0; k < loop.length; k++) {
      const i = loop[k];
      if (!Number.isInteger(i)) throw new TypeError(`triangulate: loop ${l} entry ${k} is ${i}; pass integer indices`);
      if (i < 0 || i >= n)
        throw new RangeError(
          `triangulate: loop ${l} entry ${k} is ${i}, but there are ${n} points; pass indices from 0 to ${n - 1}`,
        );
      const r = rep[i];
      if (stamp[r] !== l) {
        stamp[r] = l;
        distinct++;
      }
      if (ring.length === 0 || ring[ring.length - 1] !== r) ring.push(r);
    }
    while (ring.length > 1 && ring[ring.length - 1] === ring[0]) ring.pop();
    if (distinct < 3)
      throw new TypeError(
        `triangulate: loop ${l} has ${distinct} distinct point(s); a boundary loop needs at least 3, so drop or repair it`,
      );
    rings.push(ring);
  }
  if (rings.length === 0) return new Uint32Array(0);

  // The super-triangle: far enough out that every point is strictly inside it. The predicates are exact, so its size
  // only has to keep the arithmetic clear of overflow and underflow.
  const cx = (minX + maxX) / 2,
    cy = (minY + maxY) / 2,
    size = Math.max(maxX - minX, maxY - minY, 1e-9 * (Math.abs(cx) + Math.abs(cy)));
  if (!(size > 1e-60 && size < 1e60 && Math.abs(cx) + Math.abs(cy) < 1e60))
    throw new RangeError(
      `triangulate: the points span ${size} around (${cx}, ${cy}); scale them to a moderate range (1e-60 to 1e60)`,
    );
  x[2 * n] = cx - 20 * size;
  x[2 * n + 1] = cy - 10 * size;
  x[2 * n + 2] = cx + 20 * size;
  x[2 * n + 3] = cy - 10 * size;
  x[2 * n + 4] = cx;
  x[2 * n + 5] = cy + 20 * size;

  let unique = 0;
  for (let i = 0; i < n; i++) if (rep[i] === i) unique++;
  const points = new Uint32Array(unique);
  for (let i = 0, k = 0; i < n; i++) if (rep[i] === i) points[k++] = i;
  const mesh = new Triangulation(x, n, 2 * unique + 1);
  mesh.budget = 64 * (unique + 3) + 10000;
  for (const p of insertionOrder(points, x, [minX, minY, maxX, maxY])) mesh.insert(p);

  // Constraints, then Lawson flips of every edge whose triangles changed.
  const seeds: number[] = [];
  for (const ring of rings)
    for (let k = 0; k < ring.length; k++) mesh.constrain(ring[k], ring[(k + 1) % ring.length], seeds);
  mesh.budget = 64 * (unique + 3) + 4 * seeds.length + 10000;
  mesh.legalize(seeds, true);

  // Even-odd fill from a super-triangle corner (outside every loop): crossing a PARITY edge toggles inside.
  const { tv, tw, fl, nt } = mesh,
    side = new Int8Array(nt).fill(-1),
    stack = [(mesh.vh[n] / 3) | 0];
  side[stack[0]] = 0;
  while (stack.length > 0) {
    const t = stack.pop() as number;
    for (let k = 0; k < 3; k++) {
      const e = 3 * t + k,
        g = tw[e];
      if (g < 0) continue;
      const u = (g / 3) | 0;
      if (side[u] >= 0) continue;
      side[u] = side[t] ^ (fl[e] & PARITY ? 1 : 0);
      stack.push(u);
    }
  }
  const inside = (t: number) => side[t] === 1 && tv[3 * t] < n && tv[3 * t + 1] < n && tv[3 * t + 2] < n;
  let count = 0;
  for (let t = 0; t < nt; t++) if (inside(t)) count++;
  const out = new Uint32Array(3 * count);
  for (let t = 0, o = 0; t < nt; t++)
    if (inside(t)) {
      out[o++] = tv[3 * t];
      out[o++] = tv[3 * t + 1];
      out[o++] = tv[3 * t + 2];
    }
  return out;
}

/**
 * The edges of a triangulation that are not constraint edges: those shared by two triangles that are not an edge of
 * any loop. The tessellator tests these for refinement and calls {@link triangulate} again with more free points.
 * @param triangles Triangle vertex indices as {@link triangulate} returns them.
 * @param loops The loops given to {@link triangulate}.
 * @returns Point index pairs, 2 per edge (smaller index first), each edge once, in order of first appearance.
 */
export function interiorEdges(triangles: Uint32Array, loops: readonly ArrayLike<number>[]): Uint32Array {
  if (triangles.length % 3 !== 0)
    throw new TypeError('interiorEdges: triangles must hold 3 indices per triangle; pass what triangulate returns');
  let top = 0;
  for (let i = 0; i < triangles.length; i++) if (triangles[i] > top) top = triangles[i];
  for (const loop of loops) for (let k = 0; k < loop.length; k++) if (loop[k] > top) top = loop[k];
  const span = top + 1;
  if (span > 0x4000000)
    throw new RangeError(`interiorEdges: point index ${top} is too large; pass at most 67,108,864 points`);
  const key = (a: number, b: number) => (a < b ? a * span + b : b * span + a);
  const constraint = new Set<number>();
  for (const loop of loops)
    for (let k = 0; k < loop.length; k++) constraint.add(key(loop[k], loop[(k + 1) % loop.length]));
  const uses = new Map<number, number>();
  for (let i = 0; i < triangles.length; i++) {
    const edge = key(triangles[i], triangles[next(i)]);
    uses.set(edge, (uses.get(edge) ?? 0) + 1);
  }
  const out: number[] = [];
  for (const [edge, count] of uses)
    if (count === 2 && !constraint.has(edge)) out.push(Math.floor(edge / span), edge % span);
  return new Uint32Array(out);
}
