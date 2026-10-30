// CPU reference for the Preetham day sky, written from Preetham, Shirley & Smits 1999 (Appendix A.2: Perez
// distribution, turbidity coefficients, zenith luminance and chromaticity), the IEC 61966-2-1 XYZ to linear sRGB
// matrix and the CIE daylight locus y = -3x^2 + 2.87x - 0.275, with the same Margo tuning as src/preetham.ts (0.05
// luminance scale, 0.01 / 0.001 clamps, turbidity below 2 read as 2). Linear RGB radiance toward unit `w` with the
// sun toward unit `s`.
const perez = (theta, gamma, [a, b, c, d, e]) =>
  (1 + a * Math.exp(b / Math.max(0.01, Math.cos(theta)))) * (1 + c * Math.exp(d * gamma) + e * Math.cos(gamma) ** 2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The model's chromaticity x, y and luminance Y; `locus: false` leaves y as the fit gives it. */
export function preethamXyY(w, s, turbidity, { locus = true } = {}) {
  const t = Math.max(2, turbidity),
    theta = Math.acos(clamp(w[1], 0.01, 1)),
    gamma = Math.acos(clamp(w[0] * s[0] + w[1] * s[1] + w[2] * s[2], -1, 1)),
    z = Math.acos(clamp(s[1], 0.01, 1)),
    z2 = z * z,
    z3 = z2 * z,
    lum = [0.1787 * t - 1.463, -0.3554 * t + 0.4275, -0.0227 * t + 5.3251, 0.1206 * t - 2.5771, -0.067 * t + 0.3703],
    cx = [-0.0193 * t - 0.2592, -0.0665 * t + 0.0008, -0.0004 * t + 0.2125, -0.0641 * t - 0.8989, -0.0033 * t + 0.0452],
    cy = [-0.0167 * t - 0.2608, -0.095 * t + 0.0092, -0.0079 * t + 0.2102, -0.0441 * t - 1.6537, -0.0109 * t + 0.0529],
    yz = Math.max(0.001, (4.0453 * t - 4.971) * Math.tan((4 / 9 - t / 120) * (Math.PI - 2 * z)) - 0.2155 * t + 2.4192),
    xz =
      (0.00166 * z3 - 0.00375 * z2 + 0.00209 * z) * t * t +
      (-0.02903 * z3 + 0.06377 * z2 - 0.03202 * z + 0.00394) * t +
      0.11693 * z3 -
      0.21196 * z2 +
      0.06052 * z +
      0.25886,
    zz =
      (0.00275 * z3 - 0.0061 * z2 + 0.00317 * z) * t * t +
      (-0.04214 * z3 + 0.0897 * z2 - 0.04153 * z + 0.00516) * t +
      0.15346 * z3 -
      0.26756 * z2 +
      0.0667 * z +
      0.26688,
    Y = ((yz * perez(theta, gamma, lum)) / perez(0, z, lum)) * 0.05,
    x = (xz * perez(theta, gamma, cx)) / perez(0, z, cx),
    fitted = (zz * perez(theta, gamma, cy)) / perez(0, z, cy),
    y = locus ? Math.max(-3 * x * x + 2.87 * x - 0.275, fitted) : fitted;
  return { x, y, Y };
}

/** Linear sRGB radiance of the day sky (before exposure and the display transform), as the shader computes it. */
export function preethamRGB(w, s, t, options) {
  const { x, y, Y } = preethamXyY(w, s, t, options),
    X = (x * Y) / Math.max(y, 0.001),
    Z = ((1 - x - y) * Y) / Math.max(y, 0.001),
    t0 = s[1] + 0.2,
    f = clamp(t0 / 0.25, 0, 1),
    fade = f * f * (3 - 2 * f);
  return [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.204 * Y + 1.057 * Z,
  ].map((v) => Math.max(0, v) * fade);
}
