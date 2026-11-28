import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';
import { forestCell } from './fixtures/forest-workers.mjs';

const founders = 31;
const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'forest-worker-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.forestWorkers = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = ({ message }) => { worker.terminate(); reject(new Error(message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { followForest } from '../../packages/biomes/tests/fixtures/forest-workers.mjs';
    const BrowserWorker = globalThis.Worker;
    let starts = 0, stops = 0;
    globalThis.Worker = class extends BrowserWorker {
      constructor(url, config) { super(url, config); starts++; }
      terminate() { stops++; super.terminate(); }
    };
    function equalRows(a, b) {
      return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
    }
    function equalStates(a, b) {
      return a.snapshot.hash === b.snapshot.hash &&
        equalRows(a.snapshot.bytes, b.snapshot.bytes) &&
        Object.entries(a.ports).every(([field, port]) =>
          equalRows(port.cell, b.ports[field].cell) && equalRows(port.words, b.ports[field].words)
        ) && JSON.stringify(a.trees) === JSON.stringify(b.trees);
    }
    async function verify() {
      const one = await followForest(${founders}, 1);
      const two = await followForest(${founders}, 2);
      const four = await followForest(${founders}, 4);
      const runs = [one, two, four];
      const state = one.accepted.state;
      return {
        isolated: crossOriginIsolated,
        helpers: [starts, stops],
        hash: state.snapshot.hash,
        exact: runs.every(({ accepted, replay }) =>
          equalStates(state, accepted.state) && equalStates(accepted.state, replay.state)
        ),
        trees: state.trees.length,
        cells: Object.values(state.ports).map(({ cell }) => cell),
        work: runs.map((run) => run.accepted.work),
      };
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
  for (const [variant, pattern] of [
    ['forest-kernel', /^forest-kernel-(?!shared-).*\.wasm$/],
    ['forest-kernel-shared', /^forest-kernel-shared-.*\.wasm$/],
  ]) {
    const matches = files.filter((name) => pattern.test(name));
    assert.equal(matches.length, 1, `Keep ${variant} as a separate packaged Wasm asset.`);
    assert.deepEqual(
      await readFile(join(assets, matches[0])),
      await readFile(new URL(`../dist/${variant}.wasm`, import.meta.url)),
    );
  }
  const workerAssets = files.filter((name) => /^growth-shadow-.*\.js$/.test(name));
  assert.equal(workerAssets.length, 1);
  assert.deepEqual(
    await readFile(join(assets, workerAssets[0])),
    await readFile(new URL('../dist/workers/growth-shadow.js', import.meta.url)),
  );
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
          window.forestWorkers,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged forest helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.ok(result.isolated);
      assert.deepEqual(result.helpers, [4, 4]);
      assert.ok(result.exact);
      assert.ok(result.trees > 10);
      assert.ok(result.cells.length > 0);
      for (const cell of result.cells) assert.deepEqual(cell, forestCell);
      for (const [i, threads] of [1, 2, 4].entries()) {
        for (const { receipt, expected } of result.work[i]) {
          assert.deepEqual(receipt, expected);
          assert.equal(receipt.threads, threads);
          assert.ok(receipt.workers.every((worker) => worker.pairedOverlaps > 0));
        }
      }
      console.log('BIO-03 packaged forest shade work', result.hash, JSON.stringify(result.work[2].at(-1).receipt));
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
