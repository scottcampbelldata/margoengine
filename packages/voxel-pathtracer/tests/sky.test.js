import test from 'node:test';
import assert from 'node:assert/strict';
import { bakeSky, SKY_HEIGHT, SKY_WIDTH } from '../src/sky.ts';

// Preetham, Shirley & Smits 1999 (Appendix A.2) typed again for one direction, with the CIE daylight locus
// y >= -3x^2 + 2.87x - 0.275 and turbidity below 2 read as 2 (the two corrections @margoengine/sky makes too).
// Linear sRGB per kcd/m^2 toward polar angle `theta` with the sun overhead (gamma = theta, sun zenith angle 0).
function reference(turbidity, theta) {
  const t = Math.max(2, turbidity),
    perez = ([a, b, c, d, e]) =>
      ((1 + a * Math.exp(b / Math.cos(theta))) * (1 + c * Math.exp(d * theta) + e * Math.cos(theta) ** 2)) /
      ((1 + a * Math.exp(b)) * (1 + c + e)),
    Y = (4.0453 * t - 4.971) * Math.tan((4 / 9 - t / 120) * Math.PI) - 0.2155 * t + 2.4192,
    lum =
      Y *
      perez([0.1787 * t - 1.463, -0.3554 * t + 0.4275, -0.0227 * t + 5.3251, 0.1206 * t - 2.5771, -0.067 * t + 0.3703]),
    x =
      (0.00394 * t + 0.25886) *
      perez([
        -0.0193 * t - 0.2592,
        -0.0665 * t + 0.0008,
        -0.0004 * t + 0.2125,
        -0.0641 * t - 0.8989,
        -0.0033 * t + 0.0452,
      ]),
    fit =
      (0.00516 * t + 0.26688) *
      perez([
        -0.0167 * t - 0.2608,
        -0.095 * t + 0.0092,
        -0.0079 * t + 0.2102,
        -0.0441 * t - 1.6537,
        -0.0109 * t + 0.0529,
      ]),
    y = Math.max(-3 * x * x + 2.87 * x - 0.275, fit),
    X = (x * lum) / y,
    Z = ((1 - x - y) * lum) / y;
  return {
    fit,
    x,
    rgb: [
      3.2406 * X - 1.5372 * lum - 0.4986 * Z,
      -0.9689 * X + 1.8758 * lum + 0.0415 * Z,
      0.0557 * X - 0.204 * lum + 1.057 * Z,
    ],
  };
}
// The texel just above the horizon in the centre column, and its polar angle.
const row = SKY_HEIGHT / 2 - 1,
  theta = (Math.PI * (row + 0.5)) / SKY_HEIGHT,
  texel = (map, j = row) => [
    ...map.slice((j * SKY_WIDTH + SKY_WIDTH / 2) * 3, (j * SKY_WIDTH + SKY_WIDTH / 2) * 3 + 3),
  ];

test('the physical sky horizon at noon is not pink and matches the daylight model', () => {
  const ref = reference(2, theta);
  // The cause: the published fit alone puts the horizon 0.013 below the daylight locus (red above green).
  assert.ok(-3 * ref.x * ref.x + 2.87 * ref.x - 0.275 - ref.fit > 0.01, `fit y ${ref.fit} at x ${ref.x}`);
  for (const t of [2, 3]) {
    const rgb = texel(bakeSky(t, [0, 1, 0], 1)),
      expected = reference(t, theta).rgb;
    assert.ok(rgb[0] <= rgb[1] && rgb[1] <= rgb[2], `turbidity ${t}: horizon ${rgb} is tinted pink`);
    for (let k = 0; k < 3; k++)
      assert.ok(Math.abs(rgb[k] / expected[k] - 1) < 0.01, `turbidity ${t}: horizon ${rgb} against ${expected}`);
  }
});

test('the physical sky reads turbidity below 2 as 2 instead of drawing black or blowing out', () => {
  // The luminance normaliser 1 + A e^B is negative below about 1.65.
  const normaliser = (t) => 1 + (0.1787 * t - 1.463) * Math.exp(-0.3554 * t + 0.4275);
  assert.ok(normaliser(1) < 0 && normaliser(1.6) < 0 && normaliser(2) > 0.1);
  const two = bakeSky(2, [0, 1, 0], 1);
  for (const t of [1, 1.7]) {
    const map = bakeSky(t, [0, 1, 0], 1);
    assert.ok(texel(map, 0)[2] > 1, `turbidity ${t}: zenith ${texel(map, 0)} is black`);
    assert.deepEqual(texel(map), texel(two), `turbidity ${t}: horizon`);
  }
});
