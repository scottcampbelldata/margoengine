import { hypot } from '@margoengine/math/pinned';
import type { Vec3 } from '../seakeeping/wetted.js';
import { atan2 } from '../space/angles.js';

export interface CapsuleDimensions {
  readonly radius: number;
  /** Half the distance between the hemispheres' centres, along local Y. */
  readonly halfHeight: number;
}

export function capsuleVolume(radius: number, halfHeight: number): number {
  return Math.PI * radius * radius * (2 * halfHeight + (4 * radius) / 3);
}

/** A homogeneous capsule's ellipsoid of equal second moments, for the inertia model. */
export function capsuleInertiaAxes(radius: number, halfHeight: number): [number, number, number] {
  if (halfHeight === 0) return [radius, radius, radius];
  const cylinderShare = halfHeight / (halfHeight + (2 * radius) / 3);
  const endsShare = 1 - cylinderShare;
  const across = radius * Math.sqrt((5 / 4) * cylinderShare + endsShare);
  // Each hemisphere's centroid is 3r/8 past the cylinder end, and E[z²] about that end is r²/5.
  const along = Math.sqrt(
    5 *
      (cylinderShare * ((halfHeight * halfHeight) / 3) +
        endsShare * (halfHeight * halfHeight + (3 * halfHeight * radius) / 4 + (radius * radius) / 5)),
  );
  return [across, along, across];
}

// NIST DLMF §3.5(v), the positive nodes and weights on [-1, 1].
export const GAUSS_16: readonly (readonly [number, number])[] = [
  [0.09501250983763744, 0.1894506104550685],
  [0.2816035507792589, 0.1826034150449236],
  [0.4580167776572274, 0.1691565193950025],
  [0.6178762444026438, 0.1495959888165767],
  [0.755404408355003, 0.1246289712555339],
  [0.8656312023878318, 0.0951585116824928],
  [0.9445750230732326, 0.06225352393864789],
  [0.9894009349916499, 0.02715245941175409],
];

/** The area of the unit disk below the chord at `cutoff`, for -1 < cutoff < 1. */
function diskBelow(cutoff: number, chord: number): number {
  const angle = atan2(chord, -cutoff);
  const square = angle * angle;
  // Evaluate angle - sin(angle) cos(angle) without losing a vanishing segment to cancellation.
  return angle < 0.01
    ? (2 / 3) * angle * square * (1 + square * (-1 / 5 + (2 / 105) * square))
    : angle + cutoff * chord;
}

type Moments = [measure: number, axial: number, radial: number];

function integrate(sample: (u: number, weight: number, result: Moments) => void, lo: number, hi: number): Moments {
  const mid = (lo + hi) / 2;
  const half = (hi - lo) / 2;
  const integral: Moments = [0, 0, 0];
  for (const [node, weight] of GAUSS_16) {
    sample(mid - half * node, half * weight, integral);
    sample(mid + half * node, half * weight, integral);
  }
  return integral;
}

function integratePartial(
  sample: (u: number, weight: number, result: Moments) => void,
  lo: number,
  hi: number,
  coarse: Moments,
  tolerance: number,
  length: number,
  radius: number,
  remaining: number,
): Moments {
  const mid = (lo + hi) / 2;
  const left = integrate(sample, lo, mid);
  const right = integrate(sample, mid, hi);
  const fine: Moments = [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
  if (
    remaining === 0 ||
    (Math.abs(fine[0] - coarse[0]) <= tolerance &&
      Math.abs(fine[1] - coarse[1]) <= tolerance * length &&
      Math.abs(fine[2] - coarse[2]) <= tolerance * radius)
  )
    return fine;
  const first = integratePartial(sample, lo, mid, left, tolerance / 2, length, radius, remaining - 1);
  const second = integratePartial(sample, mid, hi, right, tolerance / 2, length, radius, remaining - 1);
  return [first[0] + second[0], first[1] + second[1], first[2] + second[2]];
}

/** Integrate the disk sections of a solid capsule or the line sections of its stadium projection. */
function clippedSections(
  radius: number,
  halfHeight: number,
  rise: number,
  across: number,
  depth: number,
  fullMeasure: number,
  planar: boolean,
): Moments {
  const extent = radius + halfHeight * rise;
  if (depth <= -extent) return [0, 0, 0];
  if (depth >= extent) return [fullMeasure, 0, 0];

  const result: Moments = [0, 0, 0];
  const section = (centre: number, scale: number, lo: number, hi: number, rounded: boolean) => {
    if (scale === 0) return;
    // The axial location is centre + scale*t. Split at tangencies of the plane to each disk.
    const centreDepth = depth - rise * centre;
    const events = [lo, hi];
    const split = (t: number) => {
      if (t > lo && t < hi) events.push(t);
    };
    if (rounded) {
      const normalizedDepth = centreDepth / radius;
      if (Math.abs(normalizedDepth) < 1) {
        const mean = rise * normalizedDepth;
        const span = across * Math.sqrt((1 - normalizedDepth) * (1 + normalizedDepth));
        split(mean - span);
        split(mean + span);
      }
    } else if (rise > 0) {
      split((centreDepth - across * radius) / rise / scale);
      split((centreDepth + across * radius) / rise / scale);
    }
    events.sort((a, b) => a - b);
    for (let i = 1; i < events.length; i++) {
      const start = events[i - 1]!;
      const end = events[i]!;
      const width = end - start;
      if (width === 0) continue;
      const middle = (start + end) / 2;
      const ring = rounded ? Math.sqrt((1 - middle) * (1 + middle)) : 1;
      const height = centreDepth - rise * scale * middle;
      const support = across * radius * ring;
      if (height <= -support) continue;
      if (height >= support && (!planar || !rounded)) {
        // Exact polynomial integral of full disks or of the stadium's middle rectangle.
        const factor = (planar ? 2 * radius : Math.PI * radius * radius) * scale * width;
        const variance = (width * width) / 12;
        const volume = rounded ? factor * ((1 - middle) * (1 + middle) - variance) : factor;
        result[0] += volume;
        result[1] += (centre + scale * middle) * volume - (rounded ? 2 * middle * variance * scale * factor : 0);
        continue;
      }
      const partial = (u: number, weight: number, moments: Moments) => {
        // A cubic reparameterization has zero derivative at both tangent endpoints.
        const t = start + width * u * u * (3 - 2 * u);
        const diskRadius = rounded ? radius * Math.sqrt(Math.max(0, (1 - t) * (1 + t))) : radius;
        const plane = centreDepth - rise * scale * t;
        const sectionWeight = 6 * weight * scale * width * u * (1 - u) * diskRadius;
        const diskSupport = across * diskRadius;
        if (plane <= -diskSupport) return;
        const axial = centre + scale * t;
        if (plane >= diskSupport) {
          const measure = sectionWeight * (planar ? 2 : Math.PI * diskRadius);
          moments[0] += measure;
          moments[1] += measure * axial;
          return;
        }
        const cutoff = plane / diskSupport;
        const chordSquared = (1 - cutoff) * (1 + cutoff);
        if (planar) {
          const area = sectionWeight * (1 + cutoff);
          moments[0] += area;
          moments[1] += area * axial;
          moments[2] -= (sectionWeight * diskRadius * chordSquared) / 2;
        } else {
          const chord = Math.sqrt(chordSquared);
          const diskWeight = sectionWeight * diskRadius;
          const volume = diskWeight * diskBelow(cutoff, chord);
          moments[0] += volume;
          moments[1] += volume * axial;
          moments[2] -= (2 / 3) * diskWeight * diskRadius * chordSquared * chord;
        }
      };
      const coarse = integrate(partial, 0, 1);
      const tolerance = Math.max(coarse[0] * 2e-12, fullMeasure * 1e-14);
      const integral = integratePartial(partial, 0, 1, coarse, tolerance, halfHeight + radius, radius, 8);
      result[0] += integral[0];
      result[1] += integral[1];
      result[2] += integral[2];
    }
  };
  section(-halfHeight, radius, -1, 0, true);
  section(0, halfHeight, -1, 1, false);
  section(halfHeight, radius, 0, 1, true);
  return result;
}

/** Analytic disk sections of a capsule and the centroid offset of its submerged volume. */
export function capsuleHydrostatics(
  { radius, halfHeight }: CapsuleDimensions,
  axis: Vec3,
  depth: number,
  fullVolume: number,
  offset: [number, number, number],
): number {
  offset[0] = offset[1] = offset[2] = 0;
  // Choose the equivalent axis pointing upwards to give the same sections when endpoints swap.
  const sign = axis[1] < 0 ? -1 : 1;
  const rise = Math.min(1, Math.abs(axis[1]));
  const across = hypot(axis[0], axis[2]);
  const [volume, axialMoment, radialMoment] = clippedSections(
    radius,
    halfHeight,
    rise,
    across,
    depth,
    fullVolume,
    false,
  );
  if (volume > 0) {
    const axial = axialMoment / volume;
    const radial = radialMoment / volume;
    const radialAlongUp = radial * rise;
    offset[0] = axial * sign * axis[0] - (across > 0 ? radialAlongUp * ((sign * axis[0]) / across) : 0);
    offset[1] = axial * rise + radial * across;
    offset[2] = axial * sign * axis[2] - (across > 0 ? radialAlongUp * ((sign * axis[2]) / across) : 0);
  }
  return Math.min(fullVolume, volume);
}

/** Area and first moments above a waterline in the vertical projection of a capsule. */
export function capsuleSilhouette(
  radius: number,
  axisX: number,
  axisY: number,
  level: number,
): { fullArea: number; emerged: Moments } {
  const halfHeight = hypot(axisX, axisY);
  const fullArea = Math.PI * radius * radius + 4 * radius * halfHeight;
  const sign = axisY < 0 ? -1 : 1;
  const rise = halfHeight > 0 ? (sign * axisY) / halfHeight : 1;
  const along = halfHeight > 0 ? (sign * axisX) / halfHeight : 0;
  const across = Math.abs(along);
  // Central symmetry supplies an emerged cap directly, keeping tiny slivers accurate.
  const [area, axial, radial] = clippedSections(radius, halfHeight, rise, across, -level, fullArea, true);
  return {
    fullArea,
    emerged: [
      Math.min(fullArea, area),
      -along * axial + Math.sign(along) * rise * radial,
      -rise * axial - across * radial,
    ],
  };
}
