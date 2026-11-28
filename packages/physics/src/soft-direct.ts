// Directing a soft body for film (P8, point 7): cues placed at a time, and a target shape the body is drawn toward without
// a net force or torque, so its momentum and angular momentum stay the physics' own.
//
// The target pull is shape matching's goal (Matthias Mueller, Bruno Heidelberger, Matthias Teschner and Markus Gross,
// "Meshless Deformations Based on Shape Matching", ACM TOG 24(3), SIGGRAPH 2005): the target, centred on its mass-weighted
// centre, turned by the rotation R that best fits it to the particles now (the rotational part of A = sum m p q^T, p and q
// the particles' and the target's offsets from their centres) and placed at the particles' centre of mass. A spring
// m omega^2 (g - x) on each particle then sums to no force, since sum m (g - x) = R sum m q - sum m p = 0, and to no torque
// about the centre, since sum m p x R q is the axial vector of A R^T - R A^T, which is 0 because A R^T is the symmetric
// factor of A's polar decomposition. R is found by the rotation extraction of Matthias Mueller, Jan Bender, Nuttapong
// Chentanez and Miles Macklin, "A Robust Method to Extract the Rotational Part of Deformations" (MIG 2016).
import type { Vec3 } from './math.js';
import type { SoftVentOptions } from './soft-vent.js';

/** A cue for {@link SoftBody.cue}: what happens to the body at `at` seconds of the soft world's clock. */
export type SoftCue =
  /** An impulse in N s on the whole body, shared by mass ({@link SoftBody.applyImpulse}). */
  | { readonly at: number; readonly impulse: Vec3 }
  /** A poke: an impulse falling off linearly to nothing `radius` metres from `point` ({@link SoftBody.applyImpulseAtPoint}). */
  | { readonly at: number; readonly poke: { readonly impulse: Vec3; readonly point: Vec3; readonly radius: number } }
  /** A blast: `magnitude` N s away from `center`, falling off to nothing at `radius` ({@link SoftBody.applyRadialImpulse}). */
  | {
      readonly at: number;
      readonly blast: { readonly center: Vec3; readonly magnitude: number; readonly radius: number };
    }
  /** A vent opened in its gas shell ({@link SoftBody.openVent}). */
  | { readonly at: number; readonly vent: SoftVentOptions }
  /** Every vent closed. */
  | { readonly at: number; readonly closeVents: true }
  /** A target shape set or let go ({@link SoftBody.setTargetShape}); `shape` null lets it go. */
  | {
      readonly at: number;
      readonly target: { readonly shape: ArrayLike<number> | null; readonly frequency?: number };
    };

type M3 = [number, number, number, number, number, number, number, number, number];

/** The rotation matrix (row major) of a unit quaternion [x, y, z, w]. */
function matrix([x, y, z, w]: readonly number[]): M3 {
  return [
    1 - 2 * (y! * y! + z! * z!),
    2 * (x! * y! - w! * z!),
    2 * (x! * z! + w! * y!),
    2 * (x! * y! + w! * z!),
    1 - 2 * (x! * x! + z! * z!),
    2 * (y! * z! - w! * x!),
    2 * (x! * z! - w! * y!),
    2 * (y! * z! + w! * x!),
    1 - 2 * (x! * x! + y! * y!),
  ];
}

/**
 * The rotation nearest to `a` (row major), as a quaternion refined from `guess` (Mueller et al. 2016, algorithm 1): each pass
 * turns R about omega = sum r_i x a_i / (|sum r_i . a_i| + 1e-9), the columns' misalignment, until the turn is negligible.
 */
export function extractRotation(a: M3, guess: readonly number[] = [0, 0, 0, 1], passes = 40): number[] {
  let q = [...guess];
  for (let pass = 0; pass < passes; pass++) {
    const r = matrix(q),
      col = (m: M3, c: number): Vec3 => [m[c]!, m[3 + c]!, m[6 + c]!];
    let wx = 0,
      wy = 0,
      wz = 0,
      dotSum = 0;
    for (let c = 0; c < 3; c++) {
      const ri = col(r, c),
        ai = col(a, c);
      wx += ri[1] * ai[2] - ri[2] * ai[1];
      wy += ri[2] * ai[0] - ri[0] * ai[2];
      wz += ri[0] * ai[1] - ri[1] * ai[0];
      dotSum += ri[0] * ai[0] + ri[1] * ai[1] + ri[2] * ai[2];
    }
    const s = 1 / (Math.abs(dotSum) + 1e-9);
    wx *= s;
    wy *= s;
    wz *= s;
    const angle = Math.hypot(wx, wy, wz);
    if (angle < 1e-12) break;
    const half = angle / 2,
      k = Math.sin(half) / angle,
      d = [wx * k, wy * k, wz * k, Math.cos(half)];
    // q = d q (turn by d after q).
    q = [
      d[3]! * q[0]! + d[0]! * q[3]! + d[1]! * q[2]! - d[2]! * q[1]!,
      d[3]! * q[1]! - d[0]! * q[2]! + d[1]! * q[3]! + d[2]! * q[0]!,
      d[3]! * q[2]! + d[0]! * q[1]! - d[1]! * q[0]! + d[2]! * q[3]!,
      d[3]! * q[3]! - d[0]! * q[0]! - d[1]! * q[1]! - d[2]! * q[2]!,
    ];
    const n = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
    q = q.map((v) => v / n);
  }
  return q;
}

/**
 * The accelerations (flat, three a particle) that draw particles at `positions` (flat) with `masses` toward `target` (flat,
 * offsets from its mass-weighted centre) at `omega` rad/s, and the rotation found (to start the next search from). Fixed
 * particles (mass Infinity or `free[i]` false) take no share and get none.
 */
export function targetPull(
  positions: ArrayLike<number>,
  masses: ArrayLike<number>,
  free: (i: number) => boolean,
  target: ArrayLike<number>,
  omega: number,
  guess: readonly number[],
): { accel: Float64Array; rotation: number[] } {
  const n = masses.length,
    accel = new Float64Array(3 * n);
  let total = 0;
  const centre = [0, 0, 0],
    goal = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (!free(i)) continue;
    const m = masses[i]!;
    total += m;
    for (let k = 0; k < 3; k++) {
      centre[k] += m * positions[3 * i + k]!;
      goal[k] += m * target[3 * i + k]!;
    }
  }
  if (!(total > 0)) return { accel, rotation: [...guess] };
  for (let k = 0; k < 3; k++) {
    centre[k] /= total;
    goal[k] /= total;
  }
  const a = new Array(9).fill(0) as M3;
  for (let i = 0; i < n; i++) {
    if (!free(i)) continue;
    const m = masses[i]!;
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        a[r * 3 + c] += m * (positions[3 * i + r]! - centre[r]!) * (target[3 * i + c]! - goal[c]!);
  }
  const rotation = extractRotation(a, guess),
    rm = matrix(rotation),
    w2 = omega * omega;
  for (let i = 0; i < n; i++) {
    if (!free(i)) continue;
    const q = [target[3 * i]! - goal[0]!, target[3 * i + 1]! - goal[1]!, target[3 * i + 2]! - goal[2]!];
    for (let r = 0; r < 3; r++) {
      const g = centre[r]! + rm[r * 3]! * q[0]! + rm[r * 3 + 1]! * q[1]! + rm[r * 3 + 2]! * q[2]!;
      accel[3 * i + r] = w2 * (g - positions[3 * i + r]!);
    }
  }
  return { accel, rotation };
}
