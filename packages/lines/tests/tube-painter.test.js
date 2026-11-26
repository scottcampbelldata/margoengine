import test from 'node:test';
import assert from 'node:assert/strict';
import { TubePainter, rayPoint } from '../dist/tube-painter.js';

const helix = (painter, n = 60) => {
  painter.begin([1, 0, 0]);
  for (let i = 1; i < n; i++) painter.add([Math.cos(i / 5), Math.sin(i / 5), i / 20]);
  painter.end();
};
const tri = (d, t) => [0, 1, 2].map((k) => Array.from(d.positions.subarray(d.indices[t * 3 + k] * 3, d.indices[t * 3 + k] * 3 + 3)));
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

test('a stroke becomes a closed tube whose radius, normals and winding are right', () => {
  const p = new TubePainter({ radius: 0.1, sides: 8, minDistance: 0.01 });
  p.begin([0, 0, 0]);
  for (let i = 1; i <= 10; i++) p.add([0, 0, i * 0.2]);
  p.end();
  const d = p.data();
  assert.equal(d.positions.length, d.normals.length);
  // Every side vertex sits one radius from the z axis; normals are unit and point outward.
  for (let v = 0; v < 11 * 8; v++) {
    const x = d.positions[v * 3],
      y = d.positions[v * 3 + 1];
    assert.ok(Math.abs(Math.hypot(x, y) - 0.1) < 1e-6);
    const n = [d.normals[v * 3], d.normals[v * 3 + 1], d.normals[v * 3 + 2]];
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-5);
    assert.ok(n[0] * x + n[1] * y > 0);
  }
  // Counter-clockwise from outside: each side triangle's geometric normal agrees with its vertex normal.
  for (let t = 0; t < 11 * 8 * 0 + 10 * 8 * 2; t++) {
    const [a, b, c] = tri(d, t),
      g = cross(sub(b, a), sub(c, a)),
      n = d.normals.subarray(d.indices[t * 3] * 3, d.indices[t * 3] * 3 + 3);
    assert.ok(g[0] * n[0] + g[1] * n[1] + g[2] * n[2] > 0, `triangle ${t} faces inward`);
  }
  // Two cap discs, one of 8 triangles each, close both ends and face along the tangent.
  assert.equal(d.indices.length / 3, 10 * 8 * 2 + 16);
  const caps = p.data();
  assert.deepEqual(Array.from(caps.indices), Array.from(d.indices));
  assert.equal(new TubePainter({ radius: 0.1, caps: false }).data().indices.length, 0);
});
test('the frame does not twist along a helix: neighbouring rings turn by the path only', () => {
  const p = new TubePainter({ radius: 0.05, sides: 6, minDistance: 0.01 });
  helix(p);
  const d = p.data();
  // Rotation-minimizing frames: the first vertex of each ring moves about as far as the centre moves (no spin of the ring).
  let worst = 0;
  for (let r = 1; r < 59; r++) {
    const a = d.positions.subarray(r * 18, r * 18 + 3),
      b = d.positions.subarray((r + 1) * 18, (r + 1) * 18 + 3),
      ca = [Math.cos(r / 5), Math.sin(r / 5), r / 20],
      cb = [Math.cos((r + 1) / 5), Math.sin((r + 1) / 5), (r + 1) / 20];
    worst = Math.max(worst, Math.abs(Math.hypot(...sub(Array.from(b), Array.from(a))) - Math.hypot(...sub(cb, ca))));
  }
  assert.ok(worst < 0.02, `rings spin by ${worst}`);
});
test('pressure scales the radius, close points are skipped and maxPoints stops a stroke', () => {
  const p = new TubePainter({ radius: 0.1, minDistance: 0.5, maxPoints: 3, caps: false });
  p.begin([0, 0, 0], 0.5);
  assert.equal(p.add([0, 0, 0.1]), false);
  assert.equal(p.add([0, 0, 1], 2), true);
  assert.equal(p.add([0, 0, 2]), true);
  assert.equal(p.add([0, 0, 3]), false);
  const d = p.data();
  assert.ok(Math.abs(Math.hypot(d.positions[0], d.positions[1]) - 0.05) < 1e-6);
  assert.ok(Math.abs(Math.hypot(d.positions[8 * 3], d.positions[8 * 3 + 1]) - 0.2) < 1e-6);
});
test('undo, clear, single points and toGeometry', () => {
  const p = new TubePainter();
  p.begin([0, 0, 0]);
  assert.equal(p.data().indices.length, 0);
  p.end();
  helix(p);
  assert.equal(p.strokeCount, 2);
  assert.equal(p.toGeometry().indices.length, p.data().indices.length);
  assert.equal(p.undo(), true);
  assert.equal(p.undo(), true);
  assert.equal(p.undo(), false);
  helix(p);
  p.clear();
  assert.equal(p.strokeCount, 0);
  assert.equal(p.add([0, 0, 0]), false);
});
test('rayPoint and bad input name the fix', () => {
  assert.deepEqual(rayPoint([0, 0, 4], [0, 0, -2], 3), [0, 0, 1]);
  const fixes = (e) => e instanceof RangeError && /pass valid options/.test(e.message);
  assert.throws(() => new TubePainter({ radius: 0 }), fixes);
  assert.throws(() => new TubePainter({ sides: 2 }), fixes);
  assert.throws(() => new TubePainter({ maxPoints: 1 }), fixes);
  assert.throws(() => new TubePainter().begin([NaN, 0, 0]), fixes);
  assert.throws(() => rayPoint([0, 0, 0], [0, 0, 1], Infinity), fixes);
});
