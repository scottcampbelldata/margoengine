// Reference irradiance of a uniform sphere of light on a plane, for tests/clustered-sphere-light-gpu-check.js and
// test/sphere-lights.test.js (PointLight.radius diffuse, KB-FIRE-WALLHOT1). Written from the papers, not from code:
// - Snyder 1996, "Area Light Sources for Real-Time Graphics" (Microsoft Research MSR-TR-96-11), the constant
//   subhemispherical source: a cap of angular radius sigma (sin sigma = r / d) whose axis makes the angle theta with the
//   normal. Fully above the horizon (cos^2 theta >= sin^2 sigma) its cosine-weighted solid angle is pi sin^2 sigma
//   cos theta, which for a sphere of radiance L = I / (pi r^2) is I cos theta / d^2, a point light at the centre.
//   Crossing the horizon it is (cos theta acos(y) - x sin theta sqrt(1 - y^2)) sin^2 sigma + atan(sin theta
//   sqrt(1 - y^2) / x), x = cot sigma, y = -x cot theta: the same closed form as Lagarde and de Rousiers 2014, "Moving
//   Frostbite to Physically Based Rendering 3.0", section 4.7 (area lights) (sphere lights, horizon handling), and as the
//   configuration factor from a tilted differential planar element to a sphere (Howell, "A Catalog of Radiation Heat
//   Transfer Configuration Factors", factor B-43).
// - Inside the sphere (d < r) the cap is taken as the hemisphere it is at the sphere's surface (sin sigma = 1), so the
//   irradiance is continuous at d = r and at most pi L = I / r^2: a surface inside the source is lit as one touching it.
/** Cosine-weighted solid angle (sr) of a light cap of angular radius sigma (`s2` = sin^2 sigma) whose axis makes `c` = cos theta with the normal. */
export function capFormFactor(c, s2) {
  if (c * c >= s2) return Math.PI * s2 * Math.max(c, 0);
  const st = Math.sqrt(Math.max(1 - c * c, 0)),
    x = Math.sqrt(Math.max(1 / s2 - 1, 0)),
    y = Math.min(Math.max((-x * c) / Math.max(st, 1e-6), -1), 1),
    q = st * Math.sqrt(1 - y * y);
  return Math.max((c * Math.acos(y) - x * q) * s2 + Math.atan2(q, x), 0);
}
/**
 * Irradiance per unit intensity (E / I, 1 / m^2) at distance `d` from the centre of a sphere of radius `r` whose
 * direction makes `c` = cos theta with the normal; `r` 0 is the point light, max(c, 0) / d^2.
 */
export function sphereIrradiance(c, d, r) {
  if (r <= 0) return Math.max(c, 0) / (d * d);
  return capFormFactor(c, Math.min((r * r) / (d * d), 1)) / (Math.PI * r * r);
}
/** The bound: no point of a plane receives more than pi L = I / (pi r^2) * pi from a sphere of radius `r`. */
export const sphereBound = (r) => 1 / (r * r);
/**
 * Monte Carlo of the same cosine-weighted solid angle, by stratified directions over the hemisphere around the normal
 * (0, 0, 1), counting those inside the cap around (sin theta, 0, cos theta) of half angle sigma. Independent of the
 * closed form, for the CPU test.
 */
export function capFormFactorSampled(c, s2, n = 512) {
  const sx = Math.sqrt(Math.max(1 - c * c, 0)),
    cosSigma = Math.sqrt(Math.max(1 - s2, 0));
  let sum = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      // Cosine-weighted hemisphere (Malley): uniform disc point, lifted.
      const u = (i + 0.5) / n,
        v = (j + 0.5) / n,
        radius = Math.sqrt(u),
        phi = 2 * Math.PI * v,
        x = radius * Math.cos(phi),
        z = Math.sqrt(Math.max(1 - u, 0));
      if (x * sx + z * c >= cosSigma) sum++;
    }
  return (Math.PI * sum) / (n * n);
}
