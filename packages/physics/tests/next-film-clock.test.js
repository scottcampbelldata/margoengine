// Film mode and `advance`: a simulation that drops no time, and a world that is at the same state at the same frame of a shot
// whatever frame rate the shot is rendered at.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const scene = (options = {}) => {
  const physics = new Physics(null, options);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [20, 0.5, 20] },
  });
  for (let i = 0; i < 4; i++)
    physics.addBody(null, {
      position: [i * 0.3, 1 + i * 1.1, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    });
  return physics;
};

test('a long frame runs every step it owes in film mode, and drops the backlog by default', async () => {
  await Physics.load();
  const normal = scene();
  assert.equal(normal.update(1), 4, 'default: four steps and the rest dropped');
  assert.equal(normal.stepCount, 4);
  const film = scene({ film: true });
  assert.equal(film.film, true);
  assert.equal(film.update(1), 60, 'film: the whole second');
  assert.equal(film.stepCount, 60);
  // The time that does not fill a step is kept, not dropped: frames of 1/90 s owe a step of 1/60 s every one and a half frames.
  const kept = scene({ film: true });
  let total = 0;
  for (let frame = 0; frame < 90; frame++) total += kept.update(1 / 90);
  assert.ok(total >= 59 && total <= 60, `a second of frames of 1/90 s ran ${total} steps`);
  film.dispose();
  normal.dispose();
  kept.dispose();
});

test('a frame of a shot is the same simulation at 24, 30 and 60 frames a second', async () => {
  await Physics.load();
  const hashes = [];
  for (const fps of [24, 30, 60, 120]) {
    const physics = scene({ film: true });
    // Two seconds of the shot, one frame at a time.
    for (let frame = 1; frame <= 2 * fps; frame++) physics.advance(frame, fps);
    assert.equal(physics.stepCount, 120, `${fps} fps: two seconds are 120 steps`);
    hashes.push(physics.kernel.hash);
    physics.dispose();
  }
  assert.deepEqual(new Set(hashes).size, 1, `the same bits at every frame rate: ${hashes}`);
});

test('advance puts the world on the frame whatever calls got it there, and a world cannot go back', async () => {
  await Physics.load();
  const direct = scene({ film: true });
  direct.advance(90, 30);
  const mixed = scene({ film: true });
  mixed.step();
  mixed.update(0.4);
  mixed.advance(90, 30);
  assert.equal(mixed.stepCount, 180);
  assert.equal(direct.kernel.hash, mixed.kernel.hash);
  assert.throws(
    () => mixed.advance(30, 30),
    (error) => error.code === 'state' && /cannot go back/.test(error.message),
  );
  assert.throws(() => direct.advance(1.5, 30), RangeError);
  assert.throws(() => direct.advance(1, 0), RangeError);
  assert.throws(() => direct.advance(1, 29.97), RangeError, 'a float rate is refused: pass {num: 30000, den: 1001}');
  assert.throws(() => direct.advance(1, { num: 24000, den: 0 }), RangeError);
  // A frame between steps leaves its fraction for the interpolation.
  const fine = scene({ film: true });
  fine.advance(1, 24);
  assert.equal(fine.stepCount, 2, '1/24 s is 2.5 steps of 1/60 s');
  assert.ok(Math.abs(fine.alpha - 0.5) < 1e-6, `alpha ${fine.alpha}`);
  for (const physics of [direct, mixed, fine]) physics.dispose();
});

test('a rate of 24000/1001 lands exactly: a frame on a step boundary counts, one before it does not', async () => {
  await Physics.load();
  const rate = { num: 24000, den: 1001 };
  // 400 frames of 1001/24000 s are 1001/60 s each... 400 * 1001 * 60 / 24000 = 1001 steps, exactly.
  const physics = scene({ film: true });
  assert.equal(physics.advance(399, rate), 998, 'frame 399 is 998.9 steps: 998');
  assert.equal(physics.advance(400, rate), 3, 'frame 400 is exactly 1001 steps');
  assert.equal(physics.stepCount, 1001);
  assert.equal(physics.alpha, 0, 'nothing is left over on the boundary');
  // The same by single frames from the start, and by one call: the same bits.
  const frames = scene({ film: true });
  for (let frame = 1; frame <= 400; frame++) frames.advance(frame, rate);
  assert.equal(frames.stepCount, 1001);
  assert.equal(frames.kernel.hash, physics.kernel.hash);
  // A step that does not divide the second cannot be advanced to a frame.
  const odd = scene({ film: true, fixedTimestep: 0.0123 });
  assert.throws(() => odd.advance(1, 24), RangeError);
  for (const world of [physics, frames, odd]) world.dispose();
});
