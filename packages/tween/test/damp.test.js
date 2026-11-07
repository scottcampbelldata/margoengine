import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { GCProfiler, setFlagsFromString } from 'node:v8';
import { v8Tiers } from '../../../scripts/support/v8-tiers.mjs';
import { Spring, smoothDamp } from '../dist/index.js';

const near = (a, b, eps, message = '') => assert.ok(Math.abs(a - b) <= eps, `${message} ${a} vs ${b}`);
const speed = (v) => Math.hypot(...v);

test('every axis matches a critically damped Spring, for hitches and ordinary frames alike', () => {
  const smoothTime = 0.4,
    rate = 2 / smoothTime,
    current = Float64Array.from([3, -2, 0.5]),
    velocity = Float64Array.from([1, 0, -4]),
    target = [-1, 5, 0.5],
    springs = Array.from(
      current,
      (value, i) =>
        new Spring({
          value,
          target: target[i],
          velocity: velocity[i],
          stiffness: rate * rate,
          damping: 2 * rate,
          precision: 0,
        }),
    );
  for (const dt of [1 / 60, 1 / 144, 0.25, 1 / 60, 3, 1 / 30]) {
    smoothDamp(current, target, velocity, smoothTime, Infinity, dt, current);
    springs.forEach((spring, i) => {
      spring.update(dt);
      near(current[i], spring.value, 1e-9, `position ${i} dt ${dt}`);
      near(velocity[i], spring.velocity, 1e-9, `velocity ${i} dt ${dt}`);
    });
  }
});

test('a still point converges on a fixed target without oscillating', () => {
  const position = new Float32Array([10, -10]),
    velocity = new Float32Array(2);
  let last = Infinity;
  for (let i = 0; i < 600; i++) {
    smoothDamp(position, [0, 0], velocity, 0.3, Infinity, 1 / 60, position);
    const distance = speed(position);
    assert.ok(distance <= last + 1e-6, 'never moves away from the target');
    last = distance;
  }
  assert.ok(last < 1e-3, `settled, ${last}`);
});

test('speed never exceeds maxSpeed, in position steps and in velocity, even from a fast start', () => {
  const maxSpeed = 2,
    position = new Float64Array([0, 0, 0]),
    velocity = new Float64Array([30, -40, 0]),
    target = [100, 50, -20];
  const first = smoothDamp(position, target, velocity, 0.5, maxSpeed, 1 / 60, new Float64Array(3));
  assert.ok(speed(velocity) <= maxSpeed + 1e-9, `velocity after first step ${speed(velocity)}`);
  assert.ok(speed(first) / (1 / 60) <= maxSpeed * 1.0001, 'the first step respects the limit');
  position.set([0, 0, 0]);
  velocity.fill(0);
  for (let i = 0; i < 6000; i++) {
    const before = Float64Array.from(position);
    smoothDamp(position, target, velocity, 0.5, maxSpeed, 1 / 60, position);
    assert.ok(speed(velocity) <= maxSpeed + 1e-9, `step ${i} velocity ${speed(velocity)}`);
    const step = Math.hypot(...position.map((v, k) => v - before[k])) * 60;
    assert.ok(step <= maxSpeed + 1e-9, `step ${i} moved at ${step}`);
  }
  assert.ok(speed(position.map((v, i) => v - target[i])) < 1e-3, 'still arrives');
});

test('a limit keeps the direction of travel (the vector is limited, not each axis)', () => {
  const position = new Float64Array([0, 0]),
    velocity = new Float64Array(2);
  for (let i = 0; i < 30; i++) smoothDamp(position, [30, 40], velocity, 1, 5, 1 / 60, position);
  near(position[1] / position[0], 40 / 30, 1e-9);
});

test('dt 0 copies current and leaves velocity alone', () => {
  const velocity = new Float64Array([5, 6]),
    out = new Float64Array(2);
  assert.equal(smoothDamp([1, 2], [9, 9], velocity, 0.3, 1, 0, out), out);
  assert.deepEqual([...out], [1, 2]);
  assert.deepEqual([...velocity], [5, 6]);
});

test('a huge dt arrives at rest, with no NaN from the underflowing decay', () => {
  for (const dt of [1e3, 1e6, 1e300, 1.7e308]) {
    const out = new Float64Array(3),
      velocity = new Float64Array([1e9, -1e9, 3]);
    smoothDamp([1e6, -5, 2], [4, 5, 6], velocity, 0.2, Infinity, dt, out);
    assert.deepEqual([...out], [4, 5, 6], `dt ${dt}`);
    assert.deepEqual([...velocity], [0, 0, 0], `dt ${dt}`);
  }
  // With a limit, a long step still cannot move farther than the speed limit allows over smoothTime-scale reach.
  const out = new Float64Array(1),
    velocity = new Float64Array(1);
  smoothDamp([0], [1000], velocity, 1, 3, 1e6, out);
  assert.equal(out[0], 3, 'stops at the capped virtual target');
  assert.equal(velocity[0], 0);
});

test('zero smoothTime lands on the target and zeroes velocity; a negative or NaN one is rejected', () => {
  const out = new Float64Array(2),
    velocity = new Float64Array([4, 4]);
  smoothDamp([0, 0], [7, 8], velocity, 0, 1, 1 / 60, out);
  assert.deepEqual([...out], [7, 8]);
  assert.deepEqual([...velocity], [0, 0]);
  for (const bad of [-0.1, NaN, Infinity])
    assert.throws(() => smoothDamp([0], [1], [0], bad, 1, 0.1, [0]), RangeError, `smoothTime ${bad}`);
});

test('maxSpeed 0 holds still; negative and NaN maxSpeed are rejected', () => {
  const out = new Float64Array(2),
    velocity = new Float64Array([1, 1]);
  smoothDamp([3, 4], [9, 9], velocity, 0.3, 0, 0.1, out);
  assert.deepEqual([...out], [3, 4]);
  assert.deepEqual([...velocity], [0, 0]);
  for (const bad of [-1, NaN]) assert.throws(() => smoothDamp([0], [1], [0], 1, bad, 0.1, [0]), RangeError);
});

test('NaN, infinite and negative inputs throw RangeError and change nothing', () => {
  const velocity = new Float64Array([1, 2]),
    out = new Float64Array([8, 8]);
  for (const dt of [-0.01, NaN, Infinity]) assert.throws(() => smoothDamp([0, 0], [1, 1], velocity, 1, 1, dt, out));
  assert.throws(() => smoothDamp([NaN, 0], [1, 1], velocity, 1, 1, 0.1, out), RangeError);
  assert.throws(() => smoothDamp([0, 0], [1, Infinity], velocity, 1, 1, 0.1, out), RangeError);
  assert.throws(() => smoothDamp([0, 0], [1, 1], new Float64Array([1, NaN]), 1, 1, 0.1, out), RangeError);
  assert.throws(() => smoothDamp([0, 0], [1], velocity, 1, 1, 0.1, out), RangeError, 'target length');
  assert.throws(() => smoothDamp([0, 0], [1, 1], [0], 1, 1, 0.1, out), RangeError, 'velocity length');
  assert.throws(() => smoothDamp([0, 0], [1, 1], velocity, 1, 1, 0.1, new Float64Array(3)), RangeError, 'out length');
  assert.throws(() => smoothDamp([0, 0], [1, 1], velocity, 1, 1, 0.1, velocity), RangeError, 'out is velocity');
  assert.throws(() => smoothDamp([], [], [], 1, 1, 0.1, []), RangeError, 'empty');
  assert.deepEqual([...velocity], [1, 2]);
  assert.deepEqual([...out], [8, 8]);
});

test('huge finite coordinates do not overflow the speed limit', () => {
  const position = new Float64Array([-1e200, 1e200]),
    velocity = new Float64Array(2);
  smoothDamp(position, [1e200, -1e200], velocity, 1, 10, 1 / 60, position);
  assert.ok(position.every(Number.isFinite));
  near(position[0], -1e200, 1, 'moved at most the speed limit');
});

// V8 compiles Turbofan's code on a background thread, so on a loaded machine (a full verify run) it can arrive after 100,000 calls; until then smoothDamp runs in Maglev, which on V8 13
// calls Math.sqrt with boxed numbers. Runs `run(1000)` until Turbofan's code is in, for at most 30 s, so the windows
// below measure the frame loop's steady state whatever the machine's load.
function untilOptimized(run) {
  const { isTurbofan, status } = v8Tiers();
  for (const deadline = performance.now() + 30_000; !isTurbofan(smoothDamp) && performance.now() < deadline; ) run(1000);
  assert.ok(isTurbofan(smoothDamp), `smoothDamp never reached Turbofan (status ${status(smoothDamp)})`);
}

// Each window starts from an empty young generation, so a call that allocates even 16 bytes grows the heap by 320 KB
// over 20,000 calls (or collects). A window passes with no collection and under 64 KB grown; one of five must.
function allocatesNothing(run) {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc'),
    windows = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    gc();
    const profiler = new GCProfiler(),
      before = process.memoryUsage().heapUsed;
    profiler.start();
    run(20000);
    const { statistics } = profiler.stop(),
      grown = process.memoryUsage().heapUsed - before;
    windows.push({ collections: statistics.length, grown });
    if (statistics.length === 0 && grown < 64 * 1024) return;
  }
  assert.fail(`every window of 20,000 calls allocated: ${JSON.stringify(windows)}`);
}

test('plain arrays and Float32Array work, and the call allocates nothing per frame', () => {
  const position = [0, 0, 0],
    velocity = [0, 0, 0];
  smoothDamp(position, [1, 2, 3], velocity, 0.3, 4, 1 / 60, position);
  assert.ok(position[0] > 0);
  const p = new Float32Array(3),
    v = new Float32Array(3),
    t = new Float32Array([1, 2, 3]),
    dt = 1 / 60;
  const run = (count) => {
    for (let i = 0; i < count; i++) smoothDamp(p, t, v, 0.3, 4, dt, p);
  };
  run(20000);
  untilOptimized(run);
  allocatesNothing(run);
});

// Regression: once one store site of smoothDamp had seen a plain [0, 0, 0] (small integers, turned into doubles by the
// first fractional store) beside typed arrays, Turbofan compiled it as a generic store that boxed every number it
// wrote: about 96 B per call for three components. Every kind of out, velocity and target, mixed in one loop.
test('any mix of plain arrays and typed arrays allocates nothing per call', () => {
  const kinds = [() => [0, 0, 0], () => [0.5, 0.5, 0.5], () => new Float32Array(3), () => new Float64Array(3)],
    positions = [],
    velocities = [],
    targets = kinds.map((make) => {
      const target = make();
      target[0] = 1;
      target[1] = 2;
      target[2] = 3;
      return target;
    }),
    dt = 1 / 60;
  for (const position of kinds)
    for (const velocity of kinds) {
      positions.push(position());
      velocities.push(velocity());
    }
  const run = (count) => {
    for (let i = 0; i < count; i++) {
      const pair = i & 15;
      smoothDamp(positions[pair], targets[(i >> 4) & 3], velocities[pair], 0.3, 4, dt, positions[pair]);
    }
  };
  run(20000);
  untilOptimized(run);
  allocatesNothing(run);
  for (const position of positions)
    assert.ok(
      position.every((x, i) => Math.abs(x - (i + 1)) < 0.5),
      `${[...position]}`,
    );
});
