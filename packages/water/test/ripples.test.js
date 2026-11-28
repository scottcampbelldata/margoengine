import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';
import { MAX_RIPPLE_OBSTACLES, Ripples } from '../dist/ripples.js';

test('ripple construction and event queue reject invalid input atomically', () => {
  const surface = new Water({ waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }] });
  for (const options of [
    { resolution: 16.5 },
    { speed: NaN },
    { damping: -1 },
    { size: 0 },
    { size: 1, resolution: 512, speed: 100 },
    { followCamera: 1 },
  ])
    assert.throws(() => new Ripples({ surface, ...options }), { name: 'MargoError', code: 'unsupported', message: /errors#ripples/ });
  assert.throws(() => new Ripples({}), /surface/);
  const ripples = new Ripples({ surface, size: 16, resolution: 16 });
  assert.throws(() => ripples.disturb(NaN, 0), /position/);
  assert.throws(() => ripples.disturb(0, 0, 0.5), /radius/);
  assert.throws(() => ripples.wake([0], [0, 0]), /pairs/);
  for (let i = 0; i < 64; i++) ripples.disturb(0, 0);
  assert.throws(() => ripples.disturb(0, 0), /queue full/);
  ripples.dispose();
  ripples.dispose();
  assert.throws(() => ripples.disturb(0, 0), { code: 'disposed' });
  surface.dispose();
});

test('ripple reads require a rendered field and honour an already aborted signal', async () => {
  const ripples = new Ripples({ surface: new Water() });
  await assert.rejects(ripples.readFrame(), { code: 'state' });
  const signal = AbortSignal.abort();
  await assert.rejects(ripples.readFrame({ signal }), { name: 'AbortError' });
  ripples.dispose();
});

// Known bug it guards (docs/known-bugs.md, fixed 2026-11-11): readFrame marked a read pending before it made its read
// buffer, so a refused allocation left every later read refused as "pending".
test('a read whose buffer allocation fails leaves no read pending', async () => {
  globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_DST: 8 };
  const surface = new Water(),
    ripples = new Ripples({ surface, size: 16, resolution: 16 });
  let calls = 0;
  ripples.engine = {
    gpu: {
      createBuffer() {
        calls++;
        throw new RangeError('buffer allocation failed');
      },
    },
  };
  ripples.rendered = true;
  await assert.rejects(ripples.readFrame(), /buffer allocation failed/);
  await assert.rejects(ripples.readFrame(), /buffer allocation failed/);
  assert.equal(calls, 2);
  ripples.engine = undefined;
  ripples.dispose();
  surface.dispose();
});

test('ripples obstacles, trackBody, disturbRay, and setDebug validate inputs and compute geometry cleanly', () => {
  const surface = new Water({ height: 2, waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }] });
  const ripples = new Ripples({ surface, size: 32, resolution: 32, followCamera: false });

  // Obstacles: sphere, cylinder, rotated box, wall.
  ripples.setObstacles([
    { kind: 'sphere', center: [0, 2, 0], radius: 2 },
    { kind: 'cylinder', center: [6, 0], radius: 1.5, minY: 0, maxY: 5 },
    { kind: 'box', center: [-6, 0], halfExtents: [2, 1], rotation: Math.PI / 4 },
    { kind: 'wall', from: [-10, 8], to: [10, 8], thickness: 1.5 },
  ]);
  assert.equal(ripples.obstacles.length, 4);
  assert.equal(ripples.isObstacle(0, 0), true, 'inside sphere');
  assert.equal(ripples.isObstacle(3, 0), false, 'outside sphere');
  assert.equal(ripples.isObstacle(6, 0.5), true, 'inside cylinder');
  assert.equal(ripples.isObstacle(-6, 0), true, 'inside rotated box');
  assert.equal(ripples.isObstacle(0, 8), true, 'inside wall');
  assert.equal(ripples.isObstacle(0, 11), false, 'outside wall');
  // Raising seaLevel above sphere removes its waterline intersection.
  surface.setSeaLevel(10);
  assert.equal(ripples.isObstacle(0, 0), false, 'sphere above/below waterplane does not block');
  surface.setSeaLevel(2);
  assert.equal(ripples.isObstacle(0, 0), true);

  // Validation of bad obstacles and cap.
  assert.throws(() => ripples.setObstacles('bad'), { name: 'MargoError', code: 'unsupported' });
  assert.throws(
    () => ripples.setObstacles(Array.from({ length: MAX_RIPPLE_OBSTACLES + 1 }, () => ({ kind: 'cylinder', center: [0, 0], radius: 1 }))),
    { name: 'MargoError', code: 'unsupported' },
  );
  assert.throws(() => ripples.setObstacles([{ kind: 'cone', center: [0, 0], radius: 1 }]), { name: 'MargoError', code: 'unsupported' });
  assert.throws(() => ripples.setObstacles([{ kind: 'sphere', center: [0, 0], radius: -1 }]), { name: 'MargoError', code: 'unsupported' });
  assert.equal(ripples.obstacles.length, 4, 'failed setObstacles leaves existing obstacles intact');

  // trackBody accepts both [x, y, z] and { x, y, z } duck-typed bodies.
  const boat = { position: [0, 2, 0] };
  const buoy = { position: { x: 4, y: 2, z: 0 } };
  ripples.trackBody(boat, { radius: 1.5, strength: 0.1 });
  ripples.trackBody(buoy, { radius: 1.2, strength: 0.05, obstacle: true });
  assert.equal(ripples.trackedCount, 2);
  assert.equal(ripples.isObstacle(4, 0), true, 'tracked obstacle body appears in obstacle mask');
  ripples.untrackBody(buoy);
  assert.equal(ripples.trackedCount, 1);
  assert.equal(ripples.isObstacle(4, 0), false);
  assert.throws(() => ripples.trackBody({ position: [NaN, 0, 0] }), { name: 'MargoError', code: 'unsupported' });
  assert.throws(() => ripples.trackBody(null), { name: 'MargoError', code: 'unsupported' });

  // disturbRay intersects y = surface.seaLevel (2) within grid [-16..16].
  const hit = ripples.disturbRay([0, 12, 0], [0, -1, 0], 2, 0.15);
  assert.deepEqual(hit, [0, 2, 0]);
  assert.equal(ripples.disturbRay([0, 12, 0], [1, 0, 0]), null, 'parallel ray returns null');
  assert.equal(ripples.disturbRay([0, 12, 0], [0, 1, 0]), null, 'ray pointing away returns null');
  assert.equal(ripples.disturbRay([100, 12, 0], [0, -1, 0]), null, 'ray outside grid returns null');
  assert.throws(() => ripples.disturbRay([0, 0, 0], [0, 0, 0]), { name: 'MargoError', code: 'unsupported' });

  // setDebug validates modes and stores state.
  ripples.setDebug({ enabled: true, mode: 'velocity', bounds: false });
  assert.deepEqual(ripples.debug, { enabled: true, mode: 'velocity', bounds: false });
  ripples.setDebug({ mode: 'obstacles', bounds: true });
  assert.deepEqual(ripples.debug, { enabled: true, mode: 'obstacles', bounds: true });
  ripples.setDebug(false);
  assert.equal(ripples.debug.enabled, false);
  assert.throws(() => ripples.setDebug({ mode: 'unknown' }), { name: 'MargoError', code: 'unsupported' });

  ripples.dispose();
  assert.throws(() => ripples.setObstacles([]), { code: 'disposed' });
  assert.throws(() => ripples.trackBody(boat), { code: 'disposed' });
  assert.throws(() => ripples.disturbRay([0, 10, 0], [0, -1, 0]), { code: 'disposed' });
  assert.throws(() => ripples.setDebug(true), { code: 'disposed' });
  surface.dispose();
});
