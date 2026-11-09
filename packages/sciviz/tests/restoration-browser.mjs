// Actual device replacement and late source completion, on native WebGPU and webgl2-compat.
// Run under gpu-lock.mjs with a hard process-tree deadline. Included in test:browser/check:merge.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
await mkdir('test-results/sciviz-fixes', { recursive: true });
const reports = [];
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
for (const compat of [false, true]) {
  const context = await openBrowser({ startPath: '/packages/sciviz/tests/sciviz.html', port: 'free', compat });
  const { page } = context;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.setDefaultTimeout(120_000);
  try {
    if (!only || only === 'restore') {
      await page.goto(new URL('/examples/sciviz-head.html', page.url()).href);
      await page.waitForFunction(() => document.querySelector('canvas[data-ready="true"]'));
      await page.selectOption('#view', 'surface');
      const result = await page.evaluate(async () => {
        const demo = await import('/examples/sciviz-head.ts');
        const { ComputeContext } = await import('/packages/compute/dist/index.js');
        await demo.settled;
        const { figure, surface } = demo;
        const engine = figure.engine;
        engine.stop();
        const errors = [];
        const watch = () => engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
        watch();
        const image = async () => {
          await figure.ready();
          const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false }));
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
            ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let hash = 2166136261,
            lit = 0;
          for (let i = 0; i < data.length; i += 4) {
            hash = Math.imul(hash ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16), 16777619);
            if (Math.max(data[i], data[i + 1], data[i + 2]) > 65) lit++;
          }
          return { hash, lit };
        };
        const before = await image(),
          triangles = surface.triangles,
          device = engine.gpu;
        // Hold an active extraction after its GPU work, with exactly the normal abort contract.
        const started = Promise.withResolvers(),
          original = ComputeContext.prototype.done;
        ComputeContext.prototype.done = async function (options) {
          await original.call(this, options);
          started.resolve();
          await new Promise((resolve, reject) => {
            if (options.signal.aborted) reject(options.signal.reason);
            else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          });
        };
        const pending = surface.update(320).then(
          () => 'resolved',
          (e) => e.code,
        );
        const queued = surface.update(300).then(
          () => 'resolved',
          (e) => e.code,
        );
        try {
          await Promise.race([
            started.promise,
            pending.then((result) => {
              throw Error(`extraction did not reach the hold: ${result}`);
            }),
          ]);
        } finally {
          ComputeContext.prototype.done = original;
        }
        await engine.rebootDevice();
        watch();
        figure.render();
        const pendingResult = await pending;
        const queuedResult = await queued;
        const newUpdate = surface.update(surface.level);
        await figure.ready();
        await newUpdate;
        const after = await image();
        const restoredTriangles = surface.triangles;
        const updated = await surface.update(320);
        const updatedImage = await image();
        const next = await figure.isosurface(new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]), 0.5, { dims: [2, 2, 2] });
        const newTriangles = next.triangles;
        figure.remove(next);
        figure.render();
        await engine.gpu.queue.onSubmittedWorkDone();
        const result = {
          changed: device !== engine.gpu,
          triangles,
          before,
          after,
          restoredTriangles,
          pendingResult,
          queuedResult,
          updated,
          updatedImage,
          newTriangles,
          errors,
        };
        figure.dispose();
        return result;
      });
      assert.equal(result.changed, true);
      assert.equal(result.triangles, 216150, 'the review input has its exact committed triangle count');
      assert.equal(result.restoredTriangles, result.triangles);
      assert.ok(result.before.lit > 1000);
      assert.deepEqual(result.after, result.before, 'restored MRI surface redraws the same pixels and count');
      assert.equal(result.pendingResult, 'state', 'active extraction settles with the replacement error');
      assert.equal(result.queuedResult, 'state', 'queued extraction from the lost generation is cancelled');
      assert.equal(result.updated, 184868, 'the 320-level update has the exact triangle count');
      assert.notEqual(result.updatedImage.hash, result.before.hash, 'the new level changes the rendered surface');
      assert.equal(result.newTriangles, 2, 'Figure drops its cached compute device');
      assert.deepEqual(result.errors, []);
      reports.push({ compat, name: 'MRI restoration', ...result });
      console.log(`ok ${compat ? 'WebGL2' : 'WebGPU'} MRI restoration`);

      // The rest of the Figure GPU ownership audit, including updated CPU heights and standalone slices.
      await page.goto(new URL('/packages/sciviz/tests/sciviz.html', page.url()).href);
      const audit = await page.evaluate(async () => {
        const { Figure } = await import('/packages/sciviz/dist/index.js');
        const { createCompute } = await import('/packages/compute/dist/index.js');
        const { brickedVolume, arraySource } = await import('/packages/sciviz/dist/bricks.js');
        const canvas = document.querySelector('canvas');
        const f = await Figure.create(canvas, { axes: true, controls: false });
        f.engine.stop();
        f.engine.camera.position = [1.9, 1.3, 2.1];
        const errors = [],
          watch = () => f.engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
        watch();
        const tick = () => new Promise((r) => setTimeout(r, 0));
        const pump = async (p) => {
          const deadline = performance.now() + 15000;
          let done = false;
          const result = p.finally(() => {
            done = true;
          });
          result.catch(() => {});
          while (!done) {
            if (performance.now() > deadline) throw Error('audit pump deadline');
            f.render();
            await tick();
          }
          return result;
        };
        const values = new Float32Array(64).map((_, i) => (i % 4) / 3);
        const volume = f.volume(values, { dims: [4, 4, 4], range: [0, 1] });
        const slice = volume.slice('x');
        const surface = f.surface(new Float32Array(4), { nx: 2, ny: 2, range: [0, 1], contours: 0 });
        surface.setHeights(new Float32Array(4).fill(0.7));
        const bricks = brickedVolume(f, arraySource(values, [4, 4, 4]), { brickSize: 4, memoryBudget: 4096 });
        const brickSlice = bricks.slice('z');
        const scatter = await f.scatter({ x: [0, 1], y: [0, 1], z: [0, 1] });
        const line = await f.line({ x: [0, 1], y: [1, 0], z: [0, 1] });
        await f.ready();
        await pump(bricks.ready());
        const layers = [volume, slice, surface, bricks, brickSlice, scatter, line];
        const pixel = async (selected) => {
          for (const layer of layers) layer.visible = layer === selected;
          f.render();
          const bitmap = await createImageBitmap(canvas),
            c = new OffscreenCanvas(canvas.width, canvas.height),
            ctx = c.getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          let hash = 2166136261,
            lit = 0;
          for (let i = 0; i < data.length; i += 4) {
            hash = Math.imul(hash ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16), 16777619);
            if (Math.max(data[i], data[i + 1], data[i + 2]) > 65) lit++;
          }
          return { hash, lit };
        };
        const before = [];
        for (const layer of layers) before.push(await pixel(layer));
        await f.engine.rebootDevice();
        watch();
        bricks.visible = true;
        await pump(bricks.ready());
        await f.ready();
        const after = [];
        for (const layer of layers) after.push(await pixel(layer));
        // GPU sources intentionally have no CPU mirror. They must stop using the destroyed device.
        const gpu = await createCompute({ engine: f.engine }),
          a = gpu.array(values, 'f32');
        const gpuSurface = f.surface(a, { nx: 8, ny: 8, range: [0, 1] });
        const gpuVolume = f.volume(a, { dims: [4, 4, 4], range: [0, 1] }),
          gpuSlice = gpuVolume.slice('x');
        const gpuIso = await f.isosurface(a, 0.5, { dims: [4, 4, 4] });
        await f.engine.rebootDevice();
        watch();
        await f.ready();
        const hidden = [gpuSurface, gpuVolume, gpuSlice, gpuIso].every((l) => !l.visible);
        // Even a stale visible flag cannot submit invalid bindings.
        for (const layer of [gpuSurface, gpuVolume, gpuSlice, gpuIso]) layer.visible = true;
        f.render();
        await f.engine.gpu.queue.onSubmittedWorkDone();
        f.dispose();
        gpu.dispose();
        const f2 = await Figure.create(canvas, { mode: '2d', axes: false, controls: false });
        f2.engine.stop();
        f2.heatmap([0, 0.3, 0.7, 1], { nx: 2, ny: 2 });
        f2.render();
        await f2.engine.rebootDevice();
        f2.engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
        f2.render();
        await f2.engine.gpu.queue.onSubmittedWorkDone();
        f2.dispose();
        return { before, after, errors, hidden };
      });
      assert.deepEqual(audit.after, audit.before, 'each CPU-backed layer, slice, point and line survives replacement');
      assert.ok(audit.before.every((p) => p.lit > 10));
      assert.equal(audit.hidden, true, 'GPU-only sources require recreation, with no stale device submissions');
      assert.deepEqual(audit.errors, []);
      reports.push({ compat, name: 'all layer restoration', ...audit });
      console.log(`ok ${compat ? 'WebGL2' : 'WebGPU'} all layer restoration`);
    }
    if (!only || only === 'abort') {
      await page.goto(new URL('/packages/sciviz/tests/sciviz.html', page.url()).href);
      const aborted = await page.evaluate(async () => {
        const { Figure } = await import('/packages/sciviz/dist/index.js');
        const { brickedVolume } = await import('/packages/sciviz/dist/bricks.js');
        const f = await Figure.create(document.querySelector('canvas'), { axes: false, controls: false });
        f.engine.stop();
        f.engine.camera.position = [1.9, 1.3, 2.1];
        const held = Promise.withResolvers(),
          started = Promise.withResolvers(),
          signals = [];
        const v = brickedVolume(
          f,
          {
            dims: [4, 4, 4],
            frames: 2,
            range: [0, 1],
            async read(r) {
              if (r.frame === 1) {
                signals.push(r.signal);
                started.resolve();
                await held.promise;
              }
              return new Float32Array(r.size[0] * r.size[1] * r.size[2]).fill(r.frame ? 0.8 : 0.4);
            },
          },
          { brickSize: 4, memoryBudget: 4096 },
        );
        const tick = () => new Promise((r) => setTimeout(r, 0));
        const pump = async (p) => {
          const deadline = performance.now() + 15000;
          let done = false;
          const result = p.finally(() => {
            done = true;
          });
          result.catch(() => {});
          while (!done) {
            if (performance.now() > deadline) throw Error('abort pump deadline');
            f.render();
            await tick();
          }
          return result;
        };
        const hash = async () => {
          f.render();
          const bitmap = await createImageBitmap(f.engine.canvas);
          const c = new OffscreenCanvas(bitmap.width, bitmap.height),
            ctx = c.getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          return Array.from(ctx.getImageData(0, 0, c.width, c.height).data).reduce(
            (h, v) => Math.imul(h ^ v, 16777619),
            2166136261,
          );
        };
        await pump(v.ready());
        const before = v.frame,
          beforePixels = await hash();
        const controller = new AbortController();
        const p = v.setFrame(1, { signal: controller.signal }).then(
          () => false,
          (e) => e === controller.signal.reason,
        );
        await pump(started.promise);
        controller.abort();
        const rejected = await p;
        const readAborted = signals.every((s) => s.aborted),
          afterAbort = v.frame;
        held.resolve();
        await pump(v.ready());
        const observed = [];
        // fixed-wait: prove the cancelled frame remains absent over subsequent draws after the held read has settled.
        for (let i = 0; i < 12; i++) {
          f.render();
          await tick();
          observed.push(v.frame);
        }
        const afterPixels = await hash();
        await pump(v.setFrame(1));
        const next = v.frame;
        f.dispose();
        return { before, rejected, readAborted, afterAbort, observed, beforePixels, afterPixels, next };
      });
      assert.equal(aborted.before, 0);
      assert.equal(aborted.rejected, true);
      assert.equal(aborted.readAborted, true);
      assert.equal(aborted.afterAbort, 0);
      assert.ok(aborted.observed.every((f) => f === 0));
      assert.equal(aborted.afterPixels, aborted.beforePixels, 'late completion cannot publish cancelled pixels');
      assert.equal(aborted.next, 1, 'a later request still succeeds');
      reports.push({ compat, name: 'active frame abort', ...aborted });
      console.log(`ok ${compat ? 'WebGL2' : 'WebGPU'} active frame abort`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
await writeFile('test-results/sciviz-fixes/restoration.json', JSON.stringify(reports, null, 2));
console.log(`${reports.length} sciviz restoration/cancellation backend checks passed`);
