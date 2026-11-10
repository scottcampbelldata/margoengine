// Complete shared WebGL2 path, compared to native WebGPU. Correctness only, no timing sweep.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const reports = [];
for (const fallback of [false, true]) {
  const context = await openBrowser({ startPath: '/packages/sciviz/tests/volume-quality.html', port: 'free' });
  const errors = [];
  context.page.on('pageerror', e => errors.push(e.message));
  context.page.setDefaultTimeout(120000);
  try {
    const report = await context.page.evaluate(async (fallback) => {
      globalThis.margoLow = 1;
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { createFallbackFigure, marchingCubes } = await import('/packages/sciviz/dist/fallback.js');
      const { loadNRRD } = await import('/packages/sciviz/dist/nrrd.js');
      const { dims, data } = await loadNRRD(new URL('/examples/assets/sciviz/head.nrrd', location.href));
      const n = 24, field = Float32Array.from({ length: n ** 3 }, (_, i) => {
        const x = i % n, y = Math.floor(i / n) % n, z = Math.floor(i / n ** 2);
        const p = [x, y, z].map((v, a) => Math.round(v * (dims[a] - 1) / (n - 1)));
        return data[(p[2] * dims[1] + p[1]) * dims[0] + p[0]];
      });
      const canvas = document.createElement('canvas');
      canvas.width = 192; canvas.height = 144; canvas.style.cssText = 'width:192px;height:144px';
      document.body.append(canvas);
      const make = fallback ? createFallbackFigure : Figure.create;
      let f = await make(canvas, { axes: false, controls: false, aspect: [1, 1, 1] });
      f.engine.stop();
      const errors = [];
      const watch = () => f.renderer.device.addEventListener('uncapturederror', e => errors.push(e.error.message));
      watch();
      let extractions = 0;
      if (fallback) {
        const extract = f.renderer.cpuIsosurface;
        f.renderer.cpuIsosurface = (...args) => { extractions++; return extract(...args); };
      }
      const pixels = async () => {
        await f.ready(); f.render();
        const image = await createImageBitmap(canvas), copy = new OffscreenCanvas(canvas.width, canvas.height);
        const ctx = copy.getContext('2d'); ctx.drawImage(image, 0, 0); image.close();
        return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
      };
      const images = {}, counts = {};
      const save = async name => { images[name] = await pixels(); };
      const clear = () => { for (const layer of f.layers) f.remove(layer); };
      const bounds = [0, 1, 0, 1, 0, 1];
      try {
        f.surface(field.slice(0, n * n), { nx: n, ny: n, range: [0, 600] });
        await save('surface'); clear();
        const volume = f.volume(field, { dims: [n, n, n], bounds, range: [0, 600], shading: false, quality: 2 });
        await save('volume'); volume.mode = 'mip'; await save('mip');
        volume.visible = false; const slice = volume.slice('z', 0.5); await save('slice');
        f.remove(slice); clear();
        const iso = await f.isosurface(field, 300, { dims: [n, n, n], bounds });
        counts.triangles = iso.triangles;
        const cpu = await marchingCubes(field, 300, { dims: [n, n, n] });
        if (iso.triangles !== cpu.triangles) throw Error('CPU/GPU triangle count mismatch');
        await save('isosurface');
        const before = images.isosurface;
        await f.engine.rebootDevice(); watch();
        await f.ready(); const after = await pixels();
        if (before.some((v, i) => v !== after[i])) throw Error('CPU isosurface restore changes pixels');
        const abort = new AbortController(); abort.abort('exact cancellation');
        let rejected;
        try { await iso.update(280, { signal: abort.signal }); } catch (e) { rejected = e; }
        if (rejected !== 'exact cancellation') throw Error('cancellation reason lost');
        if (iso.triangles !== counts.triangles) throw Error('cancelled extraction published');
        clear(); f.dispose(); f = await make(canvas, { mode: '2d', axes: false, controls: false }); f.engine.stop(); watch();
        await f.bar({ x: [1, 2, 3], y: [2, 4, 1] }); await save('bars'); clear();
        await f.heatmap([0, 1, 2, 3], { nx: 2, ny: 2 }); await save('heatmap');
        if (fallback && extractions !== 2) throw Error(`expected CPU extraction plus restore, got ${extractions}`);
        if (errors.length) throw Error(errors.join('; '));
        return { images, counts, extractions };
      } finally { f.dispose(); }
    }, fallback);
    assert.deepEqual(errors, []);
    reports.push(report);
    if (fallback) for (const demo of ['head', 'stars', 'wind']) {
      await context.page.goto(new URL(`/examples/sciviz-${demo}.html?backend=webgl2`, context.page.url()).href);
      await context.page.waitForFunction(() => document.querySelector('canvas[data-ready="true"],canvas[data-error]'));
      assert.equal(await context.page.locator('canvas[data-error]').count(), 0, demo);
      const result = await context.page.evaluate(async (demo) => {
        const module = await import(`/examples/sciviz-${demo}.ts`);
        await module.settled;
        const f = module.figure;
        await f.ready();
        f.engine.stop(); f.render();
        const copy = new OffscreenCanvas(160, 100), ctx = copy.getContext('2d');
        ctx.drawImage(f.engine.canvas, 0, 0, 160, 100);
        const data = ctx.getImageData(32, 20, 96, 60).data;
        let lit = 0;
        for (let i = 0; i < data.length; i += 4) if (Math.max(data[i], data[i + 1], data[i + 2]) > 65) lit++;
        return { cpuExtraction: typeof f.renderer.cpuIsosurface === 'function', lit };
      }, demo);
      assert.equal(result.cpuExtraction, true, demo);
      assert(result.lit > 100, `${demo}: ${JSON.stringify(result)}`);
      assert.deepEqual(errors, []);
    }
  } finally { await context.close(); }
}
const parity = [];
for (const [name, a] of Object.entries(reports[0].images)) {
  const b = reports[1].images[name]; let sum = 0, over = 0, lit = 0;
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(...[0, 1, 2].map(c => Math.abs(a[i + c] - b[i + c])));
    sum += d; if (d > 8) over++;
    if (Math.max(b[i], b[i + 1], b[i + 2]) > 65) lit++;
  }
  const row = { name, mean: sum / (a.length / 4), share: over / (a.length / 4), lit };
  parity.push(row);
  assert(lit > 100, `${name} draws real data: ${lit}`);
  // Fixed before the first run; includes all silhouettes and background pixels.
  assert(row.share <= 0.02 && row.mean <= 1, JSON.stringify(row));
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/sciviz-fallback.json', JSON.stringify({ parity, counts: reports.map(r => r.counts) }, null, 2));
console.log(JSON.stringify(parity));
