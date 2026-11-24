import test from 'node:test';
import assert from 'node:assert/strict';
import { to, from, fromTo, keyframes } from '../dist/props.js';
import { Vector3 } from '@margoengine/math/vector3';

test('object and actual vector properties move together with relative arithmetic', async () => {
  const vector = new Vector3(1, 2, 3);
  const move = to(vector, { x: '+=4', y: '*=3', z: '-=2' }, { duration: 2 });
  move.update(1);
  assert.deepEqual([vector.x, vector.y, vector.z], [3, 4, 2]);
  move.update(1);
  await move;
  assert.deepEqual([vector.x, vector.y, vector.z], [5, 6, 1]);
});

test('from and fromTo render starts immediately and preserve unmentioned keys', async () => {
  const value = { x: 10, y: 30, untouched: 8 };
  const first = from(value, { x: 0, y: '+=10' }, { duration: 1 });
  assert.deepEqual(value, { x: 0, y: 40, untouched: 8 });
  first.update(1);
  await first;
  assert.deepEqual(value, { x: 10, y: 30, untouched: 8 });
  const next = fromTo(value, { x: '-=5', y: 0 }, { x: '+=10', y: 20 }, { duration: 1 });
  assert.equal(value.x, 5);
  next.update(0.5);
  assert.equal(value.x, 10);
  next.update(0.5);
  await next;
  assert.equal(value.x, 15);
});

test('keyframe value lists are explicit starts, with per-segment easing and yoyo', async () => {
  const value = { x: 99, y: 8 };
  const move = to(value, { x: [0, 10, '+=20'], y: [2, 6] }, { duration: 2, repeat: 1, yoyo: true, easing: (t) => t * t });
  assert.equal(value.x, 0);
  assert.equal(value.y, 2);
  move.update(0.5);
  assert.equal(value.x, 2.5);
  assert.equal(value.y, 2.25);
  move.update(1.5);
  assert.equal(value.x, 30);
  move.update(2);
  await move;
  assert.deepEqual(value, { x: 0, y: 2 });
});

test('multi-property keys distribute missing offsets and hold endpoints', async () => {
  const value = { x: 0, y: 0 };
  const move = keyframes(value, [
    { values: { x: 2 }, offset: 0.2 },
    { values: { x: 6, y: 4 }, easing: (t) => t * t },
    { values: { x: 10 }, offset: 0.8 },
  ], { duration: 10 });
  move.update(1);
  assert.equal(value.x, 2);
  move.update(2.5);
  assert.ok(Math.abs(value.x - 4) < 1e-12);
  move.update(3);
  assert.ok(Math.abs(value.x - 7) < 1e-12);
  assert.equal(value.y, 4);
  move.update(3.5);
  await move;
  assert.deepEqual(value, { x: 10, y: 4 });
});

test('validation is atomic and cancellation preserves all current properties', async () => {
  const value = { x: 5, y: 6 };
  for (const values of [{ x: 1, y: NaN }, { x: '/=0' }, { x: [] }, { x: '+=Infinity' }]) {
    assert.throws(() => from(value, values, { duration: 1 }), RangeError);
    assert.deepEqual(value, { x: 5, y: 6 });
  }
  assert.throws(() => to(value, { x: 10 }, { duration: 1, easing: 1 }), RangeError);
  const controller = new AbortController();
  const move = to(value, { x: 10, y: 20 }, { duration: 1, signal: controller.signal });
  const rejected = assert.rejects(move.finished, { name: 'AbortError' });
  move.update(0.5);
  controller.abort();
  const saved = { ...value };
  move.update(1);
  assert.deepEqual(value, saved);
  await rejected;
});

test('pause and speed are local, finite dt is required even when paused', async () => {
  const value = { x: 0 }, move = to(value, { x: 10 }, { duration: 1 });
  move.pause().update(0.5);
  assert.equal(value.x, 0);
  assert.throws(() => move.update(NaN), RangeError);
  assert.throws(() => { move.speed = -1; }, RangeError);
  move.speed = 2;
  move.play().update(0.5);
  await move;
  assert.equal(value.x, 10);
});
