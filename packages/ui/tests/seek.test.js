// GAP-FILM-TIME: a clock started at film time T reads what a continuous run reads at T. Run A takes n + 1 frame updates;
// run B is fresh, replays n steps with `advanceTime` (what `seek` from @margoengine/cutscene/seek runs), then takes one
// update. The clock moves in the frame update, so a draw no longer moves it out of reach of a seek.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UiRenderer } from '../dist/index.js';

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

// The clock and the Ui.update calls; a disposed renderer moves nothing.
test('the UI renderer frame clock replayed equals a continuous run, and runs Ui.update each step', async () => {
  const bare = () => {
    const updates = [];
    return {
      clock: Object.assign(Object.create(UiRenderer.prototype), { elapsed: 0, disposed: false, ui: { update: (dt) => updates.push(dt) } }),
      updates,
    };
  };
  await seekMatches(bare, 'UiRenderer', { after: (a, b) => assert.deepEqual(b.updates, a.updates) });
  const gone = bare();
  gone.clock.disposed = true;
  gone.clock.advanceTime(1);
  assert.deepEqual([gone.clock.time, gone.updates.length], [0, 0]);
});
