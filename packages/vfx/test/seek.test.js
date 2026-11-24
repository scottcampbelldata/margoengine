// GAP-FILM-TIME: a VFX started at film time T births what a continuous run births at T. Run A takes n + 1 live frames
// (update and simulate pass); run B is fresh, replays n steps with `advanceTime` (what `seek` from
// @margoengine/cutscene/seek runs), then takes one live frame. The clock, the birth remainder, the step number that
// seeds births, the schedule's burst cursor and the uniform block the simulate pass uploads must be equal, so births per
// step are equal exactly. The particles alive at T come from the scene's prewarm (class B): bound in seek-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/base.js';
import { schedule } from '../dist/schedule.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const FPS = 60;
// A fractional rate keeps a remainder; bursts repeat every 0.5 s with seeded skips; a prewarm runs on the first step.
const options = () => ({
  capacity: 2000,
  initialCount: 40,
  rate: 37.3,
  lifetime: [1, 2],
  schedule: { prewarm: 0.25, seed: 9, bursts: [{ time: 0.1, count: 25, cycles: 4000, interval: 0.5, probability: 0.7 }] },
});
function world() {
  const h = optionalGPU(),
    vfx = new VFX(options(), { schedule });
  h.context.delta = 1 / FPS;
  h.engine.stats = { drawCalls: 0 };
  // The prewarm submits its steps on encoders of their own, recorded like the frame's.
  h.engine.gpu.createCommandEncoder = () => ({ ...h.context.encoder, finish: () => ({}) });
  h.engine.use(vfx);
  return { h, vfx };
}
// The uniform block of the last simulate pass: time at 31, delta at 27, births budget at int 53, step number at int 54.
const uploaded = (w) => Array.from(w.vfx['values']);
const births = (w) => w.vfx['ints'][53];

for (const n of [1, 600, 54000])
  test(`vfx replayed ${n} steps equals a continuous run, births per step included`, () => {
    const a = world(),
      b = world();
    assert.equal(b.vfx.time, 0, 'a fresh effect starts at 0');
    const perStep = [];
    for (let step = 0; step <= n; step++) {
      a.h.frame();
      if (step >= n - 2) perStep.push(births(a));
    }
    for (let step = 0; step < n; step++) b.vfx.advanceTime(1 / FPS);
    b.h.frame();
    assert.ok(Object.is(b.vfx.time, a.vfx.time));
    assert.equal(b.vfx['remainder'], a.vfx['remainder']);
    assert.equal(b.vfx['frames'], a.vfx['frames']);
    assert.deepEqual(uploaded(b), uploaded(a));
    assert.equal(births(b), perStep.at(-1), 'the step after the seek births what the continuous run births');
    assert.equal(uploaded(a)[31], Math.fround(a.vfx.time));
  });

// KB-FILM-TAAPHASE1: a Reflector, Refractor or CubeCamera renders the scene with a delta of 0 before each frame, and
// every render calls onPreUpdate. That update counted a step: it moved the step number that seeds births (so a film cut
// with a mirror in view seeded other particles than its seek) and dropped the prewarm queued on the first update.
test('a zero-delta update before each frame (a capture) changes no counter, seed or prewarm', () => {
  const plain = world(),
    captured = world();
  for (let frame = 0; frame < 40; frame++) {
    plain.h.frame();
    captured.vfx.onPreUpdate(0);
    captured.h.frame();
    assert.equal(captured.vfx['frames'], plain.vfx['frames'], `frame ${frame}: step number`);
    assert.deepEqual(uploaded(captured), uploaded(plain), `frame ${frame}: simulate uniforms`);
  }
  assert.ok(Object.is(captured.vfx.time, plain.vfx.time));
  assert.equal(captured.vfx['remainder'], plain.vfx['remainder']);
});

test('a fresh effect drawn at T without the replay restarts its clock and step seeds (the restart a film cut showed)', () => {
  const a = world(),
    c = world();
  for (let step = 0; step <= 600; step++) a.h.frame();
  c.h.frame();
  assert.notDeepEqual(uploaded(c), uploaded(a));
});

test('the clock moves once per frame update: the pass simulates the counted step once, however many views draw', () => {
  const { h, vfx } = world();
  h.frame();
  const first = uploaded({ vfx }),
    steps = vfx['frames'],
    start = vfx.time;
  assert.equal(start, 0.25 + 1 / FPS, 'the prewarm steps count on the clock, as they did in the pass');
  // A second view drawn in the same frame: no update, so a step of 0 s that births nothing and keeps the step number,
  // while the particles are still listed, culled and sorted for this view's camera.
  const passes = h.counts.compute;
  h.engine.frameGraph.execute(h.context);
  assert.ok(h.counts.compute > passes, 'the second view lists its particles');
  const second = uploaded({ vfx });
  assert.equal(second[27], 0, 'the second view steps 0 s');
  assert.equal(vfx['ints'][53], 0, 'and births nothing');
  assert.equal(vfx['frames'], steps, 'and takes no step number');
  assert.equal(second[31], first[31]);
  assert.equal(vfx.time, start);
  assert.equal(h.context.delta, 1 / FPS, 'the frame delta is left as it was');
  // Updates with no draw (a hidden view) move the clock; their births are dropped with their particles.
  vfx.onPreUpdate(1 / FPS);
  vfx.onPreUpdate(1 / FPS);
  assert.equal(vfx.time, start + 1 / FPS + 1 / FPS);
  h.frame();
  const prewarm = vfx['ints'][54] - 3;
  assert.equal(prewarm, 15, 'step numbers: 15 prewarm steps, then the frames');
  assert.equal(vfx['ints'][54], prewarm + 3, 'the drawn step carries its own step number');
  vfx.reset();
  assert.equal(vfx.time, 0, 'reset puts the clock back to 0, so a seek can start again');
  vfx.dispose();
  vfx.advanceTime(1);
  assert.equal(vfx.time, 0, 'a disposed effect does not move');
});

test('an effect no frame update reaches steps in its simulate pass by the frame delta, as before', () => {
  // The atlas, curve and emitter browser checks run the passes alone; with the counters in advanceTime the pass took no
  // step there, so nothing was listed and no particle drew (vfx/test/browser-check.mjs, 0 of 64 visible).
  const { h, vfx } = world();
  const passes = h.counts.compute;
  h.engine.frameGraph.execute(h.context);
  assert.ok(h.counts.compute > passes, 'the pass simulates and lists');
  let clock = 0;
  for (let i = 0; i < 15; i++) clock += 1 / 60;
  assert.equal(vfx.time, clock + 1 / FPS, 'the prewarm (15 steps of 1/60 s) and the frame delta');
  assert.equal(vfx['values'][27], Math.fround(1 / FPS));
  h.engine.frameGraph.execute(h.context);
  assert.equal(vfx.time, clock + 1 / FPS + 1 / FPS, 'every pass steps');
  const burst = new VFX({ capacity: 64, initialCount: 64, rate: 0 });
  const g = optionalGPU();
  g.engine.stats = { drawCalls: 0 };
  g.engine.use(burst);
  g.engine.frameGraph.execute(g.context);
  assert.equal(burst['ints'][53], 64, 'initialCount is born by the first pass');
  assert.equal(burst['ints'][54], 0, 'with its own step number');
  g.engine.frameGraph.execute(g.context);
  assert.equal(burst['ints'][53], 0);
  assert.equal(burst['ints'][54], 1, 'the next step number is fresh, so later births get new seeds');
});

// GAP-FILM-TIME for Flame and Smoke: both added frame deltas to a clock with no `advanceTime`, so a seek could not move
// them and a flame or smoke column seeked to T drew the puffing, flicker, dither and wind of second 0. Run A takes n + 1
// live frames; run B replays n steps with `advanceTime` (what `seek` runs over the scene's plugins, in their order) and
// takes one live frame: the flame's uniform block and lights, and the column's curves, wind and puffs' counters equal.
// The two worlds share one process, as two scenes rendered one after the other do: a flame's noise seed followed the
// count of every flame the process had made, so the second world's flame flickered with another seed.
import { Flame } from '../dist/flame.js';
import { Smoke } from '../dist/smoke.js';

// A wind that turns and gusts over film time, so the clock's value shows in what is drawn.
const gusts = { sample: (x, y, z, t) => [3 + 2 * Math.sin(0.7 * t), 0, 1.5 * Math.cos(0.31 * t)] };
function fireWorld(make) {
  const h = optionalGPU();
  h.context.delta = 1 / FPS;
  h.engine.stats = { drawCalls: 0 };
  h.engine.lighting = {
    direction: new Float32Array([0, 3, 4, 2]),
    radiance: new Float32Array([1, 0.5, 0.25, 0.2]),
    ambient: new Float32Array([1, 2, 3]),
  };
  h.engine.gpu.createCommandEncoder = () => ({ ...h.context.encoder, finish: () => ({}) });
  return { h, it: make(h.engine) };
}
const replay = (w, n) => {
  for (let step = 0; step < n; step++)
    for (const plugin of w.h.engine.plugins.values()) if (typeof plugin.advanceTime === 'function') plugin.advanceTime(1 / FPS);
};

for (const n of [1, 600, 54000])
  test(`a Flame replayed ${n} steps draws what a continuous run draws (uniforms and lights)`, () => {
    const make = (engine) => Flame.attach(engine, { position: [1, 0, 2], length: 4, footprint: [6, 3], wind: gusts });
    const a = fireWorld(make),
      b = fireWorld(make);
    assert.equal(b.it.time, 0);
    for (let step = 0; step <= n; step++) a.h.frame();
    replay(b, n);
    b.h.frame();
    assert.ok(Object.is(b.it.time, a.it.time), `clock ${b.it.time} against ${a.it.time}`);
    assert.deepEqual(Array.from(b.it['values']), Array.from(a.it['values']));
    assert.deepEqual(Array.from(b.it['steady']), Array.from(a.it['steady']));
  });

for (const n of [1, 600, 54000])
  test(`a Smoke column replayed ${n} steps draws what a continuous run draws (curves, wind, puff counters)`, () => {
    const make = (engine) => Smoke.attach(engine, { position: [0, 0, 0], heat: 5e6, prewarm: false, rate: 13.7, wind: gusts });
    const a = fireWorld(make),
      b = fireWorld(make);
    assert.equal(b.it.time, 0);
    for (let step = 0; step <= n; step++) a.h.frame();
    replay(b, n);
    b.h.frame();
    assert.ok(Object.is(b.it.time, a.it.time));
    assert.deepEqual(Array.from(b.it['speed']), Array.from(a.it['speed']));
    assert.deepEqual(Array.from(b.it['size']), Array.from(a.it['size']));
    assert.deepEqual(Array.from(b.it['still']), Array.from(a.it['still']));
    const fx = (w) => w.it['effect'];
    assert.ok(Object.is(fx(b).time, fx(a).time));
    assert.equal(fx(b)['remainder'], fx(a)['remainder']);
    assert.deepEqual(Array.from(fx(b)['values']), Array.from(fx(a)['values']));
  });

test('Flame and Smoke are clocks a seek moves; a fresh one drawn at T without it restarts (the cut a film showed)', () => {
  const a = fireWorld((engine) => Flame.attach(engine, { position: [0, 0, 0], length: 3, wind: gusts })),
    c = fireWorld((engine) => Flame.attach(engine, { position: [0, 0, 0], length: 3, wind: gusts }));
  for (let step = 0; step <= 600; step++) a.h.frame();
  c.h.frame();
  assert.notDeepEqual(Array.from(c.it['values']), Array.from(a.it['values']));
  const s = fireWorld((engine) => Smoke.attach(engine, { position: [0, 0, 0], heat: 1e6, prewarm: false }));
  s.it.advanceTime(0.5);
  assert.equal(s.it.time, 0.5);
  s.it.dispose();
  s.it.advanceTime(1);
  assert.equal(s.it.time, 0.5, 'a disposed column keeps its clock');
});
