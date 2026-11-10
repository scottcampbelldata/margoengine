// Batch 132 audit regressions: each test fails on the source before its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer } from '../dist/index.js';

test('the sampled velocity is the derivative of the sampled Hermite position', () => {
  // A cubic path: Hermite reproduces it exactly, so its velocity must be exact too.
  const p = (t) => t * t * t - 2 * t,
    v = (t) => 3 * t * t - 2,
    buffer = new SnapshotBuffer();
  for (const t of [0, 0.5, 1.3]) buffer.push(t, [p(t), 0, 0], undefined, [v(t), 0, 0]);
  for (const t of [0.2, 0.9, 1.1]) {
    const sample = buffer.sample(t);
    assert.ok(Math.abs(sample.position[0] - p(t)) < 1e-12, `position at ${t}`);
    assert.ok(Math.abs(sample.velocity[0] - v(t)) < 1e-12, `velocity at ${t}: ${sample.velocity[0]} vs ${v(t)}`);
  }
});
