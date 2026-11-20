// GAP-FILM-TIME: a clock started at film time T reads what a continuous run reads at T. Run A takes n + 1 frame updates;
// run B is fresh, replays n steps with `advanceTime` (what `seek` from @margoengine/cutscene/seek runs), then takes one
// update. The clock moves in the frame update, so a draw no longer moves it out of reach of a seek.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Splats } from '../dist/index.js';
import { SplatSequence } from '../dist/animate.js';
import { SplatModifier } from '../dist/modify.js';

async function seekMatches(make, label, { scale = 1, after = () => {} } = {}) {
  for (const n of [1, 600, 54000]) {
    const a = await make(),
      b = await make();
    try {
      assert.equal(b.clock.time, 0, `a fresh ${label} starts at 0`);
      for (let step = 0; step <= n; step++) a.clock.onPreUpdate(1 / 60);
      for (let step = 0; step < n; step++) b.clock.advanceTime(1 / 60);
      b.clock.onPreUpdate(1 / 60);
      assert.ok(Object.is(b.clock.time, a.clock.time), `${label} at ${n} steps`);
      if (scale) assert.ok(Math.abs(a.clock.time - ((n + 1) / 60) * scale) <= 1e-6 * (n + 1) * scale, `${label} counts its clock`);
      after(a, b, n);
    } finally {
      a.close?.();
      b.close?.();
    }
  }
}

const frame = () => ({ positions: new Float32Array(6), covariances: Float32Array.from({ length: 12 }, (_, i) => ([0, 3, 5].includes(i % 6) ? 0.01 : 0)), colors: new Float32Array(8).fill(0.5) });

test('a splat sequence and a splat modifier replayed equal a continuous run', async () => {
  await seekMatches(() => ({ clock: new SplatSequence(Splats.reserve(2), [frame(), frame()], { fps: 10 }) }), 'SplatSequence');
  await seekMatches(() => ({ clock: Object.assign(Object.create(SplatModifier.prototype), { time: 0, playing: true, speed: 1 }) }), 'SplatModifier');
  const paused = Object.assign(Object.create(SplatModifier.prototype), { time: 0, playing: true, speed: 1 });
  paused.playing = false;
  paused.onPreUpdate(1);
  assert.equal(paused.time, 0, 'a paused modifier holds its time');
  const fast = new SplatSequence(Splats.reserve(2), [frame(), frame()], { fps: 10 });
  fast.speed = -2;
  fast.advanceTime(0.5);
  assert.equal(fast.time, -1, 'speed scales the clock, backwards included');
});
