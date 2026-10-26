import test from 'node:test';
import assert from 'node:assert/strict';
import { arrowSegments, sampleField, streamline } from '@margoengine/sciviz/maths';

// A rotation field u = -y, v = x on [-1, 1]^2 (21 x 21 samples): streamlines are circles about the origin.
const n = 21,
  u = new Float64Array(n * n),
  v = new Float64Array(n * n);
for (let j = 0; j < n; j++)
  for (let i = 0; i < n; i++) {
    const x = -1 + (2 * i) / (n - 1),
      y = -1 + (2 * j) / (n - 1);
    u[j * n + i] = -y;
    v[j * n + i] = x;
  }
const rotation = { u, v, dims: [n, n, 1], bounds: [-1, 1, -1, 1, 0, 0] };

test('sampleField interpolates trilinearly and is null outside the grid', () => {
  // The field is linear, so interpolation is exact between samples.
  assert.deepEqual(
    sampleField(rotation, 0.33, -0.21, 0).map((c) => Math.round(c * 1e9) / 1e9),
    [0.21, 0.33, 0],
  );
  assert.equal(sampleField(rotation, 1.2, 0, 0), null);
  const holed = { ...rotation, u: Float64Array.from(u, (x, k) => (k === 0 ? Number.NaN : x)) };
  assert.equal(sampleField(holed, -0.99, -0.99, 0), null, 'next to a NaN sample');
});

test('RK4 streamlines of a rotation stay on their circle', () => {
  const line = streamline(rotation, [0.5, 0, 0], { step: 0.01, maxSteps: 300, direction: 'forward' });
  assert.equal(line.positions.length / 3, 301, 'the seed and 300 steps');
  let worst = 0;
  for (let i = 0; i < line.positions.length; i += 3)
    worst = Math.max(worst, Math.abs(Math.hypot(line.positions[i], line.positions[i + 1]) - 0.5));
  assert.ok(worst < 1e-6, `radius drift ${worst}`);
  // Counter-clockwise: the first step goes towards +y.
  assert.ok(line.positions[4] > 0);
  assert.ok(Math.abs(line.speeds[0] - 0.5) < 1e-9, 'speed is the radius');
  // Both ways: the seed sits in the middle.
  const both = streamline(rotation, [0.5, 0, 0], { step: 0.01, maxSteps: 50 });
  assert.equal(both.positions.length / 3, 101);
  assert.deepEqual([...both.positions.slice(150, 153)], [0.5, 0, 0]);
  // A seed outside the grid gives nothing; a line leaving the grid stops at its edge.
  assert.equal(streamline(rotation, [3, 0, 0]).positions.length, 0);
  const outward = streamline(
    { u: new Float64Array(n * n).fill(1), v: new Float64Array(n * n), dims: [n, n, 1], bounds: [-1, 1, -1, 1, 0, 0] },
    [0, 0, 0],
    { step: 0.1, direction: 'forward' },
  );
  assert.ok(outward.positions.at(-3) <= 1 && outward.positions.at(-3) > 0.85, 'stops at the edge');
});

test('arrowSegments draw a shaft and two head strokes per non-zero sample', () => {
  const { segments, sample } = arrowSegments([0, 1], [0, 0], undefined, [1, 0], [0, 0], undefined, 2);
  assert.equal(segments.length, 3 * 6, 'one arrow: three segments of two points');
  assert.deepEqual([...sample], [0, 0, 0]);
  assert.deepEqual([...segments.slice(0, 6)], [0, 0, 0, 2, 0, 0], 'the shaft is the vector times the scale');
  // Head strokes end behind the tip, symmetric about the shaft, in the plane.
  const [ax, ay, az] = segments.slice(9, 12),
    [bx, by] = segments.slice(15, 18);
  assert.ok(ax < 2 && Math.abs(ay + by) < 1e-12 && az === 0 && Math.abs(ax - bx) < 1e-12);
  assert.ok(Math.abs(Math.hypot(ax - 2, ay) - 0.6) < 1e-12, 'heads are 0.3 of the shaft');
});
