import test from 'node:test';
import assert from 'node:assert/strict';
import { Spring, springOptions } from '../dist/index.js';

const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
/** Walks a spring from 0 to 1 and returns the highest value and when it first reached the target. */
function run(spring, seconds = 8, dt = 1 / 4000) {
  let peak = 0,
    crossed = Infinity;
  for (let time = 0; time < seconds; time += dt) {
    spring.update(dt);
    if (crossed === Infinity && spring.value >= 1) crossed = time + dt;
    peak = Math.max(peak, spring.value);
  }
  return { peak, crossed };
}

test('duration is the period of the undamped spring and bounce takes away that share of the damping', () => {
  const spring = new Spring({ duration: 0.5, bounce: 0.3 });
  // omega = 2 pi / duration; the ratio is 1 - bounce; with mass 1, stiffness is omega^2 and damping 2 * ratio * omega.
  near(spring.stiffness, (2 * Math.PI * 2) ** 2, 1e-10);
  near(spring.dampingRatio, 0.7);
  near(spring.damping, 2 * 0.7 * 4 * Math.PI, 1e-10);
});

test('bounce 0 is critically damped, exactly, so it never overshoots', () => {
  for (const duration of [0.1, 0.37, 1, 2.9]) {
    const spring = new Spring({ duration, bounce: 0, target: 1 });
    assert.equal(spring.dampingRatio, 1);
    assert.ok(run(spring).peak <= 1);
  }
  assert.equal(new Spring({ duration: 0.4, target: 1 }).dampingRatio, 1, 'bounce defaults to 0');
});

test('the overshoot of a spring from rest is the closed form for its bounce', () => {
  for (const bounce of [0.1, 0.3, 0.5, 0.8]) {
    const ratio = 1 - bounce,
      expected = 1 + Math.exp((-Math.PI * ratio) / Math.sqrt(1 - ratio * ratio)),
      spring = new Spring({ duration: 0.5, bounce, target: 1, precision: 0 }),
      { peak } = run(spring, 4);
    // Sampled at 4,000 Hz, the peak is missed by at most curvature * dt^2 / 8, under 1e-5 for these springs.
    near(peak, expected, 1e-5);
  }
});

test('duration scales time and nothing else: twice the duration, the same curve at half speed', () => {
  const quick = new Spring({ duration: 0.5, bounce: 0.4, target: 1, precision: 0 }),
    slow = new Spring({ duration: 1, bounce: 0.4, target: 1, precision: 0 });
  for (let i = 0; i < 60; i++) {
    quick.update(1 / 120);
    slow.update(1 / 60);
    near(quick.value, slow.value, 1e-12);
  }
});

test('a negative bounce is overdamped: slower, still no overshoot', () => {
  const spring = new Spring({ duration: 0.5, bounce: -0.5, target: 1 });
  near(spring.dampingRatio, 2);
  const stiff = new Spring({ duration: 0.5, bounce: 0, target: 1 }),
    { peak, crossed } = run(spring),
    critical = run(stiff);
  assert.ok(peak <= 1);
  assert.ok(crossed > critical.crossed);
});

test('mass is respected: the same motion with any mass', () => {
  const light = new Spring({ duration: 0.5, bounce: 0.25, target: 1, precision: 0 }),
    heavy = new Spring({ duration: 0.5, bounce: 0.25, mass: 7, target: 1, precision: 0 });
  near(heavy.dampingRatio, 0.75);
  for (let i = 0; i < 40; i++) {
    light.update(1 / 60);
    heavy.update(1 / 60);
    near(light.value, heavy.value, 1e-9);
  }
});

test('it still settles and takes a new target with its velocity', () => {
  const spring = new Spring({ duration: 0.3, bounce: 0.2, target: 1 });
  for (let i = 0; i < 600; i++) spring.update(1 / 60);
  assert.equal(spring.value, 1);
  assert.equal(spring.settled, true);
  spring.target = 0;
  spring.update(1 / 60);
  assert.ok(spring.value < 1);
});

test('springOptions gives the physics numbers for anywhere that takes them', () => {
  const options = springOptions(0.5, 0.3, 2),
    spring = new Spring({ ...options, mass: 2 }),
    same = new Spring({ duration: 0.5, bounce: 0.3, mass: 2 });
  assert.equal(spring.stiffness, same.stiffness);
  assert.equal(spring.damping, same.damping);
});

test('the old options work as they did, and the two ways do not mix', () => {
  const spring = new Spring({ stiffness: 120, damping: 12 });
  assert.equal(spring.stiffness, 120);
  assert.equal(spring.damping, 12);
  assert.equal(new Spring().stiffness, 170);
  for (const options of [
    { duration: 1, stiffness: 100 },
    { duration: 1, damping: 10 },
    { bounce: 0.5, stiffness: 100 },
    { bounce: 0.5 },
    { duration: 0 },
    { duration: -1 },
    { duration: Infinity },
    { duration: 1, bounce: 1 },
    { duration: 1, bounce: -1 },
    { duration: 1, bounce: NaN },
  ])
    assert.throws(() => new Spring(options), RangeError, JSON.stringify(options));
});
