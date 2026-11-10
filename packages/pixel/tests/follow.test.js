import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PixelCamera } from '../dist/index.js';
import { PixelFollow } from '../dist/follow.js';

const rig = (options = {}, cameraOptions = {}) => new PixelFollow({camera: new PixelCamera({width: 100, height: 60, ...cameraOptions}), ...options});
test('center, dead zone and per-axis lerp match documented camera window behavior', () => {
  const target = {x: 50, y: 30};
  const follow = rig({target, deadZone: [20, 10], lerp: [0.5, 1]});
  target.x = 59; target.y = 35; follow.update(1/60);
  assert.deepEqual([follow.camera.x, follow.camera.y], [0, 0]);
  target.x = 80; target.y = 50; follow.update(1/60);
  assert.deepEqual([follow.camera.x, follow.camera.y], [10, 15]);
  follow.offset = [10, -5]; follow.update(1/60);
  assert.deepEqual([follow.camera.x, follow.camera.y], [20, 15]);
});
test('fractional smoothing accumulates, is frame-rate independent and permits manual repositioning', () => {
  const a = rig({target: {x: 51, y: 30}, lerp: 0.01});
  for (let i = 0; i < 100; i++) a.update(1/60);
  assert.equal(a.camera.x, 1, 'rounding never stalls the follower below one pixel');
  const b = rig({target: {x: 550, y: -100}, lerp: 0.02});
  const c = rig({target: {x: 550, y: -100}, lerp: 0.02});
  for (let i = 0; i < 60; i++) b.update(1/60);
  for (let i = 0; i < 120; i++) c.update(1/120);
  assert.deepEqual([b.camera.x,b.camera.y], [c.camera.x,c.camera.y]);
  b.target = undefined; b.camera.x = -21; b.update(0); assert.equal(b.camera.x, -21);
});
test('world bounds use view extents and units, including negative and undersized worlds', () => {
  const follow = rig({target: () => ({x: 2000, y: -2000}), bounds: {x: -10, y: -20, width: 400, height: 300}}, {unitsPerPixel: 2});
  follow.update(1/60); assert.deepEqual([follow.camera.x,follow.camera.y], [190, -20]);
  follow.bounds = {x: 0, y: 0, width: 20, height: 20}; follow.update(1/60);
  assert.deepEqual([follow.camera.x,follow.camera.y], [-90,-50]);
});
test('seeded shakes are whole-pixel, bounded and do not drift the tracking position', () => {
  const a = rig(), b = rig(); a.shake(1, [10,5], 123); b.shake(1, [10,5], 123);
  const samples = [];
  for (let i = 0; i < 60; i++) {
    a.update(1/60); b.update(1/60);
    assert.deepEqual([a.camera.x,a.camera.y], [b.camera.x,b.camera.y]);
    assert.ok(Number.isInteger(a.camera.x) && Math.abs(a.camera.x) <= 10);
    assert.ok(Number.isInteger(a.camera.y) && Math.abs(a.camera.y) <= 5);
    samples.push(a.camera.x);
  }
  assert.ok(new Set(samples).size > 3); a.update(1); assert.equal(a.camera.x,0);
  a.bounds = {x: 0,y: 0,width: 100,height: 60}; a.shake(1, 100).update(0.1);
  assert.deepEqual([a.camera.x,a.camera.y], [0,0]);
});
test('flash/fade blend independently, hold fade-out, reset and dispose deterministically', () => {
  const follow = rig(); follow.fadeOut(1).update(0.5);
  assert.deepEqual(follow.overlay, [0,0,0,0.5]);
  follow.flash(1,[1,0,0]).update(0.5); assert.deepEqual(follow.overlay, [0.5,0,0,1]);
  follow.update(1); assert.deepEqual(follow.overlay,[0,0,0,1]);
  follow.fadeIn(1).update(1); assert.deepEqual(follow.overlay,[0,0,0,0]);
  follow.flash().resetEffects(); assert.deepEqual(follow.overlay,[0,0,0,0]);
  follow.dispose(); follow.dispose(); assert.throws(()=>follow.update(0),{code:'disposed'});
});
test('invalid mutable settings and effects fail with linked errors', () => {
  for (const option of [{lerp:2}, {deadZone:[101,0]}, {bounds:{x:0,y:0,width:-1,height:1}}, {offset:[Infinity,0]}])
    assert.throws(()=>rig(option), RangeError);
  const follow = rig();
  for (const d of [-1, Infinity, NaN]) assert.throws(()=>follow.update(d), RangeError);
  assert.throws(()=>follow.flash(0), RangeError);
  assert.throws(()=>follow.fadeOut(1, [2,0,0]), RangeError);
  assert.throws(()=>follow.shake(1,-1), RangeError);
  follow.target = {x: NaN,y: 0}; assert.throws(()=>follow.update(1), RangeError);
});
