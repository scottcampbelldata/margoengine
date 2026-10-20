// The physical sky of @margoengine/voxel-pathtracer: Preetham, Shirley and Smits' analytic daylight model ("A
// Practical Analytic Model for Daylight", SIGGRAPH 1999) baked into an equirectangular environment map, which the
// tracer then importance samples like any other map. Perez's sky distribution F(theta, gamma) =
// (1 + A e^(B / cos theta)) (1 + C e^(D gamma) + E cos^2 gamma) with the paper's coefficients linear in turbidity for
// luminance Y and chromaticity x, y; zenith luminance (kcd/m^2) and chromaticity from its fits in turbidity and sun
// zenith angle; xyY converted to linear sRGB (IEC 61966-2-1). Pure CPU code.

/** Baked map size: about 0.35 degrees per texel. */
export const SKY_WIDTH = 1024,
  SKY_HEIGHT = 512;

type Perez = readonly [number, number, number, number, number];
const coefficients = (t: number): [Perez, Perez, Perez] => [
  [0.1787 * t - 1.463, -0.3554 * t + 0.4275, -0.0227 * t + 5.3251, 0.1206 * t - 2.5771, -0.067 * t + 0.3703],
  [-0.0193 * t - 0.2592, -0.0665 * t + 0.0008, -0.0004 * t + 0.2125, -0.0641 * t - 0.8989, -0.0033 * t + 0.0452],
  [-0.0167 * t - 0.2608, -0.095 * t + 0.0092, -0.0079 * t + 0.2102, -0.0441 * t - 1.6537, -0.0109 * t + 0.0529],
];
const perez = ([a, b, c, d, e]: Perez, theta: number, gamma: number) =>
  (1 + a * Math.exp(b / Math.max(Math.cos(theta), 1e-4))) * (1 + c * Math.exp(d * gamma) + e * Math.cos(gamma) ** 2);
// Zenith chromaticity: [T^2, T, 1] M [theta_s^3, theta_s^2, theta_s, 1].
const zenith = (t: number, s: number, m: readonly number[]) => {
  const v = [s * s * s, s * s, s, 1],
    row = (r: number) => m[r * 4] * v[0] + m[r * 4 + 1] * v[1] + m[r * 4 + 2] * v[2] + m[r * 4 + 3] * v[3];
  return t * t * row(0) + t * row(1) + row(2);
};
const XZ = [0.00166, -0.00375, 0.00209, 0, -0.02903, 0.06377, -0.03202, 0.00394, 0.11693, -0.21196, 0.06052, 0.25886],
  YZ = [0.00275, -0.0061, 0.00317, 0, -0.04214, 0.0897, -0.04153, 0.00516, 0.15346, -0.26756, 0.0667, 0.26688];

/**
 * Linear sRGB sky radiance (3 floats per texel, rows from straight up, the centre column facing -Z, three quarters
 * +X: the environment map convention) for turbidity `turbidity`, sun direction `sun` (unit; below the horizon it is
 * taken on the horizon) and radiance scale `intensity` per kcd/m^2. Below the horizon the sky is black, or with
 * `horizonBelow` the horizon row repeated.
 */
export function bakeSky(
  turbidity: number,
  sun: readonly number[],
  intensity: number,
  horizonBelow = false,
): Float32Array {
  const t = turbidity,
    s = Math.acos(Math.min(1, Math.max(0, sun[1]))),
    h = Math.hypot(sun[0], sun[2]),
    // The sun direction used for gamma, lifted to the horizon when below it.
    sd = sun[1] >= 0 ? sun : h > 0 ? [sun[0] / h, 0, sun[2] / h] : [0, 1, 0],
    [cy, cx, cyy] = coefficients(t),
    chi = (4 / 9 - t / 120) * (Math.PI - 2 * s),
    yz = (4.0453 * t - 4.971) * Math.tan(chi) - 0.2155 * t + 2.4192,
    xz = zenith(t, s, XZ),
    yzc = zenith(t, s, YZ),
    fy = perez(cy, 0, s),
    fx = perez(cx, 0, s),
    fyy = perez(cyy, 0, s),
    out = new Float32Array(SKY_WIDTH * SKY_HEIGHT * 3);
  for (let j = 0; j < SKY_HEIGHT; j++) {
    const theta = (Math.PI * (j + 0.5)) / SKY_HEIGHT;
    if (theta >= Math.PI / 2) break;
    const st = Math.sin(theta),
      ct = Math.cos(theta);
    for (let i = 0; i < SKY_WIDTH; i++) {
      const phi = ((i + 0.5) / SKY_WIDTH - 0.5) * 2 * Math.PI,
        d = [st * Math.sin(phi), ct, -st * Math.cos(phi)],
        gamma = Math.acos(Math.min(1, Math.max(-1, d[0] * sd[0] + d[1] * sd[1] + d[2] * sd[2]))),
        Y = (yz * perez(cy, theta, gamma)) / fy,
        x = (xz * perez(cx, theta, gamma)) / fx,
        y = (yzc * perez(cyy, theta, gamma)) / fyy;
      if (!(Y > 0 && y > 0)) continue;
      const X = (x * Y) / y,
        Z = ((1 - x - y) * Y) / y,
        k = (j * SKY_WIDTH + i) * 3;
      out[k] = Math.max(0, 3.2406 * X - 1.5372 * Y - 0.4986 * Z) * intensity;
      out[k + 1] = Math.max(0, -0.9689 * X + 1.8758 * Y + 0.0415 * Z) * intensity;
      out[k + 2] = Math.max(0, 0.0557 * X - 0.204 * Y + 1.057 * Z) * intensity;
    }
  }
  if (horizonBelow) {
    const row = SKY_WIDTH * 3,
      last = (SKY_HEIGHT / 2 - 1) * row;
    for (let j = SKY_HEIGHT / 2; j < SKY_HEIGHT; j++) out.copyWithin(j * row, last, last + row);
  }
  return out;
}
