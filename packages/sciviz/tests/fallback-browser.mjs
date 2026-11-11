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
      const compat = await import('/packages/webgl2-compat/dist/index.js');
      let missing;
      try { await createFallbackFigure(canvas, { axes: false }); } catch (e) { missing = e; }
      if (!(missing instanceof TypeError) || !/compat: await import\('@margoengine\/webgl2-compat'\)/.test(missing.message))
        throw Error(`missing compat layer must name the fix: ${missing}`);
      const make = fallback ? (c, o) => createFallbackFigure(c, { ...o, compat }) : Figure.create;
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

// Figure.create on the layer (KB1405): axes, scatter, line and labels have no separate WebGL2 driver; the complete layer
// draws them. Each case is compared with native WebGPU under the bounds above, with the tick-label text, on the layer
// (MARGO_COMPAT style install) and on /tiers forced to half-float and LDR.
async function figureCases(mode) {
  const context = await openBrowser({
    startPath: '/packages/sciviz/tests/volume-quality.html', port: 'free', compat: mode === 'compat',
  });
  const errors = [];
  context.page.on('pageerror', e => errors.push(e.message));
  context.page.setDefaultTimeout(120000);
  try {
    const report = await context.page.evaluate(async (mode) => {
      globalThis.margoLow = 1;
      if (mode === 'half-float' || mode === 'ldr') {
        const { maskTier } = await import('/packages/webgl2-compat/test/support/mask-tier.js');
        const { installTiers } = await import('/packages/webgl2-compat/dist/tiers.js');
        const result = await installTiers({ force: true, createContext(attributes) {
          const gl = new OffscreenCanvas(1, 1).getContext('webgl2', attributes);
          if (!gl) throw Error('WebGL2 required for the tier run');
          return maskTier(gl, mode);
        } });
        if (!result.installed) throw Error(`tiers did not install: ${result.reason}`);
      }
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { fusionVolume } = await import('/packages/sciviz/dist/labels.js');
      const images = {}, ticks = {}, tiers = new Set();
      for (const name of ['axes', 'scatter', 'line', 'labels']) {
        const canvas = document.createElement('canvas');
        canvas.width = 192; canvas.height = 144; canvas.style.cssText = 'width:192px;height:144px';
        document.body.append(canvas);
        const f = await Figure.create(canvas, {
          axes: name === 'axes', controls: false, aspect: [1, 1, 1], limits: [0, 1, 0, 1, 0, 1],
        });
        f.engine.stop();
        f.engine.scene.background = '#000000';
        f.engine.camera.position = [1.7, 1.3, 2.6]; f.engine.camera.target = [0.5, 0.5, 0.5];
        const gpuErrors = [];
        f.renderer.device.addEventListener('uncapturederror', e => gpuErrors.push(e.error.message));
        tiers.add(f.renderer.device.adapter?.capabilities?.tier ?? 'native');
        try {
          const n = 400;
          if (name === 'scatter' || name === 'axes') {
            const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n), c = new Float32Array(n);
            for (let i = 0; i < n; i++) {
              const t = i / n; x[i] = t; y[i] = 0.5 + 0.4 * Math.sin(t * 25); z[i] = 0.5 + 0.4 * Math.cos(t * 25); c[i] = t;
            }
            await f.scatter({ x, y, z, color: c }, { size: 8 });
          } else if (name === 'line') {
            const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
            for (let i = 0; i < n; i++) {
              const t = i / (n - 1); x[i] = t; y[i] = 0.5 + 0.4 * Math.sin(t * 12); z[i] = 0.5 + 0.4 * Math.cos(t * 12);
            }
            await f.line({ x, y, z, color: x }, { width: 3 });
          } else if (name === 'labels') {
            const data = new Uint32Array(16 ** 3);
            for (let i = 0; i < data.length; i++) data[i] = i % 16 < 8 ? 16777217 : 16777218;
            fusionVolume(f, [{
              kind: 'labels', dims: [16, 16, 16], bounds: [0, 1, 0, 1, 0, 1], data,
              labels: [
                { id: 16777217, name: 'Left', rgba: [1, 0, 0, 0.5] },
                { id: 16777218, name: 'Right', rgba: [0, 0, 1, 0.5] },
              ],
            }]);
          }
          await f.ready(); f.render();
          const image = await createImageBitmap(canvas), copy = new OffscreenCanvas(canvas.width, canvas.height);
          const ctx = copy.getContext('2d'); ctx.drawImage(image, 0, 0); image.close();
          images[name] = Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
          ticks[name] = f.exportLayout().roots.map(e => e.textContent.trim()).filter(Boolean);
          if (gpuErrors.length) throw Error(`${name}: ${gpuErrors.join('; ')}`);
        } finally { f.dispose(); canvas.remove(); }
      }
      return { images, ticks, tiers: [...tiers] };
    }, mode);
    assert.deepEqual(errors, []);
    return report;
  } finally { await context.close(); }
}
const native = await figureCases('native');
const figureParity = [];
for (const mode of ['compat', 'half-float', 'ldr']) {
  const layer = await figureCases(mode);
  assert.deepEqual(native.tiers, ['native'], 'the reference runs on native WebGPU');
  assert.deepEqual(layer.tiers, [mode === 'compat' ? 'full' : mode], `${mode} run reports its tier`);
  for (const name of Object.keys(native.images)) {
    const a = native.images[name], b = layer.images[name];
    assert.equal(a.length, b.length);
    let sum = 0, over = 0, drawn = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(...[0, 1, 2].map(c => Math.abs(a[i + c] - b[i + c])));
      sum += d; if (d > 8) over++;
      if (Math.max(b[i], b[i + 1], b[i + 2]) > 20) drawn++;
    }
    const row = { mode, name, mean: sum / (a.length / 4), share: over / (a.length / 4), drawn };
    figureParity.push(row);
    assert(drawn > 100, `${mode} ${name} draws something: ${JSON.stringify(row)}`);
    assert(row.share <= 0.02 && row.mean <= 1, JSON.stringify(row));
    assert.deepEqual(layer.ticks[name], native.ticks[name], `${mode} ${name} tick text`);
  }
}
assert(native.ticks.axes.length > 3, 'the axes case has tick labels to compare');
parity.push(...figureParity);

await mkdir('test-results', { recursive: true });
await writeFile('test-results/sciviz-fallback.json', JSON.stringify({ parity, counts: reports.map(r => r.counts) }, null, 2));
console.log(JSON.stringify(parity));
