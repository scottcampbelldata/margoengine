import assert from 'node:assert/strict';
import test from 'node:test';
import { reliefGeometry, reliefImage } from '../dist/contour2d.js';

// A plane rising east: z = x on [0, 10] x [0, 10], 11 x 11 samples.
const axis = Array.from({ length: 11 }, (_, i) => i);
const ramp = { x: axis, y: axis, values: axis.flatMap(() => axis) };

test('reliefImage draws contours exactly where the plane crosses each level, index contours wider', () => {
  const image = reliefImage(ramp, { width: 200, height: 20, interval: 1, index: 5, lineWidth: 2, lineOpacity: 1, shade: 0, lineColor: '#000000', stops: [{ at: 0, color: '#ffffff' }, { at: 10, color: '#ffffff' }] });
  assert.equal(image.data.length, 200 * 20 * 4);
  const row = Array.from({ length: 200 }, (_, x) => image.data[(10 * 200 + x) * 4]);
  // Pixel centres are at (x + 0.5) / 20 data units; level 3 lies between pixels 59 and 60, both dark.
  assert.ok(row[59] < 60 && row[60] < 60, `${row[59]} ${row[60]}`);
  assert.equal(row[50 - 20], 255, 'mid-band is the plain tint');
  // Level 5 is an index contour: 2.2 times wider, so pixels two away from it are covered too.
  const dark = (from, to) => row.slice(from, to).filter((v) => v < 128).length;
  assert.ok(dark(95, 105) > dark(55, 65), `${dark(95, 105)} ${dark(55, 65)}`);
  // No lines without an interval; every pixel opaque.
  const plain = reliefImage(ramp, { width: 64, shade: 0, stops: [{ at: 0, color: '#808080' }, { at: 10, color: '#808080' }] });
  assert.ok(plain.data.every((v, i) => (i % 4 === 3 ? v === 255 : Math.abs(v - 128) <= 1)));
});

test('reliefImage hillshade: a slope facing the north-west light is brighter than one facing away, flat keeps its tint', () => {
  const hill = (f) => ({ x: axis, y: axis, values: axis.flatMap((y) => axis.map((x) => f(x, y))) });
  const grey = [{ at: -100, color: '#808080' }, { at: 100, color: '#808080' }];
  const mean = (img) => img.data.reduce((s, v, i) => (i % 4 ? s : s + v), 0) / (img.width * img.height);
  // y grows north; the light comes from the north-west (azimuth 315). z = x - y rises to the south-east, so it faces north-west.
  const facingNW = mean(reliefImage(hill((x, y) => x - y), { width: 32, stops: grey }));
  const facingSE = mean(reliefImage(hill((x, y) => -x + y), { width: 32, stops: grey }));
  const flat = mean(reliefImage(hill(() => 0), { width: 32, stops: grey }));
  assert.ok(facingNW > flat && flat > facingSE, `${facingNW} ${flat} ${facingSE}`);
  assert.ok(Math.abs(flat - 128) <= 1);
  assert.throws(() => reliefImage(ramp, { width: 1 }), RangeError);
  assert.throws(() => reliefImage({ x: [0, 1], y: [0, 1], values: [0, 1, 2] }), RangeError);
});

test('reliefGeometry: heights, outward skirts and UVs that match the image', () => {
  const mesh = reliefGeometry(ramp, { size: [4, 4], scale: 0.5, offset: 2, skirt: -2 });
  const P = mesh.positions, N = mesh.normals, I = mesh.indices;
  // Corner (10, 0): x = 2, y = (10 - 2) * 0.5, z = -2, uv (1, 0).
  assert.deepEqual([...P.slice(10 * 3, 10 * 3 + 3)], [2, 4, -2]);
  assert.deepEqual([...mesh.uvs.slice(20, 22)], [1, 0]);
  // A plane z = x has the normal (-0.5, 1, 0) normalized everywhere on the top.
  const l = Math.hypot(0.5 * 2.5, 1);
  assert.ok(Math.abs(N[5 * 3] + 1.25 / l) < 1e-6 && Math.abs(N[5 * 3 + 1] - 1 / l) < 1e-6);
  // Every triangle winds to agree with its stored normals.
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [I[t], I[t + 1], I[t + 2]].map((k) => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]]);
    const u = b.map((v, i) => v - a[i]), v = c.map((w, i) => w - a[i]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const s = N.slice(I[t] * 3, I[t] * 3 + 3);
    assert.ok(n[0] * s[0] + n[1] * s[1] + n[2] * s[2] > 0, `triangle ${t / 3}`);
  }
  assert.equal(Math.min(...P.filter((_, i) => i % 3 === 1)), -2);
  assert.deepEqual(mesh.groups, [{ start: 0, count: 600, materialIndex: 0 }, { start: 600, count: I.length - 600, materialIndex: 1 }]);
  assert.equal(reliefGeometry(ramp, { stride: 2 }).positions.length, (6 * 6) * 3);
  assert.equal(reliefGeometry(ramp).groups, undefined);
});
