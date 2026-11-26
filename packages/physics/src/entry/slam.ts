// The slam of a body striking the water (SEA-14): the load of the water it must set moving as it goes in, from the
// axisymmetric Wagner problem and Korobkin's modified Logvinovich model, for a body of any shape. Sources (papers, read
// as text; no code; docs/clean-room.md "Water entry and exit"):
// - H. Wagner, "Uber Stoss- und Gleitvorgange an der Oberflache von Flussigkeiten", ZAMM 12, 193-215, 1932, in the
//   axisymmetric form of A. A. Korobkin and Y.-M. Scolan (J. Fluid Mech. 549, 2006) as T. Hulin, L. Tassin and A.
//   Korobkin, "Gravity effects in water impact models", J. Fluid Mech. 944, A9, 2022,
//   https://doi.org/10.1017/jfm.2022.448, eq. 3.3, write it: the wetted radius c of a body of shape f(r) at penetration h
//   solves int_0^{pi/2} sin(g) f(c sin g) dg = h, and the potential on the wetted disc is -(2 v / pi) sqrt(c^2 - r^2).
// - A. A. Korobkin, "Analytical models of water impact", Eur. J. Appl. Math. 15, 821-838, 2004 (the modified Logvinovich
//   model), in the form of Hulin et al. eq. 2.17 and their split 2.18-2.19 (after Tassin et al. 2013): the pressure on
//   the body P = -rho (phi_t + phi_r^2 / (2 (1 + f_r^2)) + (f - h) dv/dt + v^2 / 2 + (f - h) g), integrated where the
//   speed-dependent part is positive; the acceleration part is the added mass of the wetted disc, (4/3) rho c^3, and the
//   gravity part the hydrostatic pressure, which the solver takes from the sea itself.
// The body's shape f(r) is its equivalent body of revolution about the surface normal through its lowest point: at each
// height z above that point, the radius whose disc has the area of the body's section there (the section's area is the
// projection of the body's surface below it, exact for any closed mesh).
//
// Checked against the measured slam of a sphere: the impact drag coefficient F / (rho v^2 pi R^2 / 2) peaks at about 1
// at 10 to 20 percent of the radius in (A. Shiffman and D. C. Spencer, AMP Report 42.1R, 1945, as J. T. Antolik, J. L.
// Belden, N. B. Speirs and D. M. Harris, "Slamming forces during water entry of a simple harmonic oscillator", J. Fluid
// Mech. 976, 2023, arXiv 2304.08672, measure it at 2 to 6 m/s; N. B. Speirs, Z. Pan, J. Belden and T. T. Truscott, J.
// Fluid Mech. 863, 2019, arXiv 1806.11453, use C_max of about 1), and against Wagner's exact wetted radius of a cone.

/** The equivalent body of revolution: heights above the lowest point and the radius of the section at each. */
export interface SlamProfile {
  /** Heights z_k above the lowest point, m, from 0, rising. */
  readonly heights: Float64Array;
  /** The section's equivalent radius sqrt(A / pi) at each height, m, not falling. */
  readonly radii: Float64Array;
}

/** The slam at an instant: the wetted radius, its rate and the force of the water's motion along the normal. */
export interface Slam {
  /** Wetted radius, m. */
  c: number;
  /** Its rate, m/s. */
  rate: number;
  /** The speed-dependent force pushing the body back out along the normal, N (0 or more). */
  force: number;
  /** The added mass of the wetted disc, (4/3) rho c^3, kg. */
  addedMass: number;
}

import { cos, sin } from '@margoengine/math/pinned';

/** Points of the Wagner condition's quadrature over gamma and of the pressure's over the wetted disc. */
const WAGNER_POINTS = 96;
const PRESSURE_POINTS = 96;
/** The quadratures' sines and cosines, from the pinned functions, so a slam gives the same bits everywhere. */
const WAGNER_SIN = Float64Array.from({ length: WAGNER_POINTS }, (_, i) =>
  sin(((i + 0.5) / WAGNER_POINTS) * (Math.PI / 2)),
);
const PRESSURE_SIN = Float64Array.from({ length: PRESSURE_POINTS }, (_, i) =>
  sin(((i + 0.5) / PRESSURE_POINTS) * (Math.PI / 2)),
);
const PRESSURE_COS = Float64Array.from({ length: PRESSURE_POINTS }, (_, i) =>
  cos(((i + 0.5) / PRESSURE_POINTS) * (Math.PI / 2)),
);

/**
 * The area of the section a plane cuts from a closed mesh: `world` holds its vertices (x, y, z each), `indices` its
 * triangles wound outward, and the plane is the points whose height along the unit `normal` is `level`. The section's
 * area is minus the projection on the normal of the surface below the plane (a closed surface's area vectors add to 0),
 * exact for any closed mesh, convex or not.
 */
export function sectionArea(
  world: ArrayLike<number>,
  indices: ArrayLike<number>,
  normal: readonly [number, number, number],
  level: number,
): number {
  const [nx, ny, nz] = normal;
  let sum = 0;
  const poly = new Float64Array(12);
  for (let t = 0; t < indices.length; t += 3) {
    // Clip the triangle to the part below the plane (Sutherland-Hodgman against one plane), then add its area vector.
    let count = 0;
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e]!,
        b = indices[t + ((e + 1) % 3)]!,
        ax = world[3 * a]!,
        ay = world[3 * a + 1]!,
        az = world[3 * a + 2]!,
        bx = world[3 * b]!,
        by = world[3 * b + 1]!,
        bz = world[3 * b + 2]!,
        da = ax * nx + ay * ny + az * nz - level,
        db = bx * nx + by * ny + bz * nz - level;
      if (da <= 0) {
        poly[3 * count] = ax;
        poly[3 * count + 1] = ay;
        poly[3 * count + 2] = az;
        count++;
      }
      if (da <= 0 !== db <= 0) {
        const s = da / (da - db);
        poly[3 * count] = ax + s * (bx - ax);
        poly[3 * count + 1] = ay + s * (by - ay);
        poly[3 * count + 2] = az + s * (bz - az);
        count++;
      }
    }
    if (count < 3) continue;
    // Area vector of the clipped polygon, (1/2) sum (p_i - p_0) x (p_{i+1} - p_0), projected on the normal.
    const x0 = poly[0]!,
      y0 = poly[1]!,
      z0 = poly[2]!;
    for (let i = 1; i + 1 < count; i++) {
      const ux = poly[3 * i]! - x0,
        uy = poly[3 * i + 1]! - y0,
        uz = poly[3 * i + 2]! - z0,
        vx = poly[3 * i + 3]! - x0,
        vy = poly[3 * i + 4]! - y0,
        vz = poly[3 * i + 5]! - z0;
      sum += 0.5 * ((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz);
    }
  }
  return Math.max(0, -sum);
}

/**
 * The equivalent body of revolution of a closed mesh about the unit `normal` (up, out of the water) from its lowest
 * point, at `levels` heights from 0 to `top` m above it.
 */
export function slamProfile(
  world: ArrayLike<number>,
  indices: ArrayLike<number>,
  normal: readonly [number, number, number],
  lowest: number,
  top: number,
  levels: number,
): SlamProfile {
  const heights = new Float64Array(levels + 1),
    radii = new Float64Array(levels + 1);
  let r = 0;
  for (let k = 1; k <= levels; k++) {
    const z = (top * k) / levels;
    heights[k] = z;
    r = Math.max(r, Math.sqrt(sectionArea(world, indices, normal, lowest + z) / Math.PI));
    radii[k] = r;
  }
  return { heights, radii };
}

/** The profile's height f(r) at radius r and its slope df/dr there (Infinity past its widest radius). */
function shape(p: SlamProfile, r: number): [number, number] {
  const { heights, radii } = p,
    n = radii.length - 1;
  if (r >= radii[n]!) return [Infinity, Infinity];
  // The first level whose radius passes r: radii do not fall, so search them.
  let lo = 0,
    hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (radii[mid]! <= r) lo = mid;
    else hi = mid;
  }
  const dr = radii[hi]! - radii[lo]!,
    dz = heights[hi]! - heights[lo]!;
  if (!(dr > 0)) return [heights[lo]!, Infinity];
  return [heights[lo]! + ((r - radii[lo]!) / dr) * dz, dz / dr];
}

/** Wagner's wetted radius at penetration `h`: the c where int_0^{pi/2} sin(g) f(c sin g) dg = h (0 for h <= 0). */
export function wagnerRadius(profile: SlamProfile, h: number): number {
  if (!(h > 0)) return 0;
  const widest = profile.radii[profile.radii.length - 1]!,
    integral = (c: number): number => {
      let sum = 0;
      for (let i = 0; i < WAGNER_POINTS; i++) {
        const sg = WAGNER_SIN[i]!,
          f = shape(profile, c * sg)[0];
        if (f === Infinity) return Infinity;
        sum += sg * f;
      }
      return (sum * (Math.PI / 2)) / WAGNER_POINTS;
    };
  // The integral rises with c; past the widest section the body's side is wall-sided and c stops there.
  if (integral(widest * (1 - 1e-9)) <= h) return widest;
  let lo = 0,
    hi = widest;
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi);
    if (integral(mid) < h) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * The slam of a body of `profile` at penetration `h` m, going in at `v` m/s along the normal, in water of density `rho`:
 * Wagner's wetted radius and its rate, the modified Logvinovich model's speed-dependent force (its positive pressure
 * over the wetted disc) and the wetted disc's added mass. No slam going out (v <= 0) or before contact (h <= 0).
 */
export function slam(profile: SlamProfile, h: number, v: number, rho: number, out?: Slam): Slam {
  const s = out ?? { c: 0, rate: 0, force: 0, addedMass: 0 };
  s.c = wagnerRadius(profile, h);
  s.addedMass = (4 / 3) * rho * s.c * s.c * s.c;
  s.rate = s.force = 0;
  if (!(h > 0 && v > 0 && s.c > 0)) return s;
  // dc/dt = (dc/dh) v, by a central difference over a small share of h.
  const e = 1e-3 * h,
    rate = ((wagnerRadius(profile, h + e) - wagnerRadius(profile, h - e)) / (2 * e)) * v;
  s.rate = rate;
  const c = s.c,
    k = (2 * v) / Math.PI;
  let force = 0;
  // Over the disc with r = c sin(theta): r dr = c^2 sin cos dtheta, sqrt(c^2 - r^2) = c cos, so the 1/sqrt terms stay finite.
  for (let i = 0; i < PRESSURE_POINTS; i++) {
    const sn = PRESSURE_SIN[i]!,
      cs = PRESSURE_COS[i]!,
      r = c * sn,
      fr = shape(profile, r)[1],
      slope = fr === Infinity ? Infinity : fr * fr,
      // -rho (phi_t + phi_r^2 / (2 (1 + f_r^2)) + v^2 / 2): phi_t = -k c c' / sqrt(c^2 - r^2), phi_r = k r / sqrt(...)
      p =
        rho *
        ((k * c * rate) / (c * cs) -
          (slope === Infinity ? 0 : (k * k * sn * sn) / (cs * cs * 2 * (1 + slope))) -
          (v * v) / 2);
    if (p > 0) force += p * 2 * Math.PI * c * c * sn * cs;
  }
  s.force = (force * (Math.PI / 2)) / PRESSURE_POINTS;
  return s;
}
