// GAP-FILM-TIME: a clock started at film time T reads what a continuous run reads at T. Run A takes n + 1 frame updates;
// run B is fresh, replays n steps with `advanceTime` (what `seek` from @margoengine/cutscene/seek runs), then takes one
// update. The clock moves in the frame update, so a draw no longer moves it out of reach of a seek.
import test from 'node:test';
import assert from 'node:assert/strict';
import { XRaySelection } from '../dist/xray.js';

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
      if (scale)
        assert.ok(
          Math.abs(a.clock.time - ((n + 1) / 60) * scale) <= 1e-6 * (n + 1) * scale,
          `${label} counts its clock`,
        );
      after(a, b, n);
    } finally {
      a.close?.();
      b.close?.();
    }
  }
}

test('the x-ray pulse replayed equals a continuous run, and manual time holds', async () => {
  await seekMatches(() => ({ clock: new XRaySelection({ pulse: { period: 1.5 } }) }), 'XRaySelection');
  const manual = new XRaySelection({});
  manual.time = 2;
  manual.onPreUpdate(1);
  assert.equal(manual.time, 2, 'manual time is not moved by the frame update');
  manual.play();
  manual.advanceTime(0.5);
  assert.equal(manual.time, 2.5);
});
