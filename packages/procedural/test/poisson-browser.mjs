import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const dir = await mkdtemp(join(tmpdir(), 'margo-poisson-'));
let browser, server;
try {
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><title>Poisson backend values</title><script type="module" src="/main.js"></script>',
  );
  await writeFile(
    join(dir, 'main.js'),
    `import {createPoissonSampler} from '@margoengine/procedural/poisson';
     import {createDungeonGenerator} from '@margoengine/procedural/dungeon';
     window.makeSampler = createPoissonSampler; window.makeDungeon = createDungeonGenerator;`,
  );
  await build({
    root: dir,
    base: '/sampling/',
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: {
        '@margoengine/procedural/poisson': fileURLToPath(new URL('../dist/poisson.js', import.meta.url)),
        '@margoengine/procedural/dungeon': fileURLToPath(new URL('../dist/dungeon.js', import.meta.url)),
      },
    },
    build: { outDir: join(dir, 'dist') },
  });
  server = await preview({
    root: dir,
    base: '/sampling/',
    configFile: false,
    logLevel: 'error',
    build: { outDir: join(dir, 'dist') },
    preview: { host: '127.0.0.1', port: 0 },
  });
  browser = await launchBrowser();
  const page = await browser.newPage(),
    errors = [],
    wasmRequests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (/\.wasm(?:\?|$)/.test(r.url())) wasmRequests.push(r.url());
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => typeof window.makeSampler === 'function');
  assert.equal(wasmRequests.length, 0, 'importing the entry downloads no Wasm');
  const result = await page.evaluate(async () => {
    const output = [];
    for (const route of ['webgpu', 'webgl2']) {
      const canvas = document.createElement('canvas');
      let device, gl;
      if (route === 'webgpu') {
        device = await (await navigator.gpu.requestAdapter()).requestDevice();
        device.pushErrorScope('validation');
        canvas.getContext('webgpu').configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
      } else {
        gl = canvas.getContext('webgl2');
        if (!gl) throw new Error('WebGL2 context missing');
      }
      const sampler = await window.makeSampler();
      const dungeon = await window.makeDungeon();
      const dungeonOptions = { width: 32, height: 24, maxRooms: 12, seed: 7 };
      const layout = dungeon.generate(dungeonOptions);
      const options = { radius: 0.2, attempts: 5000, seed: 39 };
      const a = sampler.rectangle([-2, -2, 2, 2], options);
      const surface = sampler.surface(new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), options);
      if (device) {
        const error = await device.popErrorScope();
        if (error) throw error;
        device.destroy();
        await device.lost;
      } else {
        const lost = new Promise((resolve) => canvas.addEventListener('webglcontextlost', resolve, { once: true }));
        gl.getExtension('WEBGL_lose_context').loseContext();
        await lost;
        if (!gl.isContextLost()) throw new Error('Context loss was not observed');
      }
      const after = sampler.rectangle([-2, -2, 2, 2], options);
      const dungeonAfter = dungeon.generate(dungeonOptions);
      dungeon.dispose();
      dungeon.dispose();
      let dungeonDisposed = false;
      try {
        dungeon.generate();
      } catch (e) {
        dungeonDisposed = e.code === 'disposed';
      }
      if (!dungeonDisposed) throw new Error('Disposed dungeon generator accepted work');
      sampler.dispose();
      sampler.dispose();
      let disposed = false;
      try {
        sampler.rectangle([-2, -2, 2, 2], options);
      } catch (e) {
        disposed = e.code === 'disposed';
      }
      if (!disposed) throw new Error('Disposed sampler accepted work');
      output.push({
        route,
        points: [...a.positions],
        surface: [...surface.positions],
        after: [...after.positions],
        dungeon: { cells: [...layout.cells], rooms: layout.rooms, corridors: layout.corridors },
        dungeonAfter: [...dungeonAfter.cells],
      });
    }
    return output;
  });
  assert.equal(new Set(wasmRequests).size, 2, 'one independent lazy asset per feature');
  assert.deepEqual(result[0].points, result[1].points);
  assert.deepEqual(result[0].dungeon, result[1].dungeon);
  for (const r of result) {
    const { cells, rooms, corridors } = r.dungeon;
    assert.deepEqual(r.dungeonAfter, cells);
    assert.ok(rooms.length > 1);
    assert.equal(corridors.length, rooms.length - 1);
    assert.ok(cells.every((v) => v === 0 || v === 1));
    const seen = new Set([cells.indexOf(1)]),
      queue = [...seen];
    for (let i = 0; i < queue.length; i++)
      for (const next of [queue[i] - 1, queue[i] + 1, queue[i] - 32, queue[i] + 32])
        if (next >= 0 && next < cells.length && cells[next] && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
    assert.equal(
      seen.size,
      cells.reduce((a, b) => a + b, 0),
    );
    for (let y = 0; y < 24; y++)
      for (let x = 0; x < 32; x++) if (!x || !y || x === 31 || y === 23) assert.equal(cells[y * 32 + x], 0);
    assert.deepEqual(r.after, r.points);
    assert.ok(r.points.length > 300);
    for (const [p, d] of [
      [r.points, 2],
      [r.surface, 3],
    ])
      for (let i = 0; i < p.length; i += d) {
        if (d === 3) {
          assert.equal(p[i + 2], 0);
          assert.ok(p[i] >= 0 && p[i + 1] >= 0 && p[i] + p[i + 1] <= 2);
        }
        for (let j = 0; j < i; j += d) {
          let squared = 0;
          for (let k = 0; k < d; k++) squared += (p[i + k] - p[j + k]) ** 2;
          assert.ok(squared >= 0.2 ** 2);
        }
      }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      routes: result.map((r) => r.route),
      points: result[0].points.length / 2,
      surfacePoints: result[0].surface.length / 3,
      dungeonRooms: result[0].dungeon.rooms.length,
      lazyWasm: true,
      deviceLossIndependent: true,
      errors,
    }),
  );
} finally {
  await closeAll({ browser, servers: [server] });
  await rm(dir, { recursive: true, force: true });
}
