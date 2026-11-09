import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '../../splines/dist/index.js';
import { road } from '../dist/index.js';

test('Gemini three-point closed loop has an exact seam at segments 128', () => {
  const result = road(
    new Spline(
      [
        [-25, 0, 25],
        [-34, 0, 0],
        [-35, 0, -25],
      ],
      { closed: true },
    ),
    { segments: 128 },
  );
  const v = result.geometry.vertices,
    row = (result.section.length - 1) * 2;
  assert.deepEqual(v.slice(0, row * 6), v.slice(128 * row * 6));
});

test('vertical input gives a coded linked error while steep nonvertical ramps work', () => {
  assert.throws(
    () =>
      road(
        new Spline([
          [0, 0, 0],
          [0, 20, 0],
          [0, 40, 0],
        ]),
      ),
    (e) => e.code === 'unsupported' && /nonvertical.*https:\/\/margoengine.com\/errors#geometry/.test(e.message),
  );
  const steep = road(
    new Spline([
      [0, 0, 0],
      [0.1, 20, 0],
      [0.2, 40, 0],
    ]),
  );
  assert.ok(steep.geometry.vertices.every(Number.isFinite));
  assert.ok(steep.geometry.indices.length > 0);
});

test('tight curbed hairpins keep every face outward on either turn and on grades', () => {
  for (const mirror of [-1, 1])
    for (const grade of [0, 0.3]) {
      const points = [
        [0, 0, -12],
        [0, 0, 0],
        [0.4 * mirror, 0, 0.2],
        [0.4 * mirror, 0, -12],
      ];
      points.forEach((p, i) => {
        p[1] = i * grade;
      });
      const { geometry, section } = road(new Spline(points));
      const v = geometry.vertices,
        ix = geometry.indices;
      let narrow = false;
      for (let i = 0; i < ix.length; i += 3) {
        const ids = [...ix.slice(i, i + 3)],
          [a, b, c] = ids.map((id) => [...v.slice(id * 6, id * 6 + 3)]);
        const u = b.map((x, k) => x - a[k]),
          w = c.map((x, k) => x - a[k]);
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        assert.ok(Math.hypot(...n) > 0, `noncollapsed face ${i / 3}`);
        for (const id of ids)
          assert.ok(
            n.reduce((sum, x, k) => sum + x * v[id * 6 + 3 + k], 0) > 0,
            `outward face ${i / 3}, vertex ${id}, turn ${mirror}, grade ${grade}`,
          );
      }
      const row = (section.length - 1) * 2;
      for (let i = 0; i <= 128; i++) {
        const a = (i * row + 6) * 6,
          b = a + 6;
        if (Math.hypot(v[b] - v[a], v[b + 2] - v[a + 2]) < 5.99) narrow = true;
      }
      assert.ok(narrow, 'inside offset is narrowed before its focal fold');
    }
});
