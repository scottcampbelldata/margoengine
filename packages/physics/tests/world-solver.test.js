// The solver contract of the physics framework: dyadic rate levels, and a solver written to the interface stepping through a host.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BASE_RATE, RATE_LEVELS, isRateLevel, rateOf, substepsBetween } from '../dist/world.js';

test('rate levels are 60 times a power of two, 0 to 7, and nothing else', () => {
  assert.equal(BASE_RATE, 60);
  assert.equal(RATE_LEVELS, 8);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7].map((level) => rateOf(level)),
    [60, 120, 240, 480, 960, 1920, 3840, 7680],
  );
  for (const bad of [-1, 8, 1.5, Number.NaN, '2', null]) {
    assert.equal(isRateLevel(bad), false, `${bad} is not a rate level`);
    assert.throws(() => rateOf(bad), RangeError);
  }
});

test('two coupled levels meet on every tick of the slower: the faster takes a whole power of two of steps', () => {
  for (let slow = 0; slow < 8; slow++)
    for (let fast = slow; fast < 8; fast++) {
      const steps = substepsBetween(fast, slow);
      assert.equal(steps, 2 ** (fast - slow));
      assert.equal(
        steps / rateOf(fast),
        1 / rateOf(slow),
        'the steps of the faster add up to one step of the slower exactly',
      );
    }
  assert.throws(() => substepsBetween(1, 3), /slower/);
  assert.throws(() => substepsBetween(1, 9), RangeError);
});

test('a solver written to the contract steps through a host and its state is the region it names', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let next = 0;
  const host = {
    memory,
    gravity: [0, -9.81, 0],
    allocate: (name, byteLength, type, layout) => {
      const region = { name, byteOffset: next, byteLength, type, layout };
      next += byteLength;
      return region;
    },
    port: () => undefined,
  };
  const fall = {
    init(h, params) {
      this.region = h.allocate('ball', 16, 'f64', 1);
      new Float64Array(memory.buffer, this.region.byteOffset, 2)[0] = params.height;
    },
    step(_context, dt) {
      const w = new Float64Array(memory.buffer, this.region.byteOffset, 2);
      w[1] += host.gravity[1] * dt;
      w[0] += w[1] * dt;
    },
    stateRegions() {
      return [this.region];
    },
  };
  fall.init(host, { height: 10 });
  const level = 2;
  for (let tick = 0; tick < rateOf(level); tick++)
    fall.step({ tick, level, seed: 1, inputs: new Map() }, 1 / rateOf(level));
  const [region] = fall.stateRegions();
  const [height, speed] = new Float64Array(memory.buffer, region.byteOffset, 2);
  // Semi-implicit Euler over n = 240 steps of h: v = -g n h, x = x0 - g h^2 n (n + 1) / 2.
  const h = 1 / 240;
  assert.ok(Math.abs(speed + 9.81) < 1e-12, `${speed}`);
  assert.ok(Math.abs(height - (10 - (9.81 * h * h * 240 * 241) / 2)) < 1e-12, `${height}`);
});
