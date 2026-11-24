// GAP-FILM-TIME (KB-FILM-SCANGAP1): a Stylize started at film time T draws its shock wave as a continuous run does at T.
// Its clock moved in onPreUpdate as `this.elapsed = Math.min(1e7, this.elapsed + delta)`, a form the film-time check
// missed, and it had no `advanceTime`, so `@margoengine/cutscene/seek` could not replay it and the wave restarted at
// every cut of a film rendered scene by scene. Run A takes n + 1 live frames (update and draw); run B is fresh,
// replays n steps with `advanceTime` (what `seek` runs), then takes one live frame. The clock must be equal to the bit
// and the uniform the next draw uploads equal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Stylize } from '@margoengine/post/stylize';
import { harness, written } from './support.js';

const FPS = 60;
function world() {
  const h = harness(),
    effect = Stylize.attach(h.engine, { scanlines: 0, noise: 0, shockWave: { speed: 0.05 } });
  effect.explode(0);
  // A live frame: the engine's update with the frame's delta, then the draw.
  const frame = () => {
    effect.onPreUpdate(1 / FPS);
    return written(h.gpu.record(() => h.frame()), 64);
  };
  return { h, effect, frame };
}

for (const n of [1, 600, 54000])
  test(`stylize replayed ${n} steps equals a continuous run`, () => {
    const a = world(),
      b = world();
    assert.equal(b.effect.time, 0, 'a fresh Stylize starts at 0');
    let last;
    for (let step = 0; step <= n; step++) last = a.frame();
    for (let step = 0; step < n; step++) b.effect.advanceTime(1 / FPS);
    const seeked = b.frame();
    assert.ok(Object.is(b.effect.time, a.effect.time), `${b.effect.time} against ${a.effect.time}`);
    assert.deepEqual([...seeked], [...last]);
  });

test('a fresh Stylize drawn at T without the replay restarts its wave (the restart a film cut showed)', () => {
  const a = world(),
    c = world();
  let last;
  for (let step = 0; step <= 600; step++) last = a.frame();
  assert.notDeepEqual([...c.frame()], [...last]);
});

test('only the frame update moves the clock: a draw or a delta of 0 or less does not', () => {
  const w = world();
  w.frame();
  assert.equal(w.effect.time, 1 / FPS);
  w.h.gpu.record(() => w.h.frame());
  assert.equal(w.effect.time, 1 / FPS, 'a draw moves no time');
  w.effect.advanceTime(0);
  w.effect.advanceTime(-1);
  assert.equal(w.effect.time, 1 / FPS, 'a delta of 0 or less moves no time');
  w.effect.dispose();
  w.effect.advanceTime(1);
  assert.equal(w.effect.time, 1 / FPS, 'a disposed Stylize keeps its time');
});
