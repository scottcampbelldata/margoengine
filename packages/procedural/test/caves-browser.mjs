import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { reference, islandGrid } from './caves-reference.js';

const fixture = new URL('./fixtures/caves/', import.meta.url),
  ref = JSON.parse(await readFile(new URL('reference.json', fixture))),
  initial = islandGrid(JSON.parse(await readFile(new URL('ne_110m_land.geojson', fixture))), ref);
const cases = [
  { width: 31, height: 27, seed: 0, steps: 7 },
  { width: 19, height: 17, depth: 11, seed: 0xffffffff, mode: 'islands', steps: 7 },
  { width: ref.width, height: ref.height, mode: 'islands', initial: [...initial], steps: 5 },
];
const dir = await mkdtemp(join(tmpdir(), 'margo-caves-'));
let browser, server;
try {
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><title>Cave values</title><script type="module" src="/main.js"></script>',
  );
  await writeFile(
    join(dir, 'main.js'),
    `import {createCaveGenerator} from '${fileURLToPath(new URL('../dist/caves.js', import.meta.url)).replaceAll('\\', '/')}';window.makeCaves=createCaveGenerator;`,
  );
  await build({
    root: dir,
    base: '/caves/',
    configFile: false,
    logLevel: 'error',
    build: { outDir: join(dir, 'dist') },
  });
  server = await preview({
    root: dir,
    base: '/caves/',
    configFile: false,
    logLevel: 'error',
    build: { outDir: join(dir, 'dist') },
    preview: { host: '127.0.0.1', port: 0 },
  });
  browser = await launchBrowser();
  const page = await browser.newPage(),
    errors = [],
    requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (/\.wasm(?:\?|$)/.test(r.url())) requests.push(r.url());
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => typeof window.makeCaves === 'function');
  assert.equal(requests.length, 0, 'entry import is inert');
  const results = await page.evaluate(async (cases) => {
    const results = [];
    for (const route of ['webgpu', 'webgl2']) {
      const canvas = document.createElement('canvas');
      let device, gl;
      if (route === 'webgpu') {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('Missing WebGPU adapter');
        device = await adapter.requestDevice();
        device.pushErrorScope('validation');
        canvas.getContext('webgpu').configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
      } else {
        gl = canvas.getContext('webgl2');
        if (!gl) throw new Error('Missing WebGL2 context');
      }
      const generator = await window.makeCaves();
      const options = cases.map((o) => ({ ...o, ...(o.initial ? { initial: Uint8Array.from(o.initial) } : {}) }));
      const before = options.map((o) => generator.generate(o));
      if (device) {
        const error = await device.popErrorScope();
        if (error) throw error;
        device.destroy();
        await device.lost;
      } else {
        const lost = new Promise((resolve) => canvas.addEventListener('webglcontextlost', resolve, { once: true }));
        gl.getExtension('WEBGL_lose_context').loseContext();
        await lost;
        if (!gl.isContextLost()) throw new Error('Context loss not observed');
      }
      const after = options.map((o) => generator.generate(o));
      const controller = new AbortController();
      controller.abort('exact-reason');
      let aborted = false,
        disposed = false;
      try {
        generator.generate({ signal: controller.signal });
      } catch (e) {
        aborted = e === 'exact-reason';
      }
      generator.dispose();
      generator[Symbol.dispose]();
      try {
        generator.generate();
      } catch (e) {
        disposed = e.code === 'disposed' && e.message.includes('https://');
      }
      if (!aborted || !disposed) throw new Error('Caves lifecycle failed');
      const replacement = await window.makeCaves();
      const fresh = options.map((o) => replacement.generate(o));
      replacement.dispose();
      const pack = (maps) => maps.map((m) => ({ ...m, cells: [...m.cells] }));
      results.push({ route, before: pack(before), after: pack(after), fresh: pack(fresh) });
    }
    return results;
  }, cases);
  assert.equal(new Set(requests).size, 1, 'exactly one feature-local lazy asset');
  for (const r of results) {
    assert.deepEqual(r.before, r.after, 'actual device/context loss preserves CPU results');
    assert.deepEqual(r.before, r.fresh, 'fresh independent instance matches');
    for (let i = 0; i < cases.length; i++) {
      assert.deepEqual(r.before[i].cells, [...reference(cases[i])]);
      assert.ok(r.before[i].stencilReads < r.before[i].directReads);
    }
  }
  assert.deepEqual(results[0].before, results[1].before);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      routes: results.map((r) => r.route),
      cases: cases.length,
      realReference: 'Natural Earth Madagascar',
      checkedCells: results[0].before.reduce((n, m) => n + m.cells.length, 0) * 6,
      loss: true,
      disposal: true,
      lazy: true,
      errors,
    }),
  );
} finally {
  await closeAll({ browser, servers: [server] });
  await rm(dir, { recursive: true, force: true });
}
