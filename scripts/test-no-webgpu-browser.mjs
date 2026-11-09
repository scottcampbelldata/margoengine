// What a visitor without WebGPU sees, in a real browser (headless Edge, else bundled Chromium) with WebGPU removed:
//   1. every page of site/dist that runs a module script (each live demo and the landing page) loads the WebGL2
//      compatibility layer from examples/needs-webgpu.js and runs on it (or, for a page that draws nothing, loads
//      nothing), and throws no uncaught error, both with navigator.gpu missing and with requestAdapter() answering
//      null; with WebGL2 missing as well, each demo shows the shared "needs WebGPU" message instead;
//   2. with WebGPU, no page downloads any of the layer (a browser with WebGPU gets zero bytes of it);
//   3. the @margoengine/webgl2-compat/preview preview draws a basic scene (two coloured boxes, one light): pixels are read back.
// How each demo looks on the layer against native WebGPU is scripts/visual-compat.mjs's job.
// Part of `npm run check:merge`, after `npm run build:site`. Takes the GPU lock itself:
//   npm run check:no-webgpu
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { launchBrowser, resolveBrowser } from './lib/browser.mjs';
import { createServer, preview } from 'vite';
import { acquire } from './gpu-lock.mjs';
import { message } from '../examples/needs-webgpu.js';
import { keptOffLayer } from './support/kept-off-layer.js';
import { closeAll } from './support/shutdown.mjs';

/** Bytes of a built chunk plus every chunk it imports statically (`from "./x.js"`), each counted once. */
async function codeBytes(folder, chunk, seen = new Set()) {
  if (seen.has(chunk)) return 0;
  seen.add(chunk);
  const code = await readFile(join(folder, chunk), 'utf8');
  let bytes = code.length;
  for (const [, dep] of code.matchAll(/from\s*["']\.\/([^"']+\.js)["']/g))
    bytes += await codeBytes(folder, join(dirname(chunk), dep), seen);
  return bytes;
}

const root = resolve(import.meta.dirname, '..'),
  dist = join(root, 'site/dist'),
  // Pages with a module script that draw nothing: no demo code to import and no message to show.
  NO_SCENE = new Set(['index.html', 'gallery/index.html']);
// The two ways a browser lacks WebGPU: no `navigator.gpu` at all, or one whose adapter request answers null.
const modes = {
  'no navigator.gpu': () => {
    delete Navigator.prototype.gpu;
    if (globalThis.WorkerNavigator) delete WorkerNavigator.prototype.gpu;
  },
  'no adapter': () => {
    if (navigator.gpu) navigator.gpu.requestAdapter = async () => null;
  },
  // Below the layer's minimum as well: no WebGPU and no WebGL2 (an old browser, or WebGL switched off).
  'no WebGPU, no WebGL2': () => {
    delete Navigator.prototype.gpu;
    if (globalThis.WorkerNavigator) delete WorkerNavigator.prototype.gpu;
    for (const Canvas of [globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas].filter(Boolean)) {
      const get = Canvas.prototype.getContext;
      Canvas.prototype.getContext = function (type, ...rest) {
        return type === 'webgl2' ? null : get.call(this, type, ...rest);
      };
    }
  },
};
// A string only the layer's root entry holds (its extension list): a script response with it is the layer's code.
const LAYER_MARK = 'WEBGL_draw_instanced_base_vertex_base_instance';
// Pages that load the layer on purpose with WebGPU too: the dual viewport draws one scene natively and on the layer.
const BOTH_PATHS = new Set(['demos/dual-viewport.html']);
// Pages kept off the layer (`needsWebGPU(area, { layer: false })`) while docs/known-bugs.md lists them as wrong there:
// without WebGPU they show the message, as without WebGL2. Read from each built page, so the list cannot go stale.
const NOT_ON_LAYER = new Set();

async function pages() {
  const found = [];
  for (const entry of await readdir(dist, { recursive: true })) {
    const path = entry.replaceAll('\\', '/');
    if (!path.endsWith('.html') || path.startsWith('catalog/')) continue;
    if (/<script[^>]*type="module"/.test(await readFile(join(dist, path), 'utf8'))) found.push(path);
  }
  return found.sort();
}

// The page is made WebGPU-less by an init script, so any browser can run this, Firefox included.
function launch() {
  return launchBrowser({ headless: true, needs: 'none' });
}

const release = await acquire({ owner: 'no-webgpu-browser' });
let browser, site, dev;
try {
  const demos = await pages();
  // Every demo built by scripts/build-site.js; a page that drops out of the list is a test failure, not a skip.
  for (const expected of [
    'night-citadel/index.html',
    'gameplay-sandbox/index.html',
    'voxel/index.html',
    'gallery/khronos.html',
  ])
    assert.ok(demos.includes(expected), `site/dist has no ${expected}: run npm run build:site first`);
  // With WebGPU the page imports the demo's own code; a build that tree-shook it to nothing ships a blank demo.
  for (const path of demos) {
    const html = await readFile(join(dist, path), 'utf8'),
      entry = /<script[^>]*type="module"[^>]*src="\.\/([^"]+)"/.exec(html)?.[1],
      folder = join(dist, path, '..');
    if (!entry || NO_SCENE.has(path)) continue;
    const code = await readFile(join(folder, entry), 'utf8'),
      imports = [...code.matchAll(/import\(`\.\/([^`]+\.js)`\)/g)];
    if (keptOffLayer(code)) NOT_ON_LAYER.add(path);
    assert.ok(imports.length, `${path}: imports no demo code`);
    for (const [, chunk] of imports) {
      // The demo's chunk and the shared chunks it imports statically: a small demo built on packages keeps their code
      // in shared chunks, while a demo tree-shaken to nothing has neither.
      const bytes = await codeBytes(join(folder, dirname(entry)), chunk);
      assert.ok(
        bytes > 2000,
        `${path}: the demo code it imports, ${chunk}, is ${bytes} B with its imports: tree-shaken away?`,
      );
    }
  }
  site = await preview({
    configFile: false,
    root,
    build: { outDir: 'site/dist' },
    preview: { port: 0, strictPort: true },
    logLevel: 'error',
  });
  const origin = new URL(site.resolvedUrls.local[0]).origin;
  browser = await launch();
  const report = [];
  // The zero-download check needs a browser with WebGPU (Firefox in Playwright has none: that mode is left out there).
  const chosen = resolveBrowser(),
    withWebGPU = chosen.webgpu ? [['WebGPU', null]] : [];
  if (!withWebGPU.length) report.push(`WebGPU mode skipped: no WebGPU in ${chosen.name}`);
  for (const [mode, strip] of [...withWebGPU, ...Object.entries(modes)])
    for (const path of demos) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      if (strip) await context.addInitScript(strip);
      const page = await context.newPage(),
        errors = [],
        layer = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', async (response) => {
        if (!new URL(response.url()).pathname.endsWith('.js')) return;
        const body = await response.text().catch(() => '');
        if (body.includes(LAYER_MARK)) layer.push(response.url());
      });
      await page.goto(`${origin}/${path}`, { waitUntil: 'load' });
      const landing = NO_SCENE.has(path);
      if (mode === 'WebGPU' || (mode !== 'no WebGPU, no WebGL2' && !landing && !NOT_ON_LAYER.has(path))) {
        // With WebGPU nothing of the layer loads; without it the page installs the layer and the demo starts on it.
        const compat = mode !== 'WebGPU';
        const installed = compat
          ? await page
              .waitForFunction(() => 'webgpuCompat' in document.documentElement.dataset, null, { timeout: 60_000 })
              .then(() => true)
              .catch(() => false)
          : // fixed-wait: proves an absence (the layer never installs), so there is no event to wait for
            (await page.waitForTimeout(3000),
            await page.evaluate(() => 'webgpuCompat' in document.documentElement.dataset));
        // Let the demo start on the layer (its first frames, a refusal) and any quiet failure surface.
        // fixed-wait: proves an absence (no late error or refusal after the install), so there is no event to wait for
        if (compat) await page.waitForTimeout(3000);
        const messages = await page.locator('[data-no-webgpu]').count();
        await context.close();
        assert.equal(installed, compat, `${path} (${mode}): the WebGL2 layer ${compat ? 'must' : 'must not'} install`);
        assert.equal(messages, 0, `${path} (${mode}): no needs-WebGPU message`);
        if (compat) assert.ok(layer.length > 0, `${path} (${mode}): the layer's code was downloaded`);
        else if (BOTH_PATHS.has(path)) assert.ok(layer.length > 0, `${path} (${mode}): draws on the layer too`);
        else assert.deepEqual(layer, [], `${path} (${mode}): a browser with WebGPU downloads none of the layer`);
        assert.deepEqual(errors, [], `${path} (${mode}): no uncaught error`);
        report.push(
          `${mode.padEnd(20)} ${path.padEnd(36)} ${compat ? 'runs on the WebGL2 layer' : 'native, layer not downloaded'}`,
        );
        continue;
      }
      const shown = await page
        .waitForSelector('[data-no-webgpu]', { state: 'visible', timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      const text = shown ? await page.locator('[data-no-webgpu] p').textContent() : null,
        box = shown ? await page.locator('[data-no-webgpu]').boundingBox() : null,
        link = shown ? await page.locator('[data-no-webgpu] a').getAttribute('href') : null;
      // Let a quiet failure (a rejected import, a throw after the message) surface before judging the page.
      await page.waitForTimeout(500);
      await context.close();
      if (landing) assert.equal(shown, false, `${path} (${mode}): this page draws nothing, so shows no message`);
      else {
        assert.equal(text, message, `${path} (${mode}): the needs-WebGPU message must show`);
        assert.ok(box.width >= 300 && box.height >= 150, `${path} (${mode}): the message must cover the canvas area`);
        assert.equal(link, 'https://margoengine.com/webgpu.html', `${path} (${mode}): help link`);
      }
      assert.deepEqual(errors, [], `${path} (${mode}): no uncaught error`);
      report.push(`${mode.padEnd(20)} ${path.padEnd(36)} ${landing ? 'no scene, no message' : 'message shown'}`);
    }

  // The WebGL2 preview in a real browser: sources served by Vite (the packages' dist builds).
  dev = await (
    await createServer({
      configFile: false,
      root,
      logLevel: 'error',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { port: 0, hmr: false, watch: null },
    })
  ).listen();
  const context = await browser.newContext();
  await context.addInitScript(modes['no navigator.gpu']);
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${new URL(dev.resolvedUrls.local[0]).origin}/site/webgpu.html`);
  const drawn = await page.evaluate(async () => {
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
    const { webglRenderer } = await import('/packages/webgl2-compat/dist/preview.js');
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 64;
    canvas.style.cssText = 'width:96px;height:64px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      fallback: webglRenderer,
      camera: { position: [0, 0, 6], target: [0, 0, 0], near: 0.1, far: 100 },
    });
    engine
      .createMesh()
      .setGeometry(box(1.6, 1.6, 1.6))
      .setMaterial(new PbrMaterial({ color: [1, 0.05, 0.05], roughness: 0.6 }))
      .setPosition([-1.4, 0, 0]);
    engine
      .createMesh()
      .setGeometry(box(1.6, 1.6, 1.6))
      .setMaterial(new PbrMaterial({ color: [0.05, 0.05, 1], roughness: 0.6 }))
      .setPosition([1.4, 0, 0]);
    engine.render();
    // Read in the same task as the draw, before the browser presents and clears the drawing buffer.
    const gl = canvas.getContext('webgl2'),
      pixels = new Uint8Array(96 * 64 * 4);
    gl.readPixels(0, 0, 96, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const at = (x, y) => [...pixels.subarray(((63 - y) * 96 + x) * 4, ((63 - y) * 96 + x) * 4 + 3)];
    const result = {
      backend: engine.backend,
      reason: engine.fallbackReason,
      left: at(26, 32),
      right: at(70, 32),
      corner: at(1, 1),
    };
    engine.dispose();
    return result;
  });
  await context.close();
  assert.equal(drawn.backend, 'webgl2');
  assert.match(drawn.reason, /adapter unavailable/);
  const [lr, lg, lb] = drawn.left,
    [rr, rg, rb] = drawn.right;
  assert.ok(lr > 40 && lr > 2 * lg && lr > 2 * lb, `left box draws red, got ${drawn.left}`);
  assert.ok(rb > 40 && rb > 2 * rr && rb > 2 * rg, `right box draws blue, got ${drawn.right}`);
  assert.notDeepEqual(drawn.corner, drawn.left, 'the corner keeps the clear colour');
  assert.deepEqual(errors, [], 'the preview page throws no uncaught error');
  report.push(`WebGL2 preview: left ${drawn.left}, right ${drawn.right}, corner ${drawn.corner}`);
  console.log(report.join('\n'));
  console.log(
    `no-WebGPU check passed: ${demos.length} pages x ${Object.keys(modes).length + 1} modes, ${relative(root, dist)}`,
  );
} finally {
  await closeAll({ browser, servers: [site, dev] });
  release();
}
