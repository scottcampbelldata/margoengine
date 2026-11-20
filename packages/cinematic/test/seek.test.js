// GAP-FILM-TIME: a Cinematic follow rig and a CameraNoise started at film time T hold the camera a continuous run holds
// at T. Run A takes n + 1 frames; run B is fresh, replays n steps with `advanceTime` (what `seek` from
// @margoengine/cutscene/seek runs; the noise goes in as an `extra` clock, as the brain's stage hook moves it live), then
// takes one frame. Film code moves the followed point and shakes the rig on the way, in both runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cinematic } from '../dist/index.js';
import { CameraNoise, handheld } from '../dist/noise.js';
import { createPose } from '../dist/brain.js';

const FPS = 60,
  plain = (rig) => ({
    time: rig.time,
    position: Array.from(rig.position),
    look: Array.from(rig.lookAt),
    camera: Array.from(rig['cameraPosition']),
    velocity: Array.from(rig['velocity']),
  });
const film = (rig, noise, step) => {
  rig.target[0] = Math.sin(step / 50) * 4;
  rig.target[2] = step * 0.01;
  if (step === 200) rig.shake(0.3, 2);
  noise.speed = step >= 300 ? 2 : 1;
};

for (const n of [1, 600, 54000])
  test(`a follow rig and camera noise replayed ${n} steps equal a continuous run`, () => {
    const a = { rig: new Cinematic({ offset: [0, 2, 5] }), noise: new CameraNoise(handheld) },
      b = { rig: new Cinematic({ offset: [0, 2, 5] }), noise: new CameraNoise(handheld) };
    assert.equal(b.rig.time, 0, 'a fresh Cinematic starts at 0');
    assert.equal(b.noise.time, 0, 'a fresh CameraNoise starts at 0');
    for (let step = 0; step <= n; step++) {
      film(a.rig, a.noise, step);
      a.rig.onPreUpdate(1 / FPS);
      a.noise.update(createPose(), 1 / FPS);
    }
    for (let step = 0; step < n; step++) {
      film(b.rig, b.noise, step);
      b.rig.advanceTime(1 / FPS);
      b.noise.advanceTime(1 / FPS);
    }
    film(b.rig, b.noise, n);
    b.rig.onPreUpdate(1 / FPS);
    b.noise.update(createPose(), 1 / FPS);
    assert.deepEqual(plain(b.rig), plain(a.rig));
    assert.ok(Object.is(b.noise.time, a.noise.time));
    assert.deepEqual(Array.from(b.noise.values), Array.from(a.noise.values));
  });

test('camera noise advanceTime checks its gain and speed as the stage hook does', () => {
  const noise = new CameraNoise(handheld);
  noise.speed = -1;
  assert.throws(() => noise.advanceTime(1 / FPS), RangeError);
});
