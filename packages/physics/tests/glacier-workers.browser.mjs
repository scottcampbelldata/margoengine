import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'glacier-worker-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.glacierWorkers = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = ({ message }) => { worker.terminate(); reject(new Error(message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { followGlacier } from '../../packages/physics/tests/fixtures/glacier-workers.mjs';
    const BrowserWorker = globalThis.Worker;
    let starts = 0, stops = 0;
    globalThis.Worker = class extends BrowserWorker {
      constructor(url, config) { super(url, config); starts++; }
      terminate() { stops++; super.terminate(); }
    };
    async function verify() {
      const scalar = await followGlacier(23, 19, 1);
      const parallel = await followGlacier(23, 19, 4);
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
  for (const variant of ['glacier-kernel', 'glacier-kernel-shared']) {
    const match = files.filter(
      (name) =>
        name.startsWith(variant + '-') &&
        name.endsWith('.wasm') &&
        (variant !== 'glacier-kernel' || !/^glacier-kernel-shared-/.test(name)),
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
          window.glacierWorkers,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged glacier helpers did not finish.')), 20_000),
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
      assert.ok(state.budget.calved > 0 && state.budget.melted > 0);
      assert.ok(state.midSlope.crevasseDepth > 0);
      const latest = work.at(-1);
      assert.equal(latest.threads, 4);
      assert.equal(latest.weightsRows, 437);
      assert.equal(latest.fractureRows, 437);
      assert.ok(latest.faceWeights > 699);
      assert.ok(latest.pairedFaceWeights > 0.85 * latest.faceWeights);
      assert.equal(latest.pairedFaceWeights % 2, 0);
      assert.deepEqual(latest.workers.map(({ fractureRows }) => fractureRows), [109, 109, 109, 110]);
      assert.ok(latest.workers.every(({ crevasseRoots }) => crevasseRoots > 0));
      console.log('ICE-02 packaged glacier flow and fracture work', state.snapshot.hash, latest);
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
