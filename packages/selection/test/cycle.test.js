import test from 'node:test';
import assert from 'node:assert/strict';
import { CycleRaycast } from '../dist/index.js';

const hits = ['front', 'middle', 'back'];
test('repeating a pick at the same spot steps through the hits and wraps', () => {
  const c = new CycleRaycast();
  assert.equal(c.pick(10, 10, hits), 'front');
  assert.equal(c.pick(11, 10, hits), 'middle');
  assert.equal(c.pick(10, 10, hits), 'back');
  assert.equal(c.pick(10, 10, hits), 'front');
  assert.equal(c.index, 0);
});
test('moving the pointer or changing the list restarts at the nearest hit', () => {
  const c = new CycleRaycast();
  c.pick(10, 10, hits);
  c.pick(10, 10, hits);
  assert.equal(c.pick(40, 10, hits), 'front');
  c.pick(40, 10, hits);
  assert.equal(c.pick(40, 10, ['a', 'b']), 'a');
  assert.equal(c.pick(40, 10, []), null);
  assert.equal(c.index, -1);
});
test('wrap false stops at the ends and step goes back', () => {
  const c = new CycleRaycast({ wrap: false });
  c.pick(0, 0, hits);
  assert.equal(c.step(-1), 'front');
  c.step(5);
  assert.equal(c.current, 'back');
});
test('the Tab key and Alt wheel step, Shift reverses, other events do nothing', () => {
  const c = new CycleRaycast();
  c.pick(0, 0, hits);
  assert.equal(c.handle({ type: 'keydown', key: 'Tab' }), 'middle');
  assert.equal(c.handle({ type: 'keydown', key: 'Tab', shiftKey: true }), 'front');
  assert.equal(c.handle({ type: 'wheel', deltaY: 10, altKey: true }), 'middle');
  assert.equal(c.handle({ type: 'wheel', deltaY: 10 }), undefined);
  assert.equal(c.handle({ type: 'keydown', key: 'a' }), undefined);
  assert.equal(c.current, 'middle');
});
test('bad options and coordinates throw a RangeError that names the fix', () => {
  assert.throws(() => new CycleRaycast({ tolerance: -1 }), (e) => e instanceof RangeError && /pass a valid tolerance/.test(e.message));
  assert.throws(() => new CycleRaycast().pick(NaN, 0, hits), RangeError);
});
test('fresh hit objects on the same meshes continue the cycle', () => {
  const a = { mesh: 'A', distance: 1 },
    b = { mesh: 'B', distance: 2 };
  const c = new CycleRaycast();
  assert.equal(c.pick(5, 5, [{ ...a }, { ...b }]).mesh, 'A');
  assert.equal(c.pick(5, 5, [{ ...a }, { ...b }]).mesh, 'B');
  const byDistance = new CycleRaycast({ identity: (h) => h.distance });
  byDistance.pick(5, 5, [a, b]);
  assert.deepEqual(byDistance.pick(5, 5, [{ ...a }, { ...b }]), b);
});
