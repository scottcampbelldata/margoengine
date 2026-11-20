// GAP-FILM-TIME: water started at film time T moves as a continuous run moves at T, bit for bit. Run A takes n + 1 live
// frames (update and draw); run B is fresh, replays n steps with `advanceTime` (what `seek` from
// @margoengine/cutscene/seek runs), then takes one live frame. The Gerstner, FFT, flow and rain-ring clocks and the
// wave uniform the surface draw uploads must be equal. Water's clock moved from its draw pass to its update on
// 2026-11-16: hidden water keeps time and two views in one frame move it once. Pictures: seek-check.mjs on a GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';
import { FFTOcean } from '../dist/fft.js';
import { WaterFlow } from '../dist/flow.js';
import { WaterRain } from '../dist/rain.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const FPS = 60;
function world() {
  const h = optionalGPU(),
    water = new Water({ segments: 4 });
  h.context.delta = 1 / FPS;
  h.engine.use(water);
  // Clocks without a GPU: the FFT ocean, flow and rain rings (their draws read only their clocks).
  const ocean = new FFTOcean({ segments: 1 }),
    flow = new WaterFlow({ surface: water, direction: [1, 0.5] }),
    rain = new WaterRain({ surface: water });
  return { h, water, plugins: [water, ocean, flow, rain] };
}
const live = (w) => {
  w.h.frame();
  for (const p of w.plugins.slice(1)) p.onPreUpdate(1 / FPS);
};
const replay = (w, steps) => {
  for (let step = 0; step < steps; step++) for (const p of w.plugins) p.advanceTime(1 / FPS);
};
// The wave uniform of the last draw: time at 20, the camera, the waves.
const uploaded = (w) => Array.from(w.water['values']);

for (const n of [1, 600, 54000])
  test(`water replayed ${n} steps equals a continuous run`, () => {
    const a = world(),
      b = world();
    for (const p of b.plugins) assert.equal(p.time, 0, `${p.constructor.name} starts at 0`);
    for (let step = 0; step <= n; step++) live(a);
    replay(b, n);
    live(b);
    b.plugins.forEach((p, i) => assert.ok(Object.is(p.time, a.plugins[i].time), p.constructor.name));
    assert.deepEqual(uploaded(b), uploaded(a));
    assert.equal(uploaded(a)[20], Math.fround(a.water.time));
  });

test('a fresh water drawn at T without the replay starts its waves at 0 (the restart a film cut showed)', () => {
  const a = world(),
    c = world();
  for (let step = 0; step <= 600; step++) live(a);
  live(c);
  assert.notDeepEqual(uploaded(c), uploaded(a));
});

test('the wave clock moves once per frame update: hidden water keeps time, two views move it once', () => {
  const h = optionalGPU(),
    water = new Water({ segments: 4 });
  h.engine.use(water);
  water.onPreUpdate(0.25);
  water.onPreUpdate(0.25);
  assert.equal(water.time, 0.5, 'updates with no draw (hidden water) move the clock');
  h.context.delta = 0.1;
  h.frame();
  // A second view drawn in the same frame: the pass runs again with no update.
  h.engine.frameGraph.execute(h.context);
  assert.equal(water.time, 0.6);
  assert.equal(water['values'][20], Math.fround(0.6), 'the second view draws the same wave time');
  water.onPreUpdate(0);
  water.advanceTime(-1);
  assert.equal(water.time, 0.6, 'a delta of 0 or less moves nothing');
  water.dispose();
});

test('Water.setTime sets the wave clock outright and the next draw uploads it; bad values throw', () => {
  const w = world();
  w.water.setTime(1.25);
  assert.equal(w.water.time, 1.25);
  w.h.context.delta = 0;
  w.h.frame();
  assert.equal(uploaded(w)[20], Math.fround(1.25));
  assert.equal(w.water.setTime(0.5).time, 0.5, 'backwards too, and it chains');
  for (const bad of [-1, Number.NaN, Infinity, 2e9]) assert.throws(() => w.water.setTime(bad), RangeError);
  assert.equal(w.water.time, 0.5);
});
