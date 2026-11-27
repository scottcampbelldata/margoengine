// The wind field's turbulence is carried by the mean wind, not by the gusting direction times the whole elapsed time
// (KB-LOOK-TV-SHIMMER2). Carried by directionAt(t) x speed x t, half an hour into a 20 m/s gale the pattern swept past a
// point at kilometres a second, so the wind a plant read changed by metres per second from one 30 fps frame to the next
// and every scattered tree and blade of grass in the timber-valley shot shook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherMachine, WindField, windAt } from '../dist/index.js';

const FRAME = 1 / 30;
// The 20 August 1910 gale of the timber-valley scene (`blowup`): 20 m/s mean, gust 0.8, turbulence 0.2 + 0.3 x 0.8.
const GALE = { speed: 20, direction: 0.6, gust: 0.8, turbulence: 0.44, seed: 1 };

/** The largest and the mean change of the wind at a fixed point from one 30 fps frame to the next over `seconds`. */
function frameSteps(field, from, seconds = 10, at = [-1648, 876, 63.5]) {
  let most = 0,
    sum = 0,
    before = field.sample(at[0], at[1], at[2], from);
  const frames = Math.round(seconds / FRAME);
  for (let i = 1; i <= frames; i++) {
    const now = field.sample(at[0], at[1], at[2], from + i * FRAME),
      step = Math.hypot(now[0] - before[0], now[1] - before[1], now[2] - before[2]);
    most = Math.max(most, step);
    sum += step;
    before = now;
  }
  return { most, mean: sum / frames };
}

test('regression KB-LOOK-TV-SHIMMER2: the wind at a point changes as slowly half an hour in as at the start', () => {
  const field = new WindField(GALE),
    start = frameSteps(field, 0),
    later = frameSteps(field, 1800);
  // Same field statistics at any time: the gusts (8 s) and the turbulence blowing past (30 m at 20 m/s, 1.5 s) give a few
  // tenths of a metre per second per frame. Before the fix, half an hour in: up to about 2 m/s a frame.
  assert.ok(later.most < 0.6, `largest frame step at 30 min ${later.most.toFixed(3)} m/s`);
  assert.ok(later.mean < 0.2, `mean frame step at 30 min ${later.mean.toFixed(3)} m/s`);
  assert.ok(
    later.mean < 2 * start.mean + 0.02,
    `30 min ${later.mean.toFixed(3)} against start ${start.mean.toFixed(3)}`,
  );
});

test('the turbulence drifts with the mean wind: drift is speed x t along the mean direction', () => {
  const field = new WindField(GALE),
    [x, z] = field.drift(100);
  assert.ok(Math.abs(x - Math.sin(0.6) * 2000) < 1e-9 && Math.abs(z - Math.cos(0.6) * 2000) < 1e-9);
  // A frozen pattern: moving the point with the drift reads the same turbulence (gust and direction held at 0).
  const frozen = new WindField({ ...GALE, gust: 0 }),
    a = frozen.sample(10, 5, 20, 0),
    [dx, dz] = frozen.drift(0.5),
    b = frozen.sample(10 + dx, 5, 20 + dz, 0.5);
  // Only the slow time axis of the noise (gustPeriod x 2 = 16 s a cell) moves it, a little in half a second.
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.4, 'the pattern travels with the mean wind');
});

test('set(options, at) carries the turbulence on without a jump when the mean wind changes', () => {
  const at = 1800,
    point = [3, 2, -7],
    steady = { ...GALE, gust: 0 },
    across = (v, direction) => -v[0] * Math.cos(direction) + v[2] * Math.sin(direction);
  const field = new WindField(steady),
    before = field.sample(...point, at);
  field.set({ speed: 20.5 }, at);
  const after = field.sample(...point, at);
  // The cross-wind part is the turbulence alone (turbulence x speed x noise / 2); its noise goes on where it was.
  assert.ok(Math.abs(across(after, 0.6) / 20.5 - across(before, 0.6) / 20) < 1e-9, 'no jump in the turbulence');
  // Placed as if the new wind had always blown (no `at`), the same change moves the pattern 900 m: a different wind.
  const placed = new WindField(steady).set({ speed: 20.5 });
  assert.ok(Math.abs(across(placed.sample(...point, at), 0.6) / 20.5 - across(before, 0.6) / 20) > 1e-3);
  // A direction change keeps the pattern too, and later times carry on at the new mean wind.
  field.set({ direction: 0.7 }, at);
  const [x0, z0] = field.drift(at),
    [x1, z1] = field.drift(at + 10);
  assert.ok(Math.abs(x1 - x0 - Math.sin(0.7) * 205) < 1e-6 && Math.abs(z1 - z0 - Math.cos(0.7) * 205) < 1e-6);
  assert.throws(() => field.set({ speed: 5 }, Number.NaN), RangeError);
  assert.equal(field.options.speed, 20.5, 'a bad time keeps the old settings');
});

test('a weather machine blending its wind half an hour in gives a wind that changes smoothly frame to frame', () => {
  const machine = new WeatherMachine({ ...new WeatherMachine('storm').state, wind: 20, gust: 0.8, windDirection: 0.6 });
  machine.update(1800);
  machine.transitionTo({ ...machine.state, wind: 26, windDirection: 0.9 }, { seconds: 20 });
  let before = windAt(machine.wind, 0, 2, 0, machine.time),
    most = 0;
  for (let i = 0; i < 600; i++) {
    machine.update(FRAME);
    const now = windAt(machine.wind, 0, 2, 0, machine.time);
    most = Math.max(most, Math.hypot(now[0] - before[0], now[1] - before[1]));
    before = now;
  }
  assert.ok(most < 0.8, `largest frame step during the blend ${most.toFixed(3)} m/s`);
});

test('resetTime puts the turbulence back where a fresh machine has it', () => {
  const run = () => {
    const machine = new WeatherMachine('clear');
    machine.transitionTo('storm', { seconds: 30 });
    const out = [];
    for (let i = 0; i < 90; i++) {
      machine.update(0.5);
      out.push(windAt(machine.wind, 1, 2, 3, machine.time));
    }
    return { machine, out };
  };
  const { machine, out } = run();
  machine.resetTime();
  const again = [];
  for (let i = 0; i < 90; i++) {
    machine.update(0.5);
    again.push(windAt(machine.wind, 1, 2, 3, machine.time));
  }
  assert.deepEqual(again, out);
  assert.deepEqual(run().out, out);
});
