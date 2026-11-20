// GAP-FILM-TIME: a clock started at film time T reads what a continuous run reads at T. Run A takes n + 1 frame updates;
// run B is fresh, replays n steps with `advanceTime` (what `seek` from @margoengine/cutscene/seek runs), then takes one
// update. The clock moves in the frame update, so a draw no longer moves it out of reach of a seek.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PixelCamera } from '../dist/index.js';
import { PixelFollow } from '../dist/follow.js';

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

test('a pixel follow rig replayed equals a continuous run, shake and fade included', async () => {
  await seekMatches(
    () => {
      const rig = new PixelFollow({ camera: new PixelCamera({ width: 100, height: 60 }), target: { x: 30, y: 12 } });
      rig.shake(2, 4, 3).fadeOut(3);
      return { clock: rig };
    },
    'PixelFollow',
    {
      after(a, b) {
        assert.deepEqual([b.clock.camera.x, b.clock.camera.y, ...b.clock.overlay], [a.clock.camera.x, a.clock.camera.y, ...a.clock.overlay]);
      },
    },
  );
});
