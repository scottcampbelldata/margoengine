// The body's limb volumes on a fitted rig, shared by the pose checker (`validate.ts`) and the IK swivel (`ik.ts`):
// each segment a capsule of the measured mean girth from the species table (ANSUR II, Gordon et al. 2014,
// NATICK/TR-15/007), radius = circumference / 2 pi, between two of the rig's bones; the closest points of two segments
// as in Ericson, "Real-Time Collision Detection", Morgan Kaufmann 2005, section 5.1.9. Written clean room.
import type { AnatomicalRig } from './anatomy.js';

type V3 = [number, number, number];

/** A capsule on the rig: the bones at its two ends and its radius at each, in rig units. */
export interface BodyVolume {
  readonly near: number;
  readonly far: number;
  readonly r0: number;
  readonly r1: number;
}

/** The capsules of a fitted body by id, and the pairs of them that must stay apart. */
export interface BodyVolumes {
  readonly volumes: Map<string, BodyVolume>;
  readonly pairs: readonly (readonly [string, string])[];
}

const CACHE = new WeakMap<AnatomicalRig, BodyVolumes>();

/** The body's volumes and the pairs that stay apart; pairs that share an end bone meet at a joint and are left out. */
export function bodyVolumes(body: AnatomicalRig): BodyVolumes {
  let found = CACHE.get(body);
  if (found) return found;
  const species = body.species,
    stature = body.stature > 0 ? body.stature : 1,
    boneOf = (id: string): number | undefined => {
      const k = body.index.get(id);
      return k === undefined ? undefined : body.joints[k].bone;
    },
    volumes = new Map<string, BodyVolume>();
  for (const volume of species.volumes ?? []) {
    const near = boneOf(volume.from),
      far = volume.to.map(boneOf).find((bone) => bone !== undefined && bone !== near);
    if (near === undefined || far === undefined) continue;
    volumes.set(volume.id, { near, far, r0: volume.radius[0] * stature, r1: volume.radius[1] * stature });
  }
  const pairs = (species.apart ?? []).filter(([a, b]) => {
    const va = volumes.get(a),
      vb = volumes.get(b);
    return va && vb && va.near !== vb.near && va.near !== vb.far && va.far !== vb.near && va.far !== vb.far;
  }) as [string, string][];
  found = { volumes, pairs };
  CACHE.set(body, found);
  return found;
}

const sub = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Closest points of segments p0-p1 and q0-q1: [s, t, squared distance] (Ericson 2005, 5.1.9). */
export function closestSegments(
  p0: ArrayLike<number>,
  p1: ArrayLike<number>,
  q0: ArrayLike<number>,
  q1: ArrayLike<number>,
): [number, number, number] {
  const d1 = sub(p1, p0),
    d2 = sub(q1, q0),
    r = sub(p0, q0),
    a = dot(d1, d1),
    e = dot(d2, d2),
    f = dot(d2, r),
    clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  let s: number, t: number;
  if (a <= 1e-12 && e <= 1e-12) (s = 0), (t = 0);
  else if (a <= 1e-12) (s = 0), (t = clamp(f / e));
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) (t = 0), (s = clamp(-c / a));
    else {
      const b = dot(d1, d2),
        denom = a * e - b * b;
      s = denom > 1e-12 ? clamp((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) (t = 0), (s = clamp(-c / a));
      else if (t > 1) (t = 1), (s = clamp((b - c) / a));
    }
  }
  const x = p0[0] + d1[0] * s - (q0[0] + d2[0] * t),
    y = p0[1] + d1[1] * s - (q0[1] + d2[1] * t),
    z = p0[2] + d1[2] * s - (q0[2] + d2[2] * t);
  return [s, t, x * x + y * y + z * z];
}

/** How far two capsules reach into each other past `shrink` of their radii, in rig units; 0 when apart. */
export function overlapDepth(
  a0: ArrayLike<number>,
  a1: ArrayLike<number>,
  va: BodyVolume,
  b0: ArrayLike<number>,
  b1: ArrayLike<number>,
  vb: BodyVolume,
  shrink: number,
): number {
  const [s, t, d2] = closestSegments(a0, a1, b0, b1),
    reach = shrink * (va.r0 + (va.r1 - va.r0) * s + vb.r0 + (vb.r1 - vb.r0) * t),
    distance = Math.sqrt(d2);
  return distance < reach ? reach - distance : 0;
}
