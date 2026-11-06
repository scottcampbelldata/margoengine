import test from 'node:test';
import assert from 'node:assert/strict';
import { Lines } from '../dist/index.js';
import { Trail } from '../dist/trail.js';
import { rig } from './gpu-rig.js';

const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-5, `${message ?? ''} expected ${expected}, got ${actual}`);
const point = (trail, i) => Array.from(trail.points.subarray(i * 4, i * 4 + 3));
const alpha = (trail, i) => trail.colors[i * 4 + 3];
const engine = {};

/** A trail moved along +x by `step` per tick of `delta` seconds. */
function walked(options, ticks, step = 1, delta = 0.1) {
  let x = 0;
  const trail = new Trail({ minDistance: 0, ...options, target: () => [x, 0, 0] });
  trail.update(engine, 0);
  for (let i = 0; i < ticks; i++) {
    x += step;
    trail.update(engine, delta);
  }
  return trail;
}

test('points run head first and opacity falls with age', () => {
  const trail = walked({ lifetime: 1 }, 4);
  assert.equal(trail.count, 5);
  assert.deepEqual(point(trail, 0), [4, 0, 0]);
  assert.deepEqual(point(trail, 4), [0, 0, 0]);
  close(alpha(trail, 0), 1);
  close(alpha(trail, 2), 0.8);
  close(alpha(trail, 4), 0.6);
});

test('the far end is cut exactly at the age limit, at zero opacity', () => {
  const trail = walked({ lifetime: 0.25 }, 5),
    last = trail.count - 1;
  // Moving 10 units a second for 0.25 s: 2.5 units behind the head at x = 5.
  close(trail.points[last * 4], 2.5, 'tail x');
  close(alpha(trail, last), 0);
  assert.ok(trail.length <= 4, 'samples past the limit are dropped');
});

test('maxLength cuts the far end by distance and fades by distance', () => {
  const trail = walked({ lifetime: Infinity, maxLength: 2.5 }, 6),
    last = trail.count - 1;
  close(trail.points[0], 6);
  close(trail.points[last * 4], 3.5, 'tail x');
  close(alpha(trail, last), 0);
  close(alpha(trail, 1), 0.6);
});

test('a target that stops fades out, then a move starts a new trail with no line back', () => {
  let at = [0, 0, 0];
  const trail = new Trail({ lifetime: 1, minDistance: 0, target: () => at });
  trail.update(engine, 0);
  at = [1, 0, 0];
  trail.update(engine, 0.1);
  assert.equal(trail.count, 2);
  trail.update(engine, 0.5);
  assert.ok(alpha(trail, 0) < 0.6, 'the head at rest ages');
  trail.update(engine, 1);
  assert.equal(trail.count, 0);
  assert.equal(trail.segmentCount, 0);
  const version = trail.version;
  trail.update(engine, 0.1);
  assert.equal(trail.version, version, 'an empty trail costs no upload');
  at = [50, 0, 0];
  trail.update(engine, 0.1);
  assert.equal(trail.count, 0, 'one point draws nothing');
  at = [51, 0, 0];
  trail.update(engine, 0.1);
  assert.equal(trail.count, 2);
  assert.deepEqual(point(trail, 1), [50, 0, 0]);
});

test('the head leaves a point only past minDistance, and stays live in between', () => {
  const trail = new Trail({ minDistance: 1 });
  trail.moveTo(0, 0, 0);
  trail.moveTo(0.4, 0, 0);
  assert.equal(trail.length, 2);
  trail.moveTo(0.8, 0, 0);
  assert.equal(trail.length, 2, 'the live head moved');
  trail.moveTo(1.2, 0, 0);
  assert.equal(trail.length, 3);
  trail.update(engine, 0);
  assert.deepEqual(point(trail, 0).map(Math.fround), [1.2, 0, 0].map(Math.fround));
});

test('maxPoints bounds the ring and keeps the newest points', () => {
  const trail = walked({ lifetime: Infinity, maxPoints: 4, fade: 0 }, 100),
    points = trail.points;
  assert.equal(trail.count, 4);
  assert.equal(points, trail.points);
  assert.deepEqual(point(trail, 3), [97, 0, 0]);
  close(alpha(trail, 3), 1, 'fade 0 keeps full opacity');
});

test('tailWidth and tailColor run along the trail; setColor and reset work', () => {
  const trail = walked({ lifetime: 1, color: [1, 0, 0], tailColor: [0, 0, 1], tailWidth: 0.5 }, 5);
  close(trail.points[3], 1, 'width at the head');
  close(trail.points[5 * 4 + 3], 0.75, 'half way along the life');
  close(trail.colors[0], 1);
  close(trail.colors[5 * 4], 0.5);
  close(trail.colors[5 * 4 + 2], 0.5);
  trail.setColor([0, 1, 0]);
  trail.update(engine, 0);
  close(trail.colors[1], 1);
  trail.reset();
  trail.target = null;
  trail.update(engine, 0.1);
  assert.equal(trail.count, 0);
  assert.equal(trail.length, 0);
});

test('options are checked', () => {
  for (const bad of [
    { lifetime: 0 },
    { maxLength: -1 },
    { minDistance: -1 },
    { fade: -1 },
    { fade: Infinity },
    { maxPoints: 1 },
    { maxPoints: 1.5 },
    { maxPoints: 70000 },
    { tailWidth: 2 },
    { offset: [0, 0] },
    { offset: [0, 0, NaN] },
  ])
    assert.throws(() => new Trail(bad), RangeError, JSON.stringify(bad));
  assert.throws(() => new Trail().moveTo(0, NaN, 0), RangeError);
});

test('the plugin passes the frame delta, and a trail compiles the width shader only for itself', () => {
  const { lines, frame } = rig();
  assert.ok(lines instanceof Lines);
  let x = 0;
  const trail = lines.add(new Trail({ lifetime: 1, minDistance: 0, target: () => [x++, 0, 0] }));
  frame(0.25);
  frame(0.25);
  const log = frame(0.25);
  assert.equal(trail.count, 3);
  close(alpha(trail, 2), 0.5);
  assert.ok(log.some((e) => e[0] === 'pass.draw'));
  const again = rig();
  again.lines.add(new Trail({ target: () => [(again.n = (again.n ?? 0) + 1), 0, 0], minDistance: 0 }));
  again.frame(0.1);
  again.frame(0.1);
  const made = again.frame(0.1).filter((e) => e[0] === 'module').length;
  assert.equal(made, 0, 'a steady trail compiles nothing new');
  const dashed = rig();
  dashed.lines.add(new Trail({ target: () => [(dashed.n = (dashed.n ?? 0) + 1), 0, 0], minDistance: 0, dashed: true }));
  dashed.frame(0.1);
  dashed.frame(0.1);
  assert.deepEqual(
    dashed.frame(0.1).filter((e) => e[0] === 'module'),
    [],
    'dashed trails keep the plain shader',
  );
});
