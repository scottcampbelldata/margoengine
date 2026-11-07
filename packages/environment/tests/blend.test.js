// CPU checks for @margoengine/environment/blend: the exact SH rotation and argument validation. The GPU blend itself is
// checked on a real device by tests/blend-browser.js (npm run test:blend:browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSH } from '../dist/index.js';
import { EnvironmentBlend, rotateSH } from '../dist/blend.js';

const rotateY = (d, angle) => {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return [c * d[0] - s * d[2], d[1], s * d[0] + c * d[2]];
};
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

test('rotateSH is the exact rotation of a band-limited function about +Y', () => {
  const sh = Float32Array.from({ length: 27 }, random);
  for (const angle of [0, 0.3, Math.PI / 2, 2.5, -1.1]) {
    const rotated = rotateSH(sh, angle);
    for (let i = 0; i < 50; i++) {
      const d = [random(), random(), random()],
        l = Math.hypot(...d);
      const unit = d.map((v) => v / l);
      const got = evaluateSH(rotated, unit),
        want = evaluateSH(sh, rotateY(unit, angle));
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(got[c] - want[c]) < 1e-5, `${angle}: ${got[c]} vs ${want[c]}`);
    }
  }
});

test('rotateSH scales and accumulates', () => {
  const a = Float32Array.from({ length: 27 }, random),
    b = Float32Array.from({ length: 27 }, random);
  const sum = rotateSH(a, 0.4, 0.25);
  rotateSH(b, -0.7, 0.75, sum, true);
  const ra = rotateSH(a, 0.4),
    rb = rotateSH(b, -0.7);
  for (let k = 0; k < 27; k++) assert.ok(Math.abs(sum[k] - (0.25 * ra[k] + 0.75 * rb[k])) < 1e-6);
  const zero = rotateSH(a, 0);
  for (let k = 0; k < 27; k++) assert.ok(Math.abs(zero[k] - a[k]) < 1e-6, 'angle 0 keeps the coefficients');
});

test('EnvironmentBlend.create validates t and its sources before touching the GPU', async () => {
  const device = { createTexture() {} };
  const live = { device, disposed: false, onChange: () => () => {} };
  await assert.rejects(EnvironmentBlend.create(device, live, live, { t: -0.1 }), RangeError);
  await assert.rejects(EnvironmentBlend.create(device, live, live, { t: Number.NaN }), RangeError);
  await assert.rejects(EnvironmentBlend.create(device, live, {}), TypeError);
  await assert.rejects(EnvironmentBlend.create(device, live, { ...live, disposed: true }), { code: 'disposed' });
  await assert.rejects(EnvironmentBlend.create(device, live, { ...live, device: {} }), { code: 'state' });
  await assert.rejects(EnvironmentBlend.create(device, live, { ...live, device: null }), /being restored/);
});
