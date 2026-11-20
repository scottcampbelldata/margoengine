// GAP-FILM-TIME: a Tonemap started at film time T shows the grain and dither a continuous run shows at T. Run A takes
// n + 1 live frames (update and draw); run B is fresh, replays n steps with `advanceTime` (what `seek` from
// @margoengine/cutscene/seek runs), then takes one live frame. The effects uniform (grain frame at 20) must be equal.
// Auto exposure is view history (class C): a cut snaps it on its first metered frame, bounded in seek-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Tonemap } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

const FPS = 60;
function world() {
  const h = gpuHarness(),
    tonemap = Tonemap.attach(h.engine, { grain: 0.25, dither: true, vignette: 0.4 }),
    seen = [],
    write = h.engine.gpu.queue.writeBuffer;
  h.context.delta = 1 / FPS;
  h.engine.gpu.queue.writeBuffer = (buffer, offset, values) => {
    if (buffer.size === 128 && values.length === 32) seen.push(Float32Array.from(values));
    return write(buffer, offset, values);
  };
  return { h, tonemap, last: () => seen.at(-1) };
}

for (const n of [1, 600, 54000])
  test(`tonemap replayed ${n} steps equals a continuous run`, () => {
    const a = world(),
      b = world();
    assert.equal(b.tonemap.time, 0, 'a fresh Tonemap starts at 0');
    for (let step = 0; step <= n; step++) a.h.frame();
    for (let step = 0; step < n; step++) b.tonemap.advanceTime(1 / FPS);
    b.h.frame();
    assert.ok(Object.is(b.tonemap.time, a.tonemap.time));
    assert.deepEqual(b.last(), a.last());
    assert.equal(a.last()[20], n & 0xffffff);
  });

test('a fresh Tonemap drawn at T without the replay restarts its grain (the restart a film cut showed)', () => {
  const a = world(),
    c = world();
  for (let step = 0; step <= 600; step++) a.h.frame();
  c.h.frame();
  assert.notDeepEqual(c.last(), a.last());
});

test('the grain moves once per frame update, so every view of a frame shows the same grain', () => {
  const w = world();
  w.h.frame();
  const first = w.last()[20];
  // A second view drawn in the same frame: the passes run again with no update.
  w.tonemap.onPreUpdate = () => {};
  w.h.frame();
  delete w.tonemap.onPreUpdate;
  assert.equal(w.last()[20], first, 'a second view drawn in the same frame');
  // KB-FILM-TAAPHASE1: a delta of 0 is a capture's render inside the frame (Reflector, Refractor, CubeCamera), not a
  // frame: the frame that follows moves the grain once.
  w.tonemap.onPreUpdate(0);
  assert.equal(w.tonemap.time, 1 / FPS, 'a delta of 0 moves no time');
  w.h.frame();
  assert.equal(w.last()[20], first + 1, 'a capture before the frame does not move the grain again');
  // A frame drawn after zero-delta updates only (a redraw of the same instant) still moves it once.
  w.tonemap.onPreUpdate(0);
  w.tonemap.onPreUpdate = () => {};
  w.h.frame();
  w.h.frame();
  delete w.tonemap.onPreUpdate;
  assert.equal(w.last()[20], first + 2, 'one step for the redraw, none for a second view of it');
  w.tonemap.dispose();
  w.tonemap.advanceTime(1);
  assert.equal(w.tonemap.time, 2 / FPS, 'a disposed Tonemap does not move');
});
