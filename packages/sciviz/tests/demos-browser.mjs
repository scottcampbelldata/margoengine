// Real-data demos and the retained synthetic API test pages, on both renderers and both requested layouts.
// Run through scripts/gpu-lock.mjs; the parent gives the entire job a hard process-tree limit.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

// npm runs this from packages/sciviz; Vite must serve the repository in either invocation.
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const reports = [];
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
await mkdir('test-results/sciviz-demos', { recursive: true });

async function image({ path, key = 'figure' }) {
  const { [key]: figure } = await import(path);
  const blob = await figure.toPNG({ overlays: false });
  const bitmap = await createImageBitmap(blob);
  const copy = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = copy.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
  let lit = 0,
    hash = 2166136261;
  const colours = new Set();
  const columns = new Uint32Array(24);
  // Central 60%: exclude axes, labels and the colour bar as proof that the data itself draws.
  for (let y = Math.floor(copy.height * 0.2); y < copy.height * 0.8; y += 2) {
    for (let x = Math.floor(copy.width * 0.2); x < copy.width * 0.8; x += 2) {
      const k = (y * copy.width + x) * 4;
      const r = pixels[k],
        g = pixels[k + 1],
        b = pixels[k + 2];
      hash = Math.imul(hash ^ r ^ (g << 8) ^ (b << 16), 16777619);
      if (Math.max(r, g, b) > 65) {
        lit++;
        colours.add((r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3));
        columns[Math.min(23, Math.floor(((x / copy.width - 0.2) / 0.6) * 24))]++;
      }
    }
  }
  return { lit, colours: colours.size, profiles: new Set(columns).size, hash };
}

async function monitor(path) {
  const { figure = null, fig3d = null } = await import(path);
  const fig = figure ?? fig3d;
  const engine = fig.engine;
  const render = engine.render.bind(engine);
  const results = (globalThis.scivizFrames = []);
  const pixels = (globalThis.scivizFramePixels = []);
  const copy = new OffscreenCanvas(160, 100);
  const ctx = copy.getContext('2d', { willReadFrequently: true });
  engine.render = (...args) => {
    const result = render(...args);
    results.push(fig.layers.filter((layer) => layer.visible !== false).length);
    ctx.drawImage(engine.canvas, 0, 0, copy.width, copy.height);
    const data = ctx.getImageData(32, 20, 96, 60).data;
    let lit = 0;
    for (let k = 0; k < data.length; k += 4) if (Math.max(data[k], data[k + 1], data[k + 2]) > 65) lit++;
    pixels.push(lit);
    return result;
  };
}

async function run(compat) {
  const context = await openBrowser({ startPath: '/packages/sciviz/tests/sciviz.html', port: 5267, compat });
  const { page, hardware } = context;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.setDefaultTimeout(120_000);
  const select = (id, value) => page.selectOption(`#${id}`, value);
  const input = (id, value) =>
    page.evaluate(
      ({ id, value }) => {
        const el = document.getElementById(id);
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      { id, value },
    );
  const settled = (path) =>
    page.evaluate(async (path) => {
      const module = await import(path);
      await module.settled;
      await module.work;
      await module.figure?.ready();
    }, path);
  const structure = async (path, key) => {
    const summary = await page.evaluate(image, { path, key });
    assert.ok(summary.lit > 100, `${path}: data pixels ${JSON.stringify(summary)}`);
    // A single-colour histogram demonstrates structure through varying bar heights, not a colour palette.
    assert.ok(
      key === 'histogram' ? summary.profiles > 8 : summary.colours > 12,
      `${path} ${key ?? 'figure'}: image lacks structure ${JSON.stringify(summary)}`,
    );
    return summary.hash;
  };
  const download = async (id) => {
    const event = page.waitForEvent('download');
    await page.click(`#${id}`);
    const file = await event;
    assert.equal(await file.failure(), null);
    assert.match(file.suggestedFilename(), /\.(png|svg)$/);
    const stream = await file.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.ok(Buffer.concat(chunks).length > 1000, `${id}: export has content`);
  };
  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      for (const name of ['head', 'stars', 'wind', 'aeroflow', 'astrometrics', 'medical', 'showcase']) {
        if (only && !only.split(',').includes(name)) continue;
        const fixture = ['aeroflow', 'astrometrics', 'medical', 'showcase'].includes(name);
        const path = `${fixture ? '/packages/sciviz/tests/pages' : '/examples'}/sciviz-${name}.ts`;
        await page.goto(new URL(path.replace('.ts', '.html'), page.url()).href);
        if (name !== 'showcase') {
          await page.waitForFunction(() => document.querySelector('canvas[data-ready="true"],canvas[data-error]'));
          assert.equal(
            await page.locator('canvas[data-error]').count(),
            0,
            await page.locator('#status').textContent(),
          );
          await page.waitForFunction(() => (globalThis.__margoPipelines?.pending ?? 0) === 0);
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${name}: horizontal overflow at ${viewport.width}`,
        );
        if (name === 'head' || name === 'stars') {
          await settled(path);
          await page.evaluate(async (path) => {
            const m = await import(path);
            m.figure.render();
          }, path);
          const labels = await page.locator('[data-axis]').evaluateAll((elements) =>
            elements
              .filter((el) => getComputedStyle(el).display !== 'none')
              .map((el) => {
                const r = el.getBoundingClientRect();
                return {
                  text: el.textContent,
                  title: el.dataset.axisTitle === 'true',
                  axis: el.dataset.axis,
                  x: r.x,
                  y: r.y,
                  w: r.width,
                  h: r.height,
                };
              }),
          );
          assert.equal(labels.filter((l) => l.title).length, 3, 'all axis titles are visible');
          for (const axis of ['x', 'y', 'z'])
            assert.ok(
              labels.some((l) => l.axis === axis && !l.title),
              `${name}: ${axis} ticks visible`,
            );
          for (let i = 0; i < labels.length; i++) {
            const a = labels[i];
            assert.ok(
              a.x >= 0 && a.y >= 0 && a.x + a.w <= viewport.width && a.y + a.h <= viewport.height,
              `${name}: clipped label ${JSON.stringify(a)}`,
            );
            for (const b of labels.slice(i + 1)) {
              const dx = Math.max(a.x - b.x - b.w, b.x - a.x - a.w),
                dy = Math.max(a.y - b.y - b.h, b.y - a.y - a.h);
              assert.ok(
                Math.max(dx, dy) >= 7.9,
                `${name} ${viewport.width}: labels need 8 CSS pixels of clearance: ${JSON.stringify({ a, b, dx, dy })}`,
              );
            }
          }
          const bars = await page.locator('[aria-label^="Colour scale"]').evaluateAll((elements) =>
            elements
              .flatMap((el) => [el, ...el.querySelectorAll('span')])
              .map((el) => {
                const r = el.getBoundingClientRect();
                return { x: r.x, y: r.y, w: r.width, h: r.height };
              }),
          );
          for (const a of labels)
            for (const b of bars) {
              const dx = Math.max(a.x - b.x - b.w, b.x - a.x - a.w),
                dy = Math.max(a.y - b.y - b.h, b.y - a.y - a.h);
              assert.ok(
                Math.max(dx, dy) >= 7.9,
                `${name}: axis label overlaps the colour bar ${JSON.stringify({ a, b, dx, dy })}`,
              );
            }
          await page.screenshot({
            path: `test-results/sciviz-fixes/${name}-${compat ? 'webgl2' : 'webgpu'}-${viewport.width}.png`,
          });
        }
        if (name === 'head') {
          const hashes = [await structure(path)];
          await select('view', 'slice');
          for (const axis of ['x', 'y', 'z']) {
            await select('axis', axis);
            await settled(path);
            hashes.push(await structure(path));
          }
          for (const value of [20, 80, 45]) await input('position', value);
          await settled(path);
          await select('view', 'surface');
          for (const value of [180, 420, 300]) await input('level', value);
          await settled(path);
          hashes.push(await structure(path));
          const surface = await page.evaluate(async (path) => {
            const m = await import(path);
            return { level: m.surface.level, triangles: m.surface.triangles, layers: m.figure.layers.length };
          }, path);
          assert.equal(surface.level, 300);
          assert.ok(surface.triangles > 1000);
          assert.equal(surface.layers, 2);
          assert.equal(new Set(hashes).size, hashes.length, 'volume, each slice and surface show different structures');
          await select('view', 'volume');
          await settled(path);
          await download('export');
        } else if (name === 'stars') {
          await structure(path);
          await structure(path, 'histogram');
          assert.equal(await page.evaluate(async (path) => (await import(path)).cloud.count, path), 1_000_000);
          await page.evaluate(monitor, path);
          await page.uncheck('#edl');
          await page.check('#edl');
          await settled(path);
          for (const mode of ['box', 'lasso']) {
            await select('drag', mode);
            const box = await page.locator('#viewport').boundingBox();
            await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.42);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.42, { steps: 3 });
            await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.58, { steps: 3 });
            if (mode === 'lasso')
              await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.58, { steps: 3 });
            await page.mouse.up();
            await settled(path);
            const selected = await page.evaluate(async (path) => (await import(path)).selected, path);
            assert.ok(selected > 0 && selected < 1_000_000, `${mode}: subset ${selected}`);
            const counts = await page.evaluate(async (path) => {
              const m = await import(path);
              const indices = m.figure.selection.points.find((p) => p.layer === m.cloud).indices;
              let expected = 0;
              for (const i of indices) if (m.cloud.values[i] >= -0.5 && m.cloud.values[i] <= 3) expected++;
              return { expected, actual: Array.from(m.bars.values).reduce((sum, n) => sum + n, 0) };
            }, path);
            assert.equal(
              counts.actual,
              counts.expected,
              `${mode}: histogram counts exactly the selected observations in range`,
            );
          }
          await page.click('#reset');
          await settled(path);
          assert.equal(await page.evaluate(async (path) => (await import(path)).selected, path), 1_000_000);
          await select('drag', 'orbit');
          await download('export');
          const frames = await page.evaluate(() => globalThis.scivizFrames);
          assert.ok(
            frames.length > 0 && frames.every((n) => n === 1),
            'cloud replacement never leaves an empty or duplicate trace',
          );
        } else if (name === 'wind') {
          const first = await structure(path);
          await page.evaluate(monitor, path);
          for (const day of [3, 1, 7]) await input('day', day);
          await page.evaluate(async (path) => {
            const m = await import(path);
            await m.timeline.seek(7);
          }, path);
          assert.notEqual(await structure(path), first, 'different NOAA dates render different flow');
          await input('day', 0);
          await page.click('#play');
          await page.waitForFunction(() => document.getElementById('date').textContent >= '2024-01-04');
          await page.click('#play');
          assert.equal(await page.locator('#play').textContent(), 'Play');
          // Each sampled displayed frame has real strokes, including during playback.
          for (const day of [1, 4, 6]) {
            await page.evaluate(async ({ path, day }) => (await import(path)).timeline.seek(day), { path, day });
            await structure(path);
          }
          const frames = await page.evaluate(() => globalThis.scivizFrames);
          assert.ok(
            frames.length > 5 && frames.every((n) => n === 2),
            'wind playback and fast seeks keep exactly two traces',
          );
          const pixels = await page.evaluate(() => globalThis.scivizFramePixels);
          assert.ok(
            pixels.every((n) => n > 20),
            `wind never displays an empty frame: ${JSON.stringify(pixels)}`,
          );
          await download('export');
        } else if (name === 'aeroflow') {
          await page.evaluate(monitor, path);
          await page.evaluate(async (path) => {
            const m = await import(path);
            await Promise.all([m.updateVisualization(4), m.updateVisualization(12), m.updateVisualization(20)]);
          }, path);
          await select('modelSelect', 'karman');
          await select('directionSelect', 'forward');
          await page.evaluate(async (path) => (await import(path)).updateVisualization(21), path);
          await structure(path);
          const counts = await page.evaluate(() => globalThis.scivizFrames);
          assert.ok(counts.length && counts.every((n) => n === 3), 'synthetic flow swaps keep exactly three traces');
          const pixels = await page.evaluate(() => globalThis.scivizFramePixels);
          assert.ok(
            pixels.every((n) => n > 20),
            'synthetic wind never displays an empty frame',
          );
          await download('btnExportSVG');
          await download('btnExportPNG');
        } else if (name === 'astrometrics') {
          await page.evaluate(monitor, path);
          await select('colorBySelect', 'doppler');
          await page.uncheck('#edlCheck');
          await page.evaluate(async (path) => {
            const m = await import(path);
            await m.update3DLayer();
            await m.updateHistogram(null);
          }, path);
          await structure(path, 'fig3d');
          assert.equal(await page.evaluate(async (path) => (await import(path)).figHist.layers.length, path), 1);
          await download('btnExport3D');
        } else if (name === 'medical') {
          for (const dataset of ['nifti', 'head', 'phantom']) {
            await select('datasetSelect', dataset);
            await settled(path);
            await structure(path);
          }
          await page.check('#isoCheck');
          for (const threshold of [40, 70, 55]) await input('isoThreshold', threshold);
          await settled(path);
          assert.equal(await page.evaluate(async (path) => (await import(path)).figure.layers.length, path), 2);
          await download('btnExportPNG');
        } else {
          assert.equal(await page.locator('.showcase-card').count(), 3);
          for (const href of await page.locator('.showcase-card').evaluateAll((links) => links.map((a) => a.href))) {
            assert.equal((await page.request.get(href)).status(), 200);
          }
        }
        assert.deepEqual(errors, [], `${name}: browser errors`);
        await page.screenshot({
          path: `test-results/sciviz-demos/${name}-${compat ? 'webgl2' : 'webgpu'}-${viewport.width}.png`,
        });
        reports.push({ name, compat, viewport });
        console.log(`ok ${compat ? 'WebGL2' : 'WebGPU'} ${viewport.width} ${name}`);
      }
    }
    return hardware;
  } finally {
    await context.close();
  }
}

const hardware = await run(false);
await run(true);
await writeFile('test-results/sciviz-demos/report.json', JSON.stringify({ hardware, reports }, null, 2));
console.log(`${reports.length} sciviz demo/layout/backend checks passed`);
