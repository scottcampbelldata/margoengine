// Batch 132 audit regressions: each test failed on the source before its fix.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FlowField, WALL } from '../dist/flowfield.js';
import { flock } from '../dist/steering.js';

test('overlapping cost stamps undone oldest first leave the original costs, not the first stamp', () => {
  const field = new FlowField({ size: [6, 1] });
  field.setGoal([0.5, 0, 0.5]);
  const fresh = Float32Array.from(field.integration);
  const wall = field.stamp(2, 0, 2, 1, WALL); // cells 2 and 3
  const mud = field.stamp(3, 0, 2, 1, 10); // cells 3 and 4, over the wall at 3
  wall();
  // Cell 3 is still under the mud; cell 2 is free again.
  assert.deepEqual([...field.cost], [1, 1, 1, 10, 10, 1]);
  mud();
  assert.deepEqual([...field.cost], [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(field.integration, fresh);
  assert.ok(field.reachable([5.5, 0, 0.5]));
});

test('cost stamp undo is safe to call twice and in any order', () => {
  const field = new FlowField({ size: [4, 1] });
  field.setGoal([0.5, 0, 0.5]);
  const a = field.stamp(1, 0, 2, 1, 5);
  const b = field.stamp(2, 0, 1, 1, WALL);
  const c = field.stamp(1, 0, 1, 1, 7);
  b();
  b();
  assert.deepEqual([...field.cost], [1, 7, 5, 1]);
  a();
  assert.deepEqual([...field.cost], [1, 7, 1, 1]);
  c();
  assert.deepEqual([...field.cost], [1, 1, 1, 1]);
});

test('flock separation reaches past the neighbourhood radius when separationRadius is larger', () => {
  const arrays = { x: [0, 2.5], y: [0, 0], z: [0, 0], vx: [0, 0], vy: [0, 0], vz: [0, 0] };
  flock(arrays, 2, { radius: 2, separationRadius: 3, alignment: 0, cohesion: 0 }, 0.1);
  assert.ok(arrays.x[0] < 0, `boid 0 should move away, x = ${arrays.x[0]}`);
  assert.ok(arrays.x[1] > 2.5, `boid 1 should move away, x = ${arrays.x[1]}`);
  // Alignment and cohesion still ignore a boid outside radius.
  const far = { x: [0, 2.5], y: [0, 0], z: [0, 0], vx: [0, 1], vy: [0, 0], vz: [0, 0] };
  flock(far, 2, { radius: 2, separationRadius: 3, separation: 0 }, 0.1);
  assert.equal(far.vx[0], 0);
});
