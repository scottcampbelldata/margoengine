// GAP-FILM-TIME: plants started at film time T sway as a continuous run sways at T, bit for bit. Run A takes n + 1 live
// frames (update and draw); run B is fresh, replays n steps with `advanceTime` (what `seek` from
// @margoengine/cutscene/seek runs), then takes one live frame. Film code changes the wind at step 300 in both runs.
// The wind clock and the uniform each draw uploads must be equal. Pictures: seek-check.mjs on a real GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PbrMaterial, box } from '@margoengine/core';
import { Scatter, ScatterInstances } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const FPS = 60;
function batch() {
  const vertices = new Float32Array(60);
  vertices[3] = vertices[23] = vertices[43] = 1;
  return {
    name: 'reed',
    vertices,
    indices: new Uint32Array([0, 1, 2]),
    transforms: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    material: new PbrMaterial({ color: [0.3, 0.5, 0.2] }),
  };
}
function world() {
  const h = optionalGPU(),
    scatter = new Scatter(box(), { count: 16, wind: [1, 0, 0.4] }),
    instances = new ScatterInstances(() => [batch()]);
  h.context.delta = 1 / FPS;
  h.engine.lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0]) };
  h.engine.use(scatter);
  h.engine.use(instances);
  return { h, plugins: [scatter, instances], scatter, instances };
}
// Film code: what a film sets from its own step, live or replayed (ctx.seek).
const film = (w, step) => {
  w.scatter.options.wind = step >= 300 ? [0.2, 1, 0.9] : [1, 0, 0.4];
};
const live = (w, step) => {
  film(w, step);
  w.h.frame();
};
const replay = (w, steps) => {
  for (let step = 0; step < steps; step++) {
    film(w, step);
    for (const p of w.plugins) p.advanceTime(1 / FPS);
  }
};
// What the last draw uploaded: Scatter's uniform values and the instances' frame and shadow blocks.
const uploads = (w) => [
  Array.from(w.scatter['values']),
  ...w.h.resources.filter((r) => r.data && r.usage === 72 && (r.size === 144 || r.size === 80)).map((r) => Array.from(new Float32Array(r.data))),
];

for (const n of [1, 600, 54000])
  test(`scatter replayed ${n} steps equals a continuous run`, () => {
    const a = world(),
      b = world();
    for (const p of b.plugins) assert.equal(p.time, 0, `${p.constructor.name} starts at 0`);
    for (let step = 0; step <= n; step++) live(a, step);
    replay(b, n);
    live(b, n);
    b.plugins.forEach((p, i) => assert.ok(Object.is(p.time, a.plugins[i].time), p.constructor.name));
    assert.deepEqual(uploads(b), uploads(a));
    assert.ok(uploads(a).length >= 2, 'the scatter uniform and the instances frame and shadow blocks');
    assert.ok(Math.abs(a.scatter.time - (n + 1) / FPS) < 1e-6);
  });

test('a fresh scatter drawn at T without the replay sways from 0 (the restart a film cut showed)', () => {
  const a = world(),
    c = world();
  for (let step = 0; step <= 600; step++) live(a, step);
  live(c, 600);
  assert.notDeepEqual(uploads(c), uploads(a));
});

test('advanceTime refuses what a frame update refuses', () => {
  for (const delta of [-1, NaN, Infinity]) {
    assert.throws(() => new Scatter(box(), { count: 1 }).advanceTime(delta), /delta/);
    assert.throws(() => new ScatterInstances(() => []).advanceTime(delta), /delta/);
  }
});
