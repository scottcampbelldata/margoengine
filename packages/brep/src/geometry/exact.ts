// Exact geometric predicates for the modeler, from Shewchuk, "Adaptive Precision Floating-Point Arithmetic and Fast
// Robust Geometric Predicates" (1997): a floating-point filter first, exact expansion arithmetic only when the filter
// cannot decide. Decisions about topology (which side of a plane a point lies, whether a ray crosses a triangle) are
// made with these, so no tolerance decides them.

const EPSILON = 2 ** -53;
const SPLITTER = 2 ** 27 + 1;
const ORIENT3D_BOUND = (7 + 56 * EPSILON) * EPSILON;

/** Exact a * b (Two-Product with Dekker's split). */
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

/** Exact e + f of two expansions (Fast-Expansion-Sum with zero elimination). */
function sum(e: number[], f: number[]): number[] {
  if (!e.length) return f;
  if (!f.length) return e;
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
function scaleBy(e: number[], b: number): number[] {
  const h: number[] = [];
  if (!e.length || b === 0) return h;
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

function multiply(e: number[], f: number[]): number[] {
  let h: number[] = [];
  for (let i = 0; i < f.length; i++) h = sum(h, scaleBy(e, f[i]));
  return h;
}

const negate = (e: number[]) => e.map((v) => -v);
const signOf = (e: number[]) => (e.length ? e[e.length - 1] : 0);

/** The exact determinant of [a - d; b - d; c - d]. */
function orient3dExact(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): number {
  const ad = [difference(a[0], d[0]), difference(a[1], d[1]), difference(a[2], d[2])],
    bd = [difference(b[0], d[0]), difference(b[1], d[1]), difference(b[2], d[2])],
    cd = [difference(c[0], d[0]), difference(c[1], d[1]), difference(c[2], d[2])];
  const minor = (p: number[][], q: number[][]) => [
    sum(multiply(p[1], q[2]), negate(multiply(p[2], q[1]))),
    sum(multiply(p[2], q[0]), negate(multiply(p[0], q[2]))),
    sum(multiply(p[0], q[1]), negate(multiply(p[1], q[0]))),
  ];
  const bc = minor(bd, cd);
  return signOf(sum(sum(multiply(ad[0], bc[0]), multiply(ad[1], bc[1])), multiply(ad[2], bc[2])));
}

/**
 * Orientation of d against the plane through a, b and c: positive when d lies on the side a, b, c turn clockwise as
 * seen from (below the counter-clockwise side), negative on the other side, zero when the four points are coplanar.
 * The sign is exact; the magnitude approximates six times the signed volume of the tetrahedron.
 */
export function orient3d(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  d: readonly number[],
): number {
  const adx = a[0] - d[0],
    ady = a[1] - d[1],
    adz = a[2] - d[2],
    bdx = b[0] - d[0],
    bdy = b[1] - d[1],
    bdz = b[2] - d[2],
    cdx = c[0] - d[0],
    cdy = c[1] - d[1],
    cdz = c[2] - d[2],
    bdxcdy = bdx * cdy,
    cdxbdy = cdx * bdy,
    cdxady = cdx * ady,
    adxcdy = adx * cdy,
    adxbdy = adx * bdy,
    bdxady = bdx * ady,
    det = adz * (bdxcdy - cdxbdy) + bdz * (cdxady - adxcdy) + cdz * (adxbdy - bdxady),
    permanent =
      (Math.abs(bdxcdy) + Math.abs(cdxbdy)) * Math.abs(adz) +
      (Math.abs(cdxady) + Math.abs(adxcdy)) * Math.abs(bdz) +
      (Math.abs(adxbdy) + Math.abs(bdxady)) * Math.abs(cdz),
    bound = ORIENT3D_BOUND * permanent;
  if (det > bound || -det > bound) return det;
  return orient3dExact(a, b, c, d);
}
