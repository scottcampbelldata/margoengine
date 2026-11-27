// Real-GPU proof of the Beaufort thrash (`ScatterWind` speed, `windClockRate`), on WebGPU and, with MARGO_COMPAT=1, the
// WebGL2 compatibility layer: a field of 6,000 thin blocks in a full bend, one frame drawn after one clock step.
// - A gale's speed (17.2 m/s, Beaufort 8) runs the wind clock 17.2 / 5.4 times as fast. Until KB-LOOK-TV-SHIMMER1 this
//   test also required the gale's 1 s to draw the same pixels as 17.2 / 5.4 s of a wind with no speed: that equality was
//   the defect (one clock for the whole sway, trunks included). A plant now follows the gusts only as fast as its own
//   frequency lets it, so the two frames differ slightly; sway.browser.mjs checks numerically that a short plant still
//   thrashes with the wind clock (within 1 percent of its reach) and that a tall one keeps its own sway.
// - The same second without the speed draws a different frame (the plants are elsewhere in their sway).
// - A breeze below force 4 (4 m/s) keeps the plants' own sway: its frame equals the frame with no speed.
// Run from the repository root after building packages, through scripts/run-with-timeout.mjs.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  await page.evaluate(async () => {
    const { Engine, box } = await import('/packages/core/dist/index.js');
    const { Scatter } = await import('/packages/scatter/dist/index.js');
    const { Shadows } = await import('/packages/shadows/dist/index.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 192;
    canvas.style.cssText = 'width:192px;height:192px;display:block';
    document.body.replaceChildren(canvas);
    const engine = await Engine.create(canvas, {
      camera: { position: [0, 3, 9], target: [0, 0.5, 0], near: 0.1, far: 100 },
    });
    engine.stop();
    engine.lighting.direction.set([1, 1, 0.3]);
    const d = engine.gpu,
      found = [];
    d.addEventListener?.('uncapturederror', (e) => found.push(e.error.message));
    const floor = engine
      .createMesh()
      .setGeometry(box(30, 0.1, 30))
      .setPosition([0, -0.05, 0]);
    const shadows = Shadows.attach(engine, { distance: 20 });
    shadows.add(floor, { castShadow: false });
    let field, remove;
    window.check = {
      async show(wind, delta) {
        remove?.();
        field?.dispose();
        field = Scatter.attach(engine, box(0.06, 0.8, 0.06), { count: 6000, area: [10, 10], seed: 5, wind });
        await field.ready;
        remove = shadows.add(field);
        await waitForPipelines(async () => {
          engine.render({ delta: 0 });
          await d.queue.onSubmittedWorkDone();
        });
        // Engine frames take short deltas; the clock step goes straight to the field.
        field.advanceTime(delta);
        engine.render({ delta: 0 });
        await d.queue.onSubmittedWorkDone();
        return { errors: found.splice(0), time: field.time, windTime: field.windTime };
      },
    };
  });
  const show = async (wind, delta) => {
    const r = await page.evaluate(([w, dt]) => window.check.show(w, dt), [wind, delta]);
    assert.deepEqual(r.errors, []);
    return { ...r, png: await decodePNG(await page.locator('canvas').screenshot()) };
  };
  const diff = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.data.length; i += 4)
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
    return n;
  };
  const gale = await show([1, 0, 1, 17.2], 1),
    slow = await show([1, 0, 1], 17.2 / 5.4),
    same = await show([1, 0, 1], 1),
    breeze = await show([1, 0, 1, 4], 1);
  assert.equal(gale.windTime, 17.2 / 5.4);
  assert.equal(gale.time, 1);
  const near = diff(gale.png, slow.png);
  const moved = diff(gale.png, same.png);
  assert.ok(moved > 200, `without the speed the plants are elsewhere in their sway (${moved} pixels)`);
  assert.equal(diff(breeze.png, same.png), 0, 'a breeze below force 4 keeps their own sway');
  assert.deepEqual(errors, []);
  console.log(
    `wind-speed: gale against the same second without speed: ${moved} pixels differ; against the same wind clock: ${near}`,
  );
} finally {
  await closeAll({ browser });
}
