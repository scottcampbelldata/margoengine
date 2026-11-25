// Real-GPU proof of the borrowed-object rule for ContactLights `depth` across a device restore (KB-RESTORE-BORROWED1,
// docs/conventions.md, "Borrowed GPU objects"). A plain depth texture belongs to the device that made it: after
// `engine.rebootDevice()` it is dropped (no validation error, no thrown frame), `engine.onError` hears of it once
// ('state', #borrowed-lost), and `setDepth(newTexture)` brings the depth copy back with no further report. A
// callback is read live every frame, so it follows the new device with no report at all.
// Run from the repository root after building packages, with a hard limit:
//   node scripts/run-with-timeout.mjs --max=5 -- node packages/clustered/test/contact-borrowed-restore-browser.mjs
// (add --compat or MARGO_COMPAT=1 for the WebGL2 compatibility layer).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const compat = compatRun();
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page } = browser,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

try {
  const report = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Clustered } = await import('/packages/clustered/dist/index.js');
    const { ContactLights } = await import('/packages/clustered/dist/contact.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:64px;height:64px';
    document.body.append(canvas);
    const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [0, 3, 4], target: [0, 0, 0] },
      }),
      reported = [],
      problems = [];
    engine.stop?.();
    engine.onError = (e) => reported.push(`${e?.code} ${e?.message}`);
    const watch = (device) => device.addEventListener('uncapturederror', (e) => problems.push(e.error.message));
    watch(engine.gpu);
    const depth = (device) =>
      device.createTexture({ size: [16, 16], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING });
    const frame = async () => {
      try {
        engine.render({ delta: 1 / 60 });
        await engine.gpu.queue.onSubmittedWorkDone();
      } catch (error) {
        problems.push(`frame: ${error.message}`);
      }
    };
    const restore = async () => {
      const previous = engine.gpu;
      previous.destroy();
      await previous.lost;
      await engine.rebootDevice();
      watch(engine.gpu);
      for (let i = 0; i < 3; i++) await frame();
    };
    const lights = Clustered.attach(engine);
    lights.setLights([{ position: [0, 2, 0], range: 8 }]);
    const plain = depth(engine.gpu),
      contact = ContactLights.attach(engine, { lights, depth: plain });
    for (let i = 0; i < 3; i++) await frame();
    const out = { before: { problems: problems.length, reported: reported.length } };
    await restore();
    for (let i = 0; i < 3; i++) await frame();
    out.lost = { problems: [...problems], reported: [...reported] };
    contact.setDepth(depth(engine.gpu));
    for (let i = 0; i < 3; i++) await frame();
    out.again = { problems: [...problems], reported: reported.length };
    let made = 0;
    contact.setDepth(() => (made++, depth(engine.gpu)));
    await frame();
    await restore();
    out.live = { problems: [...problems], reported: reported.length, made };
    return out;
  });
  assert.deepEqual(report.before, { problems: 0, reported: 0 }, 'a plain depth works on its own device');
  assert.deepEqual(report.lost.problems, [], 'the lost depth is never bound: no validation error, no thrown frame');
  assert.equal(report.lost.reported.length, 1, `reported once: ${JSON.stringify(report.lost.reported)}`);
  assert.match(report.lost.reported[0], /^state ContactLights depth lost with the device; .*#borrowed-lost/);
  assert.deepEqual(report.again.problems, [], 'a new texture copies depth again');
  assert.equal(report.again.reported, 1, 'no further report');
  assert.deepEqual(report.live.problems, [], 'a callback follows the new device');
  assert.equal(report.live.reported, 1, 'no report for a callback');
  assert.ok(report.live.made > 1, 'the callback is read every frame');
  assert.deepEqual(pageErrors, []);
  console.log(`ok ContactLights depth across a device restore${compat ? ' (WebGL2 compatibility layer)' : ''}`);
} finally {
  await closeAll({ browser });
}
