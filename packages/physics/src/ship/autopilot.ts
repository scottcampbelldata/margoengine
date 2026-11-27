// A ship's autopilot (SEA-09): a heading held, and a track of waypoints followed. The heading controller places the poles of
// the ship's own manoeuvring model, linearised in sway and yaw at its speed (`Manoeuvring.linearize`), with an integral of
// the heading error so a steady wind or current leaves no offset: δ = -(k_v v + k_r r + k_ψ e + k_z ∫e). Pole placement by
// Ackermann's formula (J. Ackermann, "Der Entwurf linearer Regelungssysteme im Zustandsraum", Regelungstechnik 20, 1972; as
// textbooks restate it) works for a course-unstable hull such as KVLCC2, where a first-order Nomoto fit (Nomoto et al. 1957)
// has no steady turning to fit. Tracks follow lookahead-based line-of-sight steering (Breivik and Fossen, "Guidance laws
// for planar motion control", IEEE CDC 2008, eqs. 5 to 14, read): the cross-track error e = -(x - x_k) sin α_k +
// (z - z_k) cos α_k, the desired course χ_d = α_k + atan(-e / Δ), and a waypoint passed when the along-track distance left
// is under its acceptance radius; the heading ordered is the course less the drift angle atan2(v, u).

import { atan, atan2, cos, hypot, sin } from '@margoengine/math/pinned';

/** The four gains of the heading controller, on sway, yaw rate, heading error and its integral. */
export interface HeadingGains {
  readonly v: number;
  readonly r: number;
  readonly heading: number;
  readonly integral: number;
}

/** A 4 by 4 matrix, row major. */
type M4 = Float64Array;

const mul = (a: M4, b: M4): M4 => {
  const out = new Float64Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[4 * i + k]! * b[4 * k + j]!;
      out[4 * i + j] = s;
    }
  return out;
};

/** The last row of the inverse of `m` (4 by 4), by Gauss-Jordan with partial pivoting; null when singular. */
function lastRowOfInverse(m: M4): Float64Array | null {
  const a = Array.from({ length: 4 }, (_, i) => [
    ...m.subarray(4 * i, 4 * i + 4),
    ...[0, 0, 0, 0].map((_, j) => (i === j ? 1 : 0)),
  ]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    if (!(Math.abs(a[p]![c]!) > 1e-300)) return null;
    [a[c], a[p]] = [a[p]!, a[c]!];
    const d = a[c]![c]!;
    for (let k = 0; k < 8; k++) a[c]![k]! /= d;
    for (let r = 0; r < 4; r++)
      if (r !== c) {
        const f = a[r]![c]!;
        for (let k = 0; k < 8; k++) a[r]![k]! -= f * a[c]![k]!;
      }
  }
  return Float64Array.from(a[3]!.slice(4));
}

/**
 * The gains that put the closed loop's poles at `poles` (the roots of (s + ω)^2 (s^2 + 2 ζ ω s + ω^2) by default) for the
 * linear sway-yaw model `a` (2 by 2, on [v, r]) and `b` (on the rudder), with heading ψ' = r and the integral of its error.
 * State x = [v, r, e, ∫e]; the rudder δ = -k · x. Null when the rudder cannot steer the model (an uncontrollable pair).
 */
export function headingGains(
  a: readonly [number, number, number, number],
  b: readonly [number, number],
  omega: number,
  zeta = 0.8,
): HeadingGains | null {
  const A = Float64Array.of(a[0], a[1], 0, 0, a[2], a[3], 0, 0, 0, 1, 0, 0, 0, 0, 1, 0),
    B = Float64Array.of(b[0], b[1], 0, 0),
    // Controllability matrix [B, AB, A^2 B, A^3 B] as columns.
    C = new Float64Array(16);
  let col = B;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) C[4 * i + j] = col[i]!;
    const next = new Float64Array(4);
    for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) next[i]! += A[4 * i + k]! * col[k]!;
    col = next;
  }
  const last = lastRowOfInverse(C);
  if (!last) return null;
  // φ(A) for φ(s) = (s + ω)^2 (s^2 + 2ζω s + ω^2) = s^4 + c3 s^3 + c2 s^2 + c1 s + c0.
  const w = omega,
    c3 = 2 * w + 2 * zeta * w,
    c2 = w * w + 4 * zeta * w * w + w * w,
    c1 = 2 * w * w * w + 2 * zeta * w * w * w,
    c0 = w * w * w * w,
    I = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
    A2 = mul(A, A),
    A3 = mul(A2, A),
    A4 = mul(A3, A),
    phi = new Float64Array(16);
  for (let i = 0; i < 16; i++) phi[i] = A4[i]! + c3 * A3[i]! + c2 * A2[i]! + c1 * A[i]! + c0 * I[i]!;
  const k = new Float64Array(4);
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) k[j]! += last[i]! * phi[4 * i + j]!;
  return { v: k[0]!, r: k[1]!, heading: k[2]!, integral: k[3]! };
}

/** The angle wrapped into (-π, π]. */
export const wrap = (angle: number): number => {
  const a = angle % (2 * Math.PI);
  return a > Math.PI ? a - 2 * Math.PI : a <= -Math.PI ? a + 2 * Math.PI : a;
};

/** A track to follow: waypoints [x, z] on the ground plane, a lookahead and an acceptance radius, m. */
export interface ShipTrack {
  readonly waypoints: readonly (readonly [number, number])[];
  /** The lookahead distance Δ (default two ship lengths). */
  readonly lookahead?: number;
  /** How near along the track a waypoint counts as reached (default one ship length). */
  readonly acceptance?: number;
  /** Start again at the first waypoint after the last (default false: hold the last leg's course). */
  readonly loop?: boolean;
}

/** Where a ship stands against its track: the leg it is on (from waypoint `leg`), its course ordered and cross-track error. */
export interface TrackState {
  leg: number;
  course: number;
  crossTrack: number;
  done: boolean;
}

/**
 * Line-of-sight steering for a track at position (x, z): advances `state.leg` past waypoints reached and sets the course
 * ordered and the cross-track error (positive to port of the leg, as Breivik and Fossen's e with z to starboard).
 */
export function steerTrack(track: ShipTrack, x: number, z: number, length: number, state: TrackState): TrackState {
  const points = track.waypoints,
    n = points.length,
    lookahead = track.lookahead ?? 5 * length,
    acceptance = track.acceptance ?? length;
  for (let guard = 0; guard < n; guard++) {
    const k = state.leg,
      next = k + 1 < n ? k + 1 : track.loop ? 0 : -1;
    if (next < 0) break;
    const [xk, zk] = points[k]!,
      [xn, zn] = points[next]!,
      alpha = atan2(zn - zk, xn - xk),
      along = (x - xk) * cos(alpha) + (z - zk) * sin(alpha),
      total = hypot(xn - xk, zn - zk);
    if (total - along <= acceptance && (next !== 0 || track.loop)) {
      state.leg = next;
      if (next === n - 1 && !track.loop) break;
      continue;
    }
    break;
  }
  let k = state.leg,
    next = k + 1 < n ? k + 1 : track.loop ? 0 : -1;
  // Past the last waypoint without a loop: hold the last leg's line.
  state.done = next < 0;
  if (next < 0) {
    k = n - 2;
    next = n - 1;
  }
  const [xk, zk] = points[k]!,
    [xn, zn] = points[next]!,
    alpha = atan2(zn - zk, xn - xk),
    e = -(x - xk) * sin(alpha) + (z - zk) * cos(alpha);
  state.crossTrack = e;
  state.course = wrap(alpha + atan(-e / lookahead));
  return state;
}
