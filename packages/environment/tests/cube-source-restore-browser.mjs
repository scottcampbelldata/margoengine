// Real-GPU proof of the borrowed-object rule for Environment's GPU cube source (`CubeTextureSource.texture`) across a
// device restore (KB-RESTORE-BORROWED1, docs/conventions.md, "Borrowed GPU objects"). A plain texture belongs to the
// device that made it: after `engine.rebootDevice()` nothing is built from it (no validation error), `engine.onError`
// hears of it once ('state', #borrowed-lost), the environment reads as restoring (`device` null, so lighting binds none)
// and the frame keeps drawing; `environment.setSource(newTexture)` processes it again. A live source whose `texture`
// gives the current device's texture (what a CubeCamera does) is read again at the restore, with no report.
// Run from the repository root after building packages, with a hard limit:
//   node scripts/run-with-timeout.mjs --max=5 -- node packages/environment/tests/cube-source-restore-browser.mjs
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
    const { Environment } = await import('/packages/environment/dist/index.js');
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
    const cube = (device) =>
      device.createTexture({
        size: [16, 16, 6],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      });
    const frame = async () => {
      try {
        engine.render({ delta: 1 / 60 });
        await engine.gpu.queue.onSubmittedWorkDone();
      } catch (error) {
        problems.push(`frame: ${error.message}`);
      }
    };
    const settle = async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await frame();
      }
    };
    const restore = async () => {
      const previous = engine.gpu;
      previous.destroy();
      await previous.lost;
      await engine.rebootDevice();
      watch(engine.gpu);
      await settle();
    };
    const out = {};
    // A plain texture.
    const environment = await Environment.attach(engine, { texture: cube(engine.gpu) });
    out.first = environment.device === engine.gpu;
    await restore();
    out.lost = { problems: [...problems], reported: [...reported], device: environment.device };
    await environment.setSource({ texture: cube(engine.gpu) });
    await settle();
    out.again = { problems: [...problems], reported: reported.length, device: environment.device === engine.gpu };
    await restore();
    out.lostTwice = { reported: reported.length, device: environment.device };
    environment.dispose();
    // A live source: its texture is the current device's.
    const live = {
      get texture() {
        return live.on === engine.gpu ? live.t : (live.t = cube((live.on = engine.gpu)));
      },
    };
    const alive = await Environment.attach(engine, live);
    await restore();
    out.live = { problems: [...problems], reported: reported.length, device: alive.device === engine.gpu };
    alive.dispose();
    return out;
  });
  assert.equal(report.first, true, 'the environment is built on its device');
  assert.deepEqual(
    report.lost.problems,
    [],
    'nothing of the lost texture is used: no validation error, no thrown frame',
  );
  assert.equal(report.lost.reported.length, 1, `reported once: ${JSON.stringify(report.lost.reported)}`);
  assert.match(report.lost.reported[0], /^state Environment source texture lost with the device; .*#borrowed-lost/);
  assert.equal(report.lost.device, null, 'the environment reads as restoring, so lighting binds none');
  assert.deepEqual(report.again.problems, [], 'a new source processes again');
  assert.equal(report.again.device, true, 'the environment is back on the new device');
  assert.equal(report.again.reported, 1, 'no further report');
  assert.equal(report.lostTwice.reported, 2, 'the next restore loses the replaced texture and reports it once');
  assert.equal(report.lostTwice.device, null);
  assert.deepEqual(report.live.problems, [], 'a live source follows the new device');
  assert.equal(report.live.reported, 2, 'no report for a live source');
  assert.equal(report.live.device, true);
  assert.deepEqual(pageErrors, []);
  console.log(`ok Environment cube source across a device restore${compat ? ' (WebGL2 compatibility layer)' : ''}`);
} finally {
  await closeAll({ browser });
}
