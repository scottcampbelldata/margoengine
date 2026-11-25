// CPU oracle for the EON rough diffuse BRDF, written from the paper's equations (Portsmouth, Kutz and Hill, JCGT 14(1),
// 2025, https://arxiv.org/abs/2410.18026) with the exact Fujii albedo (Eq. 13), not the shader's polynomial (Eq. 14).
const c1 = 1 / 2 - 2 / (3 * Math.PI),
  c2 = 2 / 3 - 28 / (15 * Math.PI);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Directional albedo of the single-scatter lobe for a white surface (Eq. 12-13). */
export function eonSingle(mu, r) {
  const a = 1 / (1 + c1 * r),
    c = Math.min(Math.max(mu, 1e-7), 1),
    s = Math.sqrt(1 - c * c),
    g = s * (Math.acos(c) - s * c) + (2 / 3) * ((s / c) * (1 - s * s * s) - s);
  return a + (r * a * g) / Math.PI;
}
const average = (r) => (1 + c2 * r) / (1 + c1 * r);
const multiple = (rho, r) => (rho * rho * average(r)) / (1 - rho * (1 - average(r)));
/** BRDF value (Eq. 16) for unit directions in the frame whose normal is +z. */
export function eonBRDF(rho, r, l, v) {
  const nl = l[2],
    nv = v[2],
    s = dot(l, v) - nl * nv,
    t = s > 0 ? s / Math.max(nl, nv) : s,
    single = (rho / Math.PI) * (1 / (1 + c1 * r)) * (1 + r * t);
  if (r === 0) return single;
  return single + ((multiple(rho, r) / Math.PI) * (1 - eonSingle(nl, r)) * (1 - eonSingle(nv, r))) / (1 - average(r));
}
/** Directional albedo of the whole BRDF (Eq. 20). */
export const eonAlbedo = (rho, r, nv) => rho * eonSingle(nv, r) + multiple(rho, r) * (1 - eonSingle(nv, r));
/** Integral of `f(l) cos` over the upper hemisphere, midpoint rule. */
export function hemisphere(f, steps = 128) {
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const z = (i + 0.5) / steps,
      s = Math.sqrt(1 - z * z);
    for (let k = 0; k < steps * 2; k++) {
      const phi = ((k + 0.5) / steps) * Math.PI;
      sum += f([s * Math.cos(phi), s * Math.sin(phi), z]) * z;
    }
  }
  return (sum * Math.PI) / (steps * steps);
}
/** A unit direction at polar angle `theta` and azimuth `phi`. */
export const direction = (theta, phi = 0) => [
  Math.sin(theta) * Math.cos(phi),
  Math.sin(theta) * Math.sin(phi),
  Math.cos(theta),
];
