import { hypot } from '@margoengine/math/pinned';

type Vec3 = readonly [number, number, number];

function normalComponent(vector: Vec3, direction: Vec3): [number, number, number] {
  const along = vector[0] * direction[0] + vector[1] * direction[1] + vector[2] * direction[2];
  return [vector[0] - along * direction[0], vector[1] - along * direction[1], vector[2] - along * direction[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Recover the mean current and peak normal speed of an elliptical harmonic water orbit. */
export function memberOrbit(
  now: Vec3,
  quarter: Vec3,
  half: Vec3,
  bodyVelocity: Vec3,
  axis: Vec3,
): { peak: number; mean: number } {
  const cx = (now[0] + half[0]) / 2;
  const cy = (now[1] + half[1]) / 2;
  const cz = (now[2] + half[2]) / 2;
  const mean = normalComponent([cx - bodyVelocity[0], cy - bodyVelocity[1], cz - bodyVelocity[2]], axis);
  const cos = normalComponent([now[0] - cx, now[1] - cy, now[2] - cz], axis);
  const sin = normalComponent([quarter[0] - cx, quarter[1] - cy, quarter[2] - cz], axis);
  // Maximizing |cos*cos(theta) + sin*sin(theta)| takes the largest eigenvalue of the 2×2 Gram matrix.
  const cc = dot(cos, cos);
  const ss = dot(sin, sin);
  const cs = dot(cos, sin);
  return { peak: Math.sqrt((cc + ss + hypot(cc - ss, 2 * cs)) / 2), mean: hypot(mean[0], mean[1], mean[2]) };
}
