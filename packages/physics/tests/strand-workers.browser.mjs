import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';
import { expectedStrandWork, strandCell } from './fixtures/strand-workers.mjs';

const guides = 1025;
const pointsPerGuide = 3;
const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'strand-worker-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.strandWorkers = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = ({ message }) => { worker.terminate(); reject(new Error(message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { equalStrandState, followStrands } from '../../packages/physics/tests/fixtures/strand-workers.mjs';
    const BrowserWorker = globalThis.Worker;
    let starts = 0, stops = 0;
    globalThis.Worker = class extends BrowserWorker {
      constructor(url, config) { super(url, config); starts++; }
      terminate() { stops++; super.terminate(); }
    };
    async function verify() {
      const runs = [];
      for (const threads of [1, 2, 4]) runs.push(await followStrands(${guides}, ${pointsPerGuide}, threads));
      const state = runs[0].accepted.state;
      return {
        isolated: crossOriginIsolated,
        helpers: [starts, stops],
        hash: state.snapshot.hash,
        exact: runs.every(({ accepted, replay }) =>
          equalStrandState(state, accepted.state) && equalStrandState(accepted.state, replay.state)
        ),
        reciprocated: state.pending[0] > 0 && state.pending[5] < 0 && state.spin < 0 && state.tip !== 0,
        cells: state.cells,
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
    ['strand-kernel', /^strand-kernel-(?!shared-).*\.wasm$/],
    ['strand-kernel-shared', /^strand-kernel-shared-.*\.wasm$/],
  ]) {
    const matches = files.filter((name) => pattern.test(name));
    assert.equal(matches.length, 1, `Keep ${variant} as a separate packaged Wasm asset.`);
    assert.deepEqual(
      await readFile(join(assets, matches[0])),
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
      await page.goto(`http://127.0.0.1:${address.port}/`);
      const result = await page.evaluate(() =>
        Promise.race([
          window.strandWorkers,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged strand prediction helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.ok(result.isolated);
      assert.deepEqual(result.helpers, [4, 4]);
      assert.ok(result.exact && result.reciprocated);
      assert.deepEqual(result.cells, [strandCell, strandCell]);
      for (const [i, threads] of [1, 2, 4].entries()) {
        for (const receipt of result.work[i])
          assert.deepEqual(receipt, expectedStrandWork(guides, pointsPerGuide, threads));
      }
      console.log('SOFT-03 packaged strand prediction work', result.hash, JSON.stringify(result.work[2].at(-1)));
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
