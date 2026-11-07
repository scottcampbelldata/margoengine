// The hail stone's path in JavaScript (the same formulas as the shader): fall, two bounces, rest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPLASH_SECONDS, hailCycle, stoneState, validateHail } from '../dist/hail.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} vs ${b}`);
const random = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

test('stoneState: falls at the fall speed, lands, bounces to the heights physics gives, then rests', () => {
  const o = { height: 20, fallSpeed: 20, restitution: 0.25, groundY: 3 };
  const fallTime = 20 / 20;
  assert.deepEqual(stoneState(0, o), { y: 23, vy: -20 });
  near(stoneState(0.5, o).y, 13);
  // Just before landing the stone is at the ground, moving down; just after, moving up at e times the speed.
  near(stoneState(fallTime - 1e-9, o).y, 3, 1e-6);
  const up = stoneState(fallTime + 1e-9, o);
  near(up.vy, 5, 1e-6);
  // The first bounce peaks at v^2 / 2g above the ground, v / g seconds after the landing.
  const g = 9.81,
    v1 = 5;
  near(stoneState(fallTime + v1 / g, o).y, 3 + (v1 * v1) / (2 * g));
  near(stoneState(fallTime + v1 / g, o).vy, 0);
  const v2 = 1.25,
    land2 = fallTime + (2 * v1) / g;
  near(stoneState(land2 + v2 / g, o).y, 3 + (v2 * v2) / (2 * g));
  assert.equal(stoneState(land2 + (2 * v2) / g + 1e-6, o), null, 'at rest after the second bounce');
  assert.equal(stoneState(hailCycle(o), o), null);
});

test('property: a stone is never below the ground or above its start or first bounce, and its height is continuous in time', () => {
  const rnd = random(8);
  for (let n = 0; n < 200; n++) {
    const o = {
      height: 2 + rnd() * 100,
      fallSpeed: 5 + rnd() * 50,
      restitution: rnd() * 0.9,
      groundY: rnd() * 40 - 20,
    };
    const cycle = hailCycle(o),
      dt = cycle / 2000,
      top = Math.max(o.height, (o.restitution * o.fallSpeed) ** 2 / (2 * 9.81)); // a fast bounce can rise above the start (the fall speed is constant)
    let previous = stoneState(0, o);
    for (let i = 1; i <= 2000; i++) {
      const now = stoneState(i * dt, o);
      if (!now) break;
      assert.ok(now.y >= o.groundY - 1e-9 && now.y <= o.groundY + top + 1e-9);
      if (previous) assert.ok(Math.abs(now.y - previous.y) <= o.fallSpeed * dt + 1e-6, 'no jump');
      previous = now;
    }
  }
});

test('lit and splashes options are checked', () => {
  validateHail({ lit: false, splashes: 0 });
  validateHail({ splashes: 8 });
  assert.throws(() => validateHail({ splashes: 9 }), RangeError);
  assert.throws(() => validateHail({ splashes: 1.5 }), /whole number/);
  assert.throws(() => validateHail({ lit: 1 }), TypeError);
  assert.ok(SPLASH_SECONDS > 0 && SPLASH_SECONDS < 1);
});
