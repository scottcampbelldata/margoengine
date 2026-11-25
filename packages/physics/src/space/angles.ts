import { hypot } from '@margoengine/math/pinned';
import type { Vec3 } from '@margoengine/core';
import { cross, dot } from '@margoengine/math/vec3';

// Reduce the positive ratio to [0, tan(π/8)] by the tangent half-angle identity, then sum the alternating
// arctangent series. The first omitted term bounds the mathematical truncation error below 1.0e-17 rad.
export function atan2(y: number, x: number): number {
  const ay = Math.abs(y);
  const ax = Math.abs(x);
  if (ax === 0 && ay === 0) return 0;
  const steep = ay > ax;
  const ratio = steep ? ax / ay : ay / ax;
  const h = ratio / (1 + Math.sqrt(1 + ratio * ratio));
  const h2 = h * h;
  let p = 0;
  for (let n = 19; n >= 0; n--) p = (n % 2 === 0 ? 1 : -1) / (2 * n + 1) + h2 * p;
  const a = 2 * h * p;
  const firstQuadrant = steep ? Math.PI / 2 - a : a;
  const angle = x < 0 ? Math.PI - firstQuadrant : firstQuadrant;
  return y < 0 ? -angle : angle;
}

export function angularRadius(radius: number, distance: number): number {
  const ratio = radius / distance;
  return atan2(ratio, Math.sqrt((1 - ratio) * (1 + ratio)));
}

export function magnitude([x, y, z]: Vec3): number {
  return hypot(x, y, z);
}

export function separation(a: Vec3, b: Vec3): number {
  return atan2(magnitude(cross(a, b)), dot(a, b));
}
