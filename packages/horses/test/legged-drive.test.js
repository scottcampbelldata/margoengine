import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HorseMotion } from '../dist/index.js';
import { horseBody } from '../dist/anatomy.js';
import { GRAVITY, strideLength } from '../dist/gaits.js';

const dt = 1 / 240;
const ride = (speed, heading = 0) => ({ speed, heading, gait: 'auto' });
const close = (actual, expected, tolerance = 1e-11) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' vs ' + expected);

test('PA-68: the same drive accelerates a mounted load by the ratio of masses', () => {
  const body = horseBody();
  const bare = new HorseMotion(body);
  const loaded = new HorseMotion(body, { loadMass: body.mass });
  bare.step(dt, ride(4));
  loaded.step(dt, ride(4));
  close(bare.speed, 3 * dt);
  close(loaded.speed, 1.5 * dt);
});

test('PA-68: turning traction bounds yaw at speed and banks the torso into the turn', () => {
  const body = horseBody();
  const grip = 0.35;
  const fast = new HorseMotion(body, { grip, turnRate: 4 });
  fast.speed = 11;
  fast.step(dt, ride(fast.speed, 1));
  const expectedYaw = (grip * GRAVITY * dt) / 11;
  close(fast.heading, expectedYaw);
  close(fast.bank, -Math.atan(grip));
  assert.equal(fast.slipping, true);
  const stopped = new HorseMotion(body, { grip, turnRate: 4 });
  stopped.step(dt, ride(0, 1));
  close(stopped.heading, 4 * dt);
  close(stopped.bank, 0);
});

test('PA-68: a poorly gripped cross slope gives downhill slip', () => {
  const horse = new HorseMotion(horseBody(), { grip: 0.1, ground: (x) => 0.25 * x });
  horse.step(dt, ride(0));
  const normal = GRAVITY / Math.hypot(1, 0.25);
  close(horse.sidewaysSpeed, -(0.25 - 0.1) * normal * dt);
  assert.ok(horse.x < 0);
  assert.equal(horse.slipping, true);
});

test('PA-69 and HORSE-3: real support elevation uses four samples and a slope costs speed and changes gait', () => {
  const body = horseBody();
  const sampled = [];
  const elevated = new HorseMotion(body, {
    ground: (x, z) => {
      sampled.push([x, z]);
      return z === 0 ? 20 : 5 + 0.2 * z;
    },
  });
  close(elevated.supportHeight(), 5);
  assert.equal(new Set(sampled.map((point) => point.join(','))).size, 4);
  const grade = 0.2;
  const uphill = new HorseMotion(body, { ground: (_x, z) => grade * z });
  const level = new HorseMotion(body);
  for (let i = 0; i < 4 * 240; i++) {
    uphill.step(dt, ride(3.2));
    level.step(dt, ride(3.2));
  }
  close(level.speed, 3.2);
  close(uphill.speed, (3.2 * 3) / (3 + (GRAVITY * grade) / Math.hypot(1, grade)));
  assert.equal(level.gait, 'trot');
  assert.equal(uphill.gait, 'walk');
});

test('PA-70 and HORSE-4: live stride cycles follow actual speed without a jump at a speed change', () => {
  const body = horseBody();
  const motion = new HorseMotion(body);
  const low = 2.75;
  const high = 4.25;
  for (const speed of [low, high]) {
    motion.speed = speed;
    const phase = motion.strideCyclesAt();
    for (let i = 0; i < 240; i++) motion.step(dt, ride(speed));
    close(motion.strideCyclesAt() - phase, speed / strideLength(body, speed));
  }
  assert.notEqual(strideLength(body, low), strideLength(body, high));
});
