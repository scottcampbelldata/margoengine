import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const reports = [];
for (const fallback of [false, true]) {
  const browser = await openBrowser({
    startPath: `/examples/sciviz-progressive.html${fallback ? '?backend=webgl2' : ''}`,
    port: 'free',
  });
  const errors = [];
  browser.page.setDefaultTimeout(120000);
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.'));
    const report = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-progressive.ts');
      const { ProgressiveRendering } = await import('/packages/sciviz/dist/progressive.js');
      const { figures, bricks, volumes, lighting } = demo;
      figures.forEach((f) => {
        f.engine.stop();
        f.engine.canvas.style.width = '128px';
        f.engine.canvas.style.height = '96px';
      });
      demo.controllers.forEach((c) => c.dispose());
      const controllers = figures.map((f) => new ProgressiveRendering(f, { settleFrames: 1, refinementFrames: 4 }));
      const gpuErrors = [];
      const watch = (f) => f.engine.gpu.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      figures.forEach(watch);
      const check = (value, message) => {
        if (!value) throw new Error(message);
      };
      const frame = async (f) => {
        await f.ready();
        f.render();
        await f.engine.gpu.queue.onSubmittedWorkDone();
      };
      const settle = async (f) => {
        const index = figures.indexOf(f),
          controller = controllers[index],
          light = lighting[index - 1];
        const signal = AbortSignal.timeout(30000);
        do {
          signal.throwIfAborted();
          await frame(f);
        } while (
          controller.state.progress < 1 ||
          controller.state.sampleScale < 1 ||
          controller.state.resolutionScale < 1 ||
          (light && light.samples < 2)
        );
      };
      const resident = async (f) => {
        const signal = AbortSignal.timeout(30000);
        const ready = bricks.ready({ signal });
        let done = false;
        void ready.then(
          () => {
            done = true;
          },
          () => {
            done = true;
          },
        );
        while (!done) {
          signal.throwIfAborted();
          await frame(f);
          await new Promise((r) => setTimeout(r, 0));
        }
        await ready;
      };
      const pixel = async (f) => {
        const bitmap = await createImageBitmap(await f.toPNG({ overlays: false }));
        const c = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = c.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const bytes = ctx.getImageData(0, 0, c.width, c.height).data;
        let hash = 2166136261,
          lit = 0;
        for (let i = 0; i < bytes.length; i += 4) {
          hash = Math.imul(hash ^ bytes[i] ^ (bytes[i + 1] << 8) ^ (bytes[i + 2] << 16), 16777619);
          if (Math.max(bytes[i], bytes[i + 1], bytes[i + 2]) > 65) lit++;
        }
        return { hash, lit };
      };
      const states = [];
      for (let i = 0; i < figures.length; i++) {
        const f = figures[i],
          c = controllers[i];
        await frame(f);
        const moving = c.state,
          width = f.engine.canvas.width,
          height = f.engine.canvas.height;
        const movingCost = i ? await lighting[i - 1].cost() : null;
        check(moving.resolutionScale === 0.5 && moving.sampleScale === 0.25, 'first camera frame reduces both costs');
        await settle(f);
        check(
          c.state.progress === 1 && c.state.sampleScale === 1 && c.state.resolutionScale === 1,
          'full resting refinement',
        );
        if (i) check(lighting[i - 1].samples > 1, 'cinematic accumulation advances after refinement');
        const restingCost = i ? await lighting[i - 1].cost() : null;
        if (i)
          check(movingCost.pixels * 4 === restingCost.pixels, 'GPU transport target really has one quarter the pixels');
        c.recordFrameTime(1000);
        f.engine.camera.position[0] += 0.2;
        await frame(f);
        const budgeted = c.state;
        check(
          budgeted.progress === 0 &&
            budgeted.resolutionScale < moving.resolutionScale &&
            budgeted.sampleScale < moving.sampleScale,
          'budget feedback reduces interaction work',
        );
        check(
          f.engine.canvas.width === width && f.engine.canvas.height === height,
          'backbuffer dimensions stay unchanged',
        );
        if (i) check(lighting[i - 1].samples === 1, 'camera changes discard cinematic history');
        await settle(f);
        if (i) lighting[i - 1].reset();
        if (!i) await resident(f);
        const before = await pixel(f),
          device = f.engine.gpu;
        await f.engine.rebootDevice();
        watch(f);
        check(f.engine.gpu !== device, 'actual device replaced');
        if (!i) await resident(f);
        await settle(f);
        if (i) lighting[i - 1].reset();
        const after = await pixel(f);
        check(
          before.hash === after.hash && before.lit === after.lit,
          `real-data full-quality pixels survive device restore ${i}: ${JSON.stringify({ before, after, stats: i ? null : bricks.stats })}`,
        );
        check(before.lit > 10, 'real-data rendering has nonbackground pixels');
        // At the terminal level, bypassing the controller gives the same exact original renderer output.
        c.dispose();
        if (i) lighting[i - 1].reset();
        const original = await pixel(f);
        check(
          original.hash === after.hash,
          `terminal image exactly matches unmodified rendering ${i}: ${JSON.stringify({ after, original, stats: i ? null : bricks.stats })}`,
        );
        check(f.renderer.samplingScale === 1, 'disposed controller releases sampling state');
        states.push({ moving, budgeted, movingCost, restingCost, before, after, original });
      }
      check(volumes.every((v) => v.quality === 1) && bricks.quality === 1, 'user sample settings remain intact');
      figures.forEach((f) => f.dispose());
      return { states, gpuErrors };
    });
    assert.deepEqual(report.gpuErrors, []);
    assert.deepEqual(errors, []);
    reports.push({ fallback, ...report });
    await browser.page.screenshot({ path: `test-results/batch181-j5-${fallback ? 'compat' : 'native'}.png` });
    console.log(
      `ok progressive rendering, real bricked/cinematic data and device restore: ${fallback ? 'WebGL2' : 'WebGPU'}`,
    );
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/batch181-j5-progressive.json', JSON.stringify(reports, null, 2) + '\n');
