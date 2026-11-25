// A VFX given a FilmClock steps in fixed ticks of 1/120 s owed by the clock, not one step of the frame delta. The steps
// it simulates (delta, time, births budget, the step number that seeds births, and the whole uniform block each one
// uploads) are a function of the clock's time alone: the same shot at 24, 30 and 60 fps, a 5 fps frame, a seek and a
// seek back all simulate the same steps up to a shared time. The particle buffers themselves are compared on a real
// GPU in film-clock-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX, VFX_TICK_RATE } from '../dist/base.js';
import { schedule } from '../dist/schedule.js';
import { FilmClock } from '../../math/dist/clock.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// A fractional rate keeps a birth remainder, bursts come every 0.35 s with seeded skips, a prewarm runs first and the
// wind is read at each step's time: every counter a step carries is exercised.
const options = (clock) => ({
  capacity: 4000,
  initialCount: 40,
  rate: 637.3,
  lifetime: [1, 2],
  wind: [1.5, -0.5],
  clock,
  schedule: {
    prewarm: 0.25,
    seed: 9,
    bursts: [{ time: 0.1, count: 25, cycles: 4000, interval: 0.35, probability: 0.7 }],
  },
});
function world(fps, clock = new FilmClock({ fps })) {
  const h = optionalGPU(),
    vfx = new VFX(options(clock), { schedule }),
    steps = [];
  h.context.delta = 1 / fps;
  h.engine.stats = { drawCalls: 0 };
  h.engine.gpu.createCommandEncoder = () => ({ ...h.context.encoder, finish: () => ({}) });
  h.engine.use(vfx);
  const simulateStep = vfx['simulateStep'];
  vfx['simulateStep'] = function (c, tick) {
    simulateStep.call(this, c, tick);
    // A 0 s step moves and births nothing new in time (a frame with no tick owed); every other step is recorded with
    // the uniform block it uploaded and the delta the features saw.
    if (tick.delta > 0 || tick.budget > 0)
      steps.push({ tick: { ...tick }, seen: c.delta, uniform: Array.from(this.values) });
  };
  return { h, vfx, clock, steps };
}
/** Draws frames `from` to `to` (inclusive), setting the clock to each first. */
function run(w, from, to) {
  for (let frame = from; frame <= to; frame++) {
    w.clock.frame = frame;
    w.h.frame();
  }
  return w;
}

test('the same effect at 24, 30 and 60 fps simulates the same steps up to every shared time, bit for bit', () => {
  const runs = [24, 30, 60].map((fps) => ({ fps, w: world(fps) }));
  for (const { fps, w } of runs) run(w, 0, 3 * fps);
  const [a, ...rest] = runs;
  assert.equal(a.w.vfx.time, 3, 'three seconds of ticks, exactly');
  assert.equal(a.w.steps.filter((s) => s.tick.delta === 1 / VFX_TICK_RATE).length, 3 * VFX_TICK_RATE);
  for (const { fps, w } of rest) {
    assert.equal(w.steps.length, a.w.steps.length, `${fps} fps step count`);
    for (let i = 0; i < a.w.steps.length; i++) assert.deepEqual(w.steps[i], a.w.steps[i], `${fps} fps, step ${i}`);
    assert.ok(Object.is(w.vfx.time, a.w.vfx.time));
    assert.equal(w.vfx['remainder'], a.w.vfx['remainder']);
    assert.equal(w.vfx['frames'], a.w.vfx['frames']);
  }
  // Every tick's features see the tick's delta, never the frame's.
  for (const s of a.w.steps) assert.equal(s.seen, s.tick.delta);
});

test('a 5 fps frame loses no time: one second is 120 ticks, the steps of a 60 fps run', () => {
  const slow = run(world(5), 0, 5),
    fast = run(world(60), 0, 60);
  assert.equal(slow.vfx.time, 1);
  assert.deepEqual(slow.steps, fast.steps);
});

test('a seek is setting the clock: a fresh effect drawn once at T simulates every step of a continuous run', () => {
  const continuous = run(world(24), 0, 48),
    sought = world(24);
  sought.clock.frame = 48;
  sought.h.frame();
  assert.deepEqual(sought.steps, continuous.steps);
  assert.deepEqual(Array.from(sought.vfx['values']), Array.from(continuous.vfx['values']));
});

test('a seek back restarts the effect and replays the steps up to the earlier time', () => {
  const back = run(world(30), 0, 60),
    fresh = run(world(30), 0, 30);
  back.steps.length = 0;
  back.clock.frame = 30;
  back.h.frame();
  assert.deepEqual(back.steps, fresh.steps);
  assert.equal(back.vfx.time, fresh.vfx.time);
});

test('frames faster than the ticks and repeated draws of one frame take 0 s steps and move nothing', () => {
  const w = world(240);
  run(w, 0, 240);
  const ticks = w.steps.filter((s) => s.tick.delta === 1 / VFX_TICK_RATE).length;
  assert.equal(ticks, VFX_TICK_RATE);
  // Draw the last frame again, and send the frame delta through advanceTime: neither moves the clock.
  w.vfx.advanceTime(0.5);
  w.h.frame();
  assert.equal(w.steps.filter((s) => s.tick.delta === 1 / VFX_TICK_RATE).length, ticks);
  assert.equal(w.vfx.time, 1);
});

test('without a clock, 24 and 60 fps step differently (what the clock removes)', () => {
  const plain = (fps) => {
    const w = world(fps);
    w.vfx.options.clock = undefined;
    for (let frame = 0; frame <= fps; frame++) w.h.frame();
    return w;
  };
  assert.notDeepEqual(plain(24).steps, plain(60).steps);
});

test('a clock that gives no whole ticks is refused', () => {
  const w = world(24, { ticks: () => -1 });
  assert.throws(() => w.h.frame(), RangeError);
  assert.throws(() => new VFX({ clock: {} }).advanceTime(1), TypeError);
});
