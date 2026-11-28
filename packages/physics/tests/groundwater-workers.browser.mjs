import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'groundwater-worker-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.groundwaterWorkers = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = ({ message }) => { worker.terminate(); reject(new Error(message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { followGroundwater } from '../../packages/physics/tests/fixtures/groundwater-workers.mjs';
    const BrowserWorker = globalThis.Worker;
    let starts = 0, stops = 0;
    globalThis.Worker = class extends BrowserWorker {
      constructor(url, config) { super(url, config); starts++; }
      terminate() { stops++; super.terminate(); }
    };
    async function verify() {
      const scalar = await followGroundwater(17, 13, 1);
      const parallel = await followGroundwater(17, 13, 4);
      return { isolated: crossOriginIsolated, helpers: [starts, stops], scalar, parallel };
    }
    void verify().then(
      result => postMessage(result),
      error => postMessage({ error: error.stack ?? String(error) }),
    );
  `,
  );
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: { target: 'es2022' },
    worker: { format: 'es' },
  });
  const assets = join(root, 'dist/assets');
  const files = await readdir(assets);
  for (const variant of ['groundwater-kernel', 'groundwater-kernel-shared']) {
    const match = files.filter(
      (name) =>
        name.startsWith(variant + '-') &&
        name.endsWith('.wasm') &&
        (variant !== 'groundwater-kernel' || !/^groundwater-kernel-shared-/.test(name)),
    );
    assert.equal(match.length, 1, `Keep ${variant} as a separate packaged Wasm asset.`);
    assert.deepEqual(
      await readFile(join(assets, match[0])),
      await readFile(new URL(`../dist/${variant}.wasm`, import.meta.url)),
    );
  }
  assert.equal(files.filter((name) => /^solver-phase-thread-.*\.js$/.test(name)).length, 1);
  const app = await preview({
    root,
    configFile: false,
    logLevel: 'warn',
    preview: {
      host: '127.0.0.1',
      port: 0,
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  });
  try {
    const { page, close } = await openBrowser({
      startPath: '/tools/shot/blank.html',
      port: 'free',
      softwareAdapterOk: true,
    });
    try {
      const address = app.httpServer.address();
      assert.ok(address && typeof address === 'object');
      await page.goto('http://127.0.0.1:' + address.port + '/');
      const result = await page.evaluate(() =>
        Promise.race([
          window.groundwaterWorkers,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged groundwater helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.ok(result.isolated);
      assert.deepEqual(result.helpers, [3, 3]);
      const { state, work } = result.parallel.accepted;
      assert.deepEqual(state, result.scalar.accepted.state);
      assert.deepEqual(result.parallel.accepted, result.parallel.replay);
      assert.deepEqual(result.scalar.accepted, result.scalar.replay);
      for (const port of Object.values(state.ports))
        assert.deepEqual(port.cell, [1_165_900_000, -1_048_500_000, 1_982_700_000]);
      assert.ok(state.budget.spring > 0 && state.budget.seepage > 0);
      assert.ok(state.wet.thickness > 0);
      const latest = work.at(-1);
      assert.equal(latest.threads, 4);
      assert.equal(latest.cells, 221);
      assert.equal(latest.faceConductances, 412);
      assert.equal(latest.pairedFaceConductances, 384);
      assert.deepEqual(latest.workers.map(({ cells }) => cells), [55, 55, 55, 56]);
      assert.ok(latest.workers.every(({ initialActiveSprings }) => initialActiveSprings > 0));
      console.log('HYDRO-06 packaged groundwater conductance work', state.snapshot.hash, latest);
    } finally {
      await close();
    }
  } finally {
    await app.close();
  }
} finally {
  // mkdtemp created this exact child of the ignored test-results directory.
  await rm(root, { recursive: true, force: true });
}
