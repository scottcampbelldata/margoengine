// Re-derives every constant of the shared AgX shader (packages/shared/agx.js) from its primary source: ITU-R BT.709 and
// BT.2020 primaries with D65, and Eary Chow's AgX working-space parameters (AgX_LUT_Gen, the generator of Blender's AgX),
// whose inset must reproduce the matrix Blender publishes in its config.ocio ("AgX Log").
import test from 'node:test';
import assert from 'node:assert/strict';
import {agxShader} from '../../shared/agx.js';

const D65 = [0.3127, 0.329], BT709 = [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], BT2020 = [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]];
const mul = (a, b) => a.map(row => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
function inverse(m) {
  const [a, b, c, d, e, f, g, h, i] = m.flat(), A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A, c * h - b * i, b * f - c * e], [B, a * i - c * g, c * d - a * f], [C, b * g - a * h, a * e - b * d]].map(r => r.map(v => v / det));
}
/** RGB to XYZ of chromaticity primaries [[x, y] x3] and white [x, y] (white maps to Y = 1). */
function toXYZ(primaries) {
  const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y], p = [0, 1, 2].map(r => primaries.map(q => xyz(q)[r]));
  const s = mul(inverse(p), xyz(D65).map(v => [v])).map(([v]) => v);
  return p.map(row => row.map((v, j) => v * s[j]));
}
/** AgX working space within Rec.2020: each primary's hue rotated about white (degrees, counter-clockwise in xy), carried to the Rec.2020 gamut boundary, then pulled toward white by `scale`. */
function workspace(rotate, scale) {
  return BT2020.map(([px, py], i) => {
    const a = rotate[i] * Math.PI / 180, ux = px - D65[0], uy = py - D65[1], dx = ux * Math.cos(a) - uy * Math.sin(a), dy = ux * Math.sin(a) + uy * Math.cos(a);
    let t = Infinity;
    for (let k = 0; k < 3; k++) { // where the ray from white along (dx, dy) leaves the triangle
      const [ax, ay] = BT2020[k], [bx, by] = BT2020[(k + 1) % 3], ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex;
      const s = ((ax - D65[0]) * dy - (ay - D65[1]) * dx) / den, r = ((ax - D65[0]) * ey - (ay - D65[1]) * ex) / den;
      if (den && r > 0 && s >= 0 && s <= 1) t = Math.min(t, r);
    }
    return [D65[0] + (1 - scale[i]) * t * dx, D65[1] + (1 - scale[i]) * t * dy];
  });
}
const fromRec2020 = inverse(toXYZ(BT2020)), rec709To2020 = mul(fromRec2020, toXYZ(BT709));
const inset = mul(fromRec2020, toXYZ(workspace([2.13976149, -1.22827335, -3.05174246], [0.32965205, 0.28051336, 0.12475368])));
const outset = inverse(mul(fromRec2020, toXYZ(workspace([0, 0, 0], [0.32317438, 0.28325605, 0.0374326]))));
const blenderInset = [[0.856627153315983, 0.0951212405381588, 0.0482516061458583], [0.137318972929847, 0.761241990602591, 0.101439036467562], [0.11189821299995, 0.0767994186031903, 0.811302368396859]];
// The shader's matrices (WGSL mat3x3f is column-major), as row-major arrays.
const shaderMatrices = [...agxShader.matchAll(/mat3x3f\(([^*]+)\)\*/g)].map(([, body]) => {const v = body.replaceAll('vec3f', '').match(/-?[\d.]+/g).map(Number); return [0, 1, 2].map(r => [0, 1, 2].map(c => v[c * 3 + r]));});
const close = (a, b, tolerance, label) => a.flat().forEach((v, i) => assert.ok(Math.abs(v - b.flat()[i]) <= tolerance, `${label}: ${a} vs ${b}`));

test('AgX matrices are the Rec.709/Rec.2020 conversions and the AgX inset/outset, derived from their definitions', () => {
  close(inset, blenderInset, 2e-8, 'derived inset vs Blender config.ocio'); // the derivation reproduces Blender's published matrix
  assert.equal(shaderMatrices.length, 3);
  close(shaderMatrices[0], mul(blenderInset, rec709To2020), 5e-7, 'Rec.709 to Rec.2020, then inset');
  close(shaderMatrices[1], outset, 5e-7, 'outset');
  close(shaderMatrices[2], inverse(rec709To2020), 5e-7, 'Rec.2020 to Rec.709');
  for (const m of [inset, outset, rec709To2020]) m.forEach(row => assert.ok(Math.abs(row[0] + row[1] + row[2] - 1) < 1e-12, 'white stays white'));
  assert.match(agxShader, /\+12\.47393\)\/16\.5/); // log2(0.18) - 10 = -12.473931, 16.5 stops
  assert.ok(Math.abs(Math.log2(0.18) - 10 + 12.47393) < 1e-5);
});

test('AgX maps black to black, keeps greys neutral and rises monotonically to white', () => {
  const apply = (m, v) => m.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  const agx = v => {
    const x = apply(shaderMatrices[0], v).map(c => Math.min(Math.max((Math.log2(Math.max(c, 1e-10)) + 12.47393) / 16.5, 0), 1));
    const curve = x.map(t => ((((((15.5 * t - 40.14) * t + 31.96) * t - 6.868) * t + 0.4298) * t + 0.1191) * t - 0.00232));
    return apply(shaderMatrices[2], apply(shaderMatrices[1], curve).map(c => Math.max(c, 0) ** 2.2)).map(c => Math.min(Math.max(c, 0), 1));
  };
  assert.ok(agx([0, 0, 0]).every(c => c < 1e-6));
  let previous = 0;
  for (let stop = -12; stop <= 6; stop += 0.25) {
    const [r, g, b] = agx([0.18 * 2 ** stop, 0.18 * 2 ** stop, 0.18 * 2 ** stop]);
    assert.ok(Math.abs(r - g) < 1e-4 && Math.abs(g - b) < 1e-4, `grey at ${stop} stops: ${[r, g, b]}`);
    assert.ok(g >= previous, `monotonic at ${stop} stops`); previous = g;
  }
  assert.ok(previous > 0.95, `bright greys approach white: ${previous}`);
});
