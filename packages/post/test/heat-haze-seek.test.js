// GAP-FILM-TIME: a HeatHaze started at film time T ripples as a continuous run does at T. Its clock (used by plumes
// without their own `time`) moved in its draw, so `@margoengine/cutscene/seek` could not replay it and the haze
// restarted at every cut of a film rendered scene by scene. Run A takes n + 1 live frames (update and draw); run B is
// fresh, replays n steps with `advanceTime` (what `seek` runs), then takes one live frame. The clock must be equal to
// the bit and the plume the next draw uploads equal (the head before it holds the camera, which the harness moves
// each frame).
import test from 'node:test';
import assert from 'node:assert/strict';
import { HeatHaze } from '../dist/heat-haze.js';
import { harness, written } from './support.js';

const FPS = 60,
  // The uniform HeatHaze writes for one plume: 40 head floats and 16 for the plume.
  HEAD = 40,
  BYTES = (HEAD + 16) * 4;
function world() {
  const h = harness(),
    haze = HeatHaze.attach(h.engine, { sources: [{ position: [0, 0, -2], length: 3, footprint: [1, 1] }] });
  // A live frame: the engine's update with the frame's delta, then the draw.
  const frame = () => {
    haze.onPreUpdate(1 / FPS);
    return written(
      h.gpu.record(() => h.frame()),
      BYTES,
    ).slice(HEAD);
  };
  return { h, haze, frame };
}

for (const n of [1, 600, 54000])
  test(`heat haze replayed ${n} steps equals a continuous run`, () => {
    const a = world(),
      b = world();
    assert.equal(b.haze.time, 0, 'a fresh HeatHaze starts at 0');
    let last;
    for (let step = 0; step <= n; step++) last = a.frame();
    for (let step = 0; step < n; step++) b.haze.advanceTime(1 / FPS);
    const seeked = b.frame();
    assert.ok(Object.is(b.haze.time, a.haze.time), `${b.haze.time} against ${a.haze.time}`);
    assert.deepEqual([...seeked], [...last]);
  });

test('a fresh HeatHaze drawn at T without the replay restarts its eddies (the restart a film cut showed)', () => {
  const a = world(),
    c = world();
  let last;
  for (let step = 0; step <= 600; step++) last = a.frame();
  assert.notDeepEqual([...c.frame()], [...last]);
});

test('only the frame update moves the clock: a draw, a second view or a zero delta does not', () => {
  const w = world();
  w.frame();
  assert.equal(w.haze.time, 1 / FPS);
  // A second view drawn in the same frame: the passes run again with no update of its own.
  w.h.gpu.record(() => w.h.frame());
  assert.equal(w.haze.time, 1 / FPS, 'a draw moves no time');
  w.haze.onPreUpdate(0);
  w.haze.advanceTime(-1);
  assert.equal(w.haze.time, 1 / FPS, 'a delta of 0 or less moves no time');
  w.haze.dispose();
  w.haze.advanceTime(1);
  assert.equal(w.haze.time, 1 / FPS, 'a disposed haze keeps its time');
});
