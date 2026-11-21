// Real-GPU proof of the borrowed-object rule for `autoExposure.mask` across a device restore (KB-RESTORE-BORROWED1).
// Run from the repository root after building packages, one GPU job at a time:
//   node scripts/run-with-timeout.mjs --max=5 -- node packages/tonemap/tests/borrowed-restore-browser.mjs
// (MARGO_COMPAT=1 for the WebGL2 compatibility layer). A flat 0.5 source with a mask of weight 1 meters log2(0.18 / 0.5).
// After `engine.rebootDevice()` a plain mask is dropped: no validation error or throw, one 'state' report linking
// #borrowed-lost, and the meter has no weight so it stores nothing; a new mask through `autoExposure.mask` brings the
// exposure back with no second report. A `(device) => texture` mask is made once per device and meters after a second
// restore with no report.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

await postBrowser(
  'tonemap-borrowed-restore',
  5373,
  () => launchBrowser({ headless: true }),
  async (page) => {
    const r = await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { Tonemap } = await import('/packages/tonemap/dist/index.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, { backend: 'webgpu' }),
        reported = [],
        uncaptured = [];
      engine.stop();
      engine.onError = (e) => reported.push(`${e?.code ?? ''} ${e?.message ?? e}`);
      const watch = (device) => device.addEventListener('uncapturederror', (e) => uncaptured.push(e.error.message));
      watch(engine.gpu);
      const W = canvas.width,
        H = canvas.height,
        sources = new WeakMap(),
        // The HDR source is a per-frame getter (rule 6): a texture made for the device in use.
        source = () => {
          const device = engine.gpu;
          if (!sources.has(device)) {
            const t = device.createTexture({
              size: [W, H],
              format: 'rgba32float',
              usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            device.queue.writeTexture(
              { texture: t },
              Float32Array.from({ length: W * H * 4 }, (_, i) => (i % 4 === 3 ? 1 : 0.5)),
              { bytesPerRow: W * 16 },
              [W, H],
            );
            sources.set(device, t);
          }
          return sources.get(device);
        };
      const mask = (device) => {
        const t = device.createTexture({
          size: [1, 1],
          format: 'r8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture: t }, new Uint8Array([255]), { bytesPerRow: 256 }, [1, 1]);
        return t;
      };
      let made = 0;
      const tonemap = Tonemap.attach(engine, { curve: 'linear', source, autoExposure: { metering: 'mask', mask: mask(engine.gpu) } });
      const exposure = async () => {
        const device = engine.gpu,
          read = device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        engine.render({ delta: 1 / 60 });
        const e = device.createCommandEncoder();
        e.copyBufferToBuffer(tonemap.aeBuffer, 0, read, 0, 8);
        device.queue.submit([e.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const v = [...new Float32Array(read.getMappedRange())];
        read.unmap();
        read.destroy();
        return v;
      };
      const restore = async () => {
        const previous = engine.gpu;
        previous.destroy();
        await previous.lost;
        await engine.rebootDevice();
        watch(engine.gpu);
      };
      const out = {};
      out.live = await exposure();
      await restore();
      out.lost = await exposure();
      out.lostReports = reported.length;
      tonemap.options.autoExposure = { metering: 'mask', mask: mask(engine.gpu) };
      out.replaced = await exposure();
      out.reportsAfterReplace = reported.length;
      tonemap.options.autoExposure = { metering: 'mask', mask: (device) => (made++, mask(device)) };
      out.fn = await exposure();
      await restore();
      out.fnAfter = await exposure();
      out.made = made;
      out.reports = reported;
      out.uncaptured = uncaptured;
      engine.dispose();
      return out;
    });
    console.log(JSON.stringify(r));
    const want = Math.log2(0.18 / 0.5);
    assert.deepEqual(r.uncaptured, [], 'no validation error from a frame after the restore');
    assert.ok(Math.abs(r.live[0] - want) < 1e-3 && r.live[1] === 1, `the mask meters before the restore: ${r.live}`);
    assert.equal(r.lost[1], 0, `a lost plain mask has no weight, so nothing is stored: ${r.lost}`);
    assert.equal(r.lostReports, 1, 'one report for the lost mask');
    assert.ok(Math.abs(r.replaced[0] - want) < 1e-3 && r.replaced[1] === 1, `a new mask meters again: ${r.replaced}`);
    assert.equal(r.reportsAfterReplace, 1, 'no report for the new mask');
    assert.ok(Math.abs(r.fn[0] - want) < 1e-3 && r.fn[1] === 1, `the function mask meters: ${r.fn}`);
    assert.ok(Math.abs(r.fnAfter[0] - want) < 1e-3 && r.fnAfter[1] === 1, `and again after the restore: ${r.fnAfter}`);
    assert.equal(r.made, 2, 'made once per device');
    assert.equal(r.reports.length, 1, `only the one report: ${JSON.stringify(r.reports)}`);
    assert.match(r.reports[0], /^state Tonemap autoExposure mask lost with the device.*#borrowed-lost/);
  },
  { seconds: 120 },
);
