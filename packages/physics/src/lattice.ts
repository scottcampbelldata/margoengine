// The vortex-lattice core shared by sails (AERO-02, sail.ts) and wings (AERO-03, flight.ts): a surface of nc by ns quad
// panels, each carrying a horseshoe vortex, solved so the air passes no panel, with each panel's load from Kutta-Joukowski,
// or from a separated-flow law where the air meets it more steeply than the stall angle.
//
// The vortex-lattice method follows M. Ranneberg, "Direct Wing Design and Inverse Airfoil Identification with the
// Nonlinear Weissinger Method", arXiv:1501.04983v2 (2015), §2: each panel's bound segment lies on its
// quarter-chord line, its legs run along the chord to the trailing
// edge and from there downstream along the mean apparent wind to infinity; the circulations make the velocity normal to the
// surface vanish at every panel's three-quarter-chord point (a dense linear system, solved by Gaussian elimination with
// partial pivoting in a fixed order); each bound segment takes rho Gamma (V x l) from the local air V. A straight segment's
// induced velocity is Biot-Savart's closed form (Ranneberg, eq. 2) and a leg to infinity its limit (eq. 3).
import { hypot, sin } from '@margoengine/math/pinned';
import type { WingLatticeKernel } from './flight/lattice-kernel.js';
import type { Vec3 } from './math.js';

/** A lattice surface: its corners and, per panel (c + nc s), the air relative to it and the air's density. */
export interface LatticeSurface {
  /** Panels along the chord (leading edge to trailing edge). */
  readonly nc: number;
  /** Panels along the span. */
  readonly ns: number;
  /** Corner (c, s), c from 0 (leading edge) to nc, s from 0 to ns, in world space. */
  corner(c: number, s: number): Vec3;
  /** The air's velocity relative to each panel, m/s. */
  readonly relative: readonly Vec3[];
  /** The air's density at each panel, kg/m^3. */
  readonly density: readonly number[];
  /** Profile drag coefficient for panels in attached flow. Default 0. */
  readonly profileDrag?: number;
}

/**
 * The load on a separated panel from the air `v` relative to it (m/s), its unit normal, its area (m^2) and the air's
 * density, in N.
 */
export type SeparatedLaw = (v: Vec3, normal: Vec3, area: number, density: number) => Vec3;

/**
 * The loads a lattice gives: each panel's force (N), where it acts (the middle of its bound segment), its circulation, and,
 * when asked for, its slope: how fast its load along its normal grows with the air's speed through it along its normal
 * (N per m/s), the aerodynamic damping a solver holding the surface needs to take implicitly.
 */
export interface LatticeLoads {
  readonly forces: Vec3[];
  readonly points: Vec3[];
  readonly circulation: Float64Array;
  readonly slopes?: Float64Array;
}

/** The flat plate's separated law: the normal force C_N sin(a) q A across the panel, downwind (`drag` C_N, 1.17 square). */
export function flatPlate(drag: number): SeparatedLaw {
  return (v, normal, area, density) => {
    const speed = hypot(v[0], v[1], v[2]),
      vn = dot(v, normal);
    return scale(normal, 0.5 * density * area * drag * speed * vn);
  };
}

/**
 * Solves the lattice on `surface` and returns every panel's load; panels the air meets beyond `stall` take `separated`.
 * With `slopes`, each panel's slope too (`LatticeLoads.slopes`), at the cost of a second elimination.
 */
export function latticeLoads(
  surface: LatticeSurface,
  stall: number,
  separated: SeparatedLaw,
  slopes = false,
  native?: WingLatticeKernel,
): LatticeLoads {
  const { nc, ns, relative, density, profileDrag = 0 } = surface,
    n = nc * ns,
    at = (c: number, s: number) => surface.corner(c, s),
    boundA: Vec3[] = [],
    boundB: Vec3[] = [],
    colloc: Vec3[] = [],
    normal: Vec3[] = [],
    area: number[] = [];
  for (let s = 0; s < ns; s++)
    for (let c = 0; c < nc; c++) {
      const p00 = at(c, s),
        p10 = at(c + 1, s),
        p01 = at(c, s + 1),
        p11 = at(c + 1, s + 1),
        q0 = lerp(p00, p10, 0.75),
        q1 = lerp(p01, p11, 0.75),
        cross = crossOf(sub(p11, p00), sub(p01, p10)),
        length = hypot(cross[0], cross[1], cross[2]);
      boundA.push(lerp(p00, p10, 0.25));
      boundB.push(lerp(p01, p11, 0.25));
      colloc.push([(q0[0] + q1[0]) / 2, (q0[1] + q1[1]) / 2, (q0[2] + q1[2]) / 2]);
      normal.push(length > 0 ? scale(cross, 1 / length) : [0, 0, 0]);
      area.push(length / 2);
    }
  const points = boundA.map((a, m) => scale(add(a, boundB[m]!), 0.5)),
    forces: Vec3[] = points.map(() => [0, 0, 0]);
  // The wake leaves along the mean apparent wind.
  let mean: Vec3 = [0, 0, 0];
  for (const r of relative) mean = add(mean, r);
  const meanSpeed = hypot(mean[0], mean[1], mean[2]);
  if (!(meanSpeed > 1e-9))
    return { forces, points, circulation: new Float64Array(n), ...(slopes ? { slopes: new Float64Array(n) } : {}) };
  const wake = scale(mean, 1 / meanSpeed),
    // The horseshoe of panel m, unit circulation: from far down the wake to the trailing edge, along the chord to the bound
    // segment, across it, back along the chord and down the wake.
    horseshoe = (m: number, point: Vec3): Vec3 => {
      const s = (m - (m % nc)) / nc,
        tA = at(nc, s),
        tB = at(nc, s + 1);
      let u = semiInfinite(tA, wake, point, -1);
      u = add(u, segment(tA, boundA[m]!, point));
      u = add(u, segment(boundA[m]!, boundB[m]!, point));
      u = add(u, segment(boundB[m]!, tB, point));
      return add(u, semiInfinite(tB, wake, point, 1));
    };
  // a_km Gamma_m = -V_k . n_k
  const sinStall = sin(stall),
    speeds = relative.map((v) => hypot(v[0], v[1], v[2])),
    stalled = relative.map((v, m) => speeds[m]! > 1e-9 && abs(dot(v, normal[m]!)) / speeds[m]! > sinStall);
  let gamma: Float64Array;
  let inducedByNative: Float64Array | undefined;
  let answer: Float64Array | null = null;
  if (native) {
    const trailA = boundA.map((_, m) => at(nc, Math.floor(m / nc)));
    const trailB = boundA.map((_, m) => at(nc, Math.floor(m / nc) + 1));
    const result = native.solve(
      { boundA, boundB, trailA, trailB, collocation: colloc, normal, points, stalled, relative, speeds, wake },
      slopes,
    );
    gamma = result.circulation;
    inducedByNative = result.induced;
    if (slopes) answer = inverseDiagonal(result.influence!, n);
  } else {
    const matrix = new Float64Array(n * n);
    const rhs = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      if (stalled[k]) {
        // The separated law owns this panel's load. It contributes no attached horseshoe circulation.
        matrix[k * n + k] = 1;
        continue;
      }
      for (let m = 0; m < n; m++) if (!stalled[m]) matrix[k * n + m] = dot(horseshoe(m, colloc[k]!), normal[k]!);
      rhs[k] = -dot(relative[k]!, normal[k]!);
    }
    gamma = solve(matrix, rhs, n);
    // A panel's circulation answers the air's speed through it by row m of the inverse at column m.
    if (slopes) answer = inverseDiagonal(matrix, n);
  }
  const slope = slopes ? new Float64Array(n) : null;
  for (let m = 0; m < n; m++) {
    const v = relative[m]!,
      speed = speeds[m]!;
    if (!(speed > 1e-9)) continue;
    const nm = normal[m]!;
    if (stalled[m]) {
      forces[m] = separated(v, nm, area[m]!, density[m]!);
      if (slope) {
        // Whatever the law: its load along the normal a hair either side of this speed through the panel.
        const h = 1e-3 * speed,
          up = dot(separated(add(v, scale(nm, h)), nm, area[m]!, density[m]!), nm),
          down = dot(separated(sub(v, scale(nm, h)), nm, area[m]!, density[m]!), nm);
        slope[m] = abs(up - down) / (2 * h);
      }
      continue;
    }
    // Attached: Kutta-Joukowski on the bound segment, with the air there and every vortex's induced velocity.
    let induced: Vec3 = [0, 0, 0];
    if (inducedByNative) induced = [inducedByNative[3 * m]!, inducedByNative[3 * m + 1]!, inducedByNative[3 * m + 2]!];
    else
      for (let j = 0; j < n; j++) if (!stalled[j]) induced = add(induced, scale(horseshoe(j, points[m]!), gamma[j]!));
    const lift = crossOf(add(v, induced), sub(boundB[m]!, boundA[m]!));
    forces[m] = scale(lift, density[m]! * gamma[m]!);
    if (profileDrag > 0) {
      forces[m] = add(forces[m]!, scale(v, 0.5 * density[m]! * speed * area[m]! * profileDrag));
    }
    if (slope && answer) slope[m] = density[m]! * abs(dot(lift, nm)) * abs(answer[m]!);
  }
  return { forces, points, circulation: gamma, ...(slope ? { slopes: slope } : {}) };
}

/** |x|. */
function abs(x: number): number {
  return x < 0 ? -x : x;
}

/** The diagonal of the inverse, by in-place partial-pivot elimination of the owned n by n row-major matrix. */
function inverseDiagonal(a: Float64Array, n: number): Float64Array {
  const b = new Float64Array(n * n);
  for (let k = 0; k < n; k++) b[k * n + k] = 1;
  for (let col = 0; col < n; col++) {
    let pivot = col,
      best = abs(a[col * n + col]!);
    for (let row = col + 1; row < n; row++) {
      const v = abs(a[row * n + col]!);
      if (v > best) {
        best = v;
        pivot = row;
      }
    }
    if (!(best > 0)) continue;
    if (pivot !== col)
      for (let k = 0; k < n; k++) {
        let t = a[col * n + k]!;
        a[col * n + k] = a[pivot * n + k]!;
        a[pivot * n + k] = t;
        t = b[col * n + k]!;
        b[col * n + k] = b[pivot * n + k]!;
        b[pivot * n + k] = t;
      }
    for (let row = col + 1; row < n; row++) {
      const f = a[row * n + col]! / a[col * n + col]!;
      if (f === 0) continue;
      for (let k = col; k < n; k++) a[row * n + k]! -= f * a[col * n + k]!;
      for (let k = 0; k < n; k++) b[row * n + k]! -= f * b[col * n + k]!;
    }
  }
  // Back substitution of column m alone gives the inverse's column m; its entry m is all that is wanted.
  const out = new Float64Array(n),
    x = new Float64Array(n);
  for (let m = 0; m < n; m++) {
    for (let row = n - 1; row >= 0; row--) {
      let s = b[row * n + m]!;
      for (let k = row + 1; k < n; k++) s -= a[row * n + k]! * x[k]!;
      x[row] = a[row * n + row]! !== 0 ? s / a[row * n + row]! : 0;
    }
    out[m] = x[m]!;
  }
  return out;
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const crossOf = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const FOUR_PI = 12.566370614359172;

/** A core: closer to a segment's line than this share of its length, the point takes no velocity from it. */
const CORE = 1e-6;

/**
 * The velocity a straight vortex segment from r0 to r1 of unit circulation induces at m (Biot-Savart's closed form;
 * Ranneberg 2015, eq. 2): (r1 - r0) . ((r1 - m)/|r1 - m| - (r0 - m)/|r0 - m|) (r0 - m) x (r1 - r0) / (4 pi |(r0 - m) x (r1 - r0)|^2).
 */
function segment(r0: Vec3, r1: Vec3, m: Vec3): Vec3 {
  const d = sub(r1, r0),
    a = sub(r0, m),
    b = sub(r1, m),
    c = crossOf(a, d),
    cc = dot(c, c),
    dd = dot(d, d);
  if (!(cc > CORE * CORE * dd * dd)) return [0, 0, 0];
  const la = hypot(a[0], a[1], a[2]),
    lb = hypot(b[0], b[1], b[2]),
    k = (dot(d, b) / lb - dot(d, a) / la) / (FOUR_PI * cc);
  return scale(c, k);
}

/**
 * The velocity of a straight vortex leg of unit circulation from `start` to infinity along the unit `direction` at m (the
 * limit of the closed form, Ranneberg 2015, eq. 3), `sense` -1 for the leg that comes in from infinity.
 */
function semiInfinite(start: Vec3, direction: Vec3, m: Vec3, sense: number): Vec3 {
  const a = sub(start, m),
    c = crossOf(a, direction),
    cc = dot(c, c);
  if (!(cc > CORE * CORE)) return [0, 0, 0];
  const la = hypot(a[0], a[1], a[2]),
    k = (sense * (1 - dot(direction, a) / la)) / (FOUR_PI * cc);
  return scale(c, k);
}

/** Solves `matrix` x = `rhs` (n by n, row-major) by Gaussian elimination with partial pivoting, in a fixed order. */
export function solve(matrix: Float64Array, rhs: Float64Array, n: number): Float64Array {
  const a = matrix.slice(),
    b = rhs.slice();
  for (let col = 0; col < n; col++) {
    let pivot = col,
      best = a[col * n + col]! < 0 ? -a[col * n + col]! : a[col * n + col]!;
    for (let row = col + 1; row < n; row++) {
      const v = a[row * n + col]! < 0 ? -a[row * n + col]! : a[row * n + col]!;
      if (v > best) {
        best = v;
        pivot = row;
      }
    }
    if (!(best > 0)) continue;
    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        const t = a[col * n + k]!;
        a[col * n + k] = a[pivot * n + k]!;
        a[pivot * n + k] = t;
      }
      const t = b[col]!;
      b[col] = b[pivot]!;
      b[pivot] = t;
    }
    for (let row = col + 1; row < n; row++) {
      const f = a[row * n + col]! / a[col * n + col]!;
      if (f === 0) continue;
      for (let k = col; k < n; k++) a[row * n + k]! -= f * a[col * n + k]!;
      b[row]! -= f * b[col]!;
    }
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let s = b[row]!;
    for (let k = row + 1; k < n; k++) s -= a[row * n + k]! * x[k]!;
    x[row] = a[row * n + row]! !== 0 ? s / a[row * n + row]! : 0;
  }
  return x;
}
