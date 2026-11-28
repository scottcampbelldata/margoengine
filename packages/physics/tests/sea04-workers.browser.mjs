import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';
import { expectedWakeWork, wakeCases, wakeCell } from './fixtures/sea04-workers.mjs';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'sea04-worker-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.wakeWorkers = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = ({ message }) => { worker.terminate(); reject(new Error(message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { followWake } from '../../packages/physics/tests/fixtures/sea04-workers.mjs';
    const ChromiumWorker = globalThis.Worker;
    let starts = 0, stops = 0;
    globalThis.Worker = class extends ChromiumWorker {
      constructor(url, config) { super(url, config); starts++; }
      terminate() { stops++; super.terminate(); }
    };
    async function verify() {
      const runs = [];
      for (const threads of [0, 1, 2, 4]) runs.push(await followWake('current', threads));
      return { isolated: crossOriginIsolated, helpers: [starts, stops], runs };
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
    ['wake-fft', /^wake-fft-(?!shared-).*\.wasm$/],
    ['wake-fft-shared', /^wake-fft-shared-.*\.wasm$/],
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
          window.wakeWorkers,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged wake mode helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.ok(result.isolated);
      assert.deepEqual(result.helpers, [4, 4]);
      const reference = result.runs[0].accepted;
      assert.deepEqual(reference.physical.cell, wakeCell);
      assert.notEqual(reference.physical.sample.height, 0);
      assert.ok(reference.physical.below.some((value) => value !== 0));
      for (const [i, threads] of [1, 2, 4].entries()) {
        const { accepted, replay } = result.runs[i + 1];
        assert.deepEqual(accepted.physical, reference.physical);
        assert.deepEqual(accepted.snapshot, reference.snapshot);
        assert.deepEqual(accepted, replay);
        for (const work of accepted.work) assert.deepEqual(work, expectedWakeWork(wakeCases.current.cells, threads));
      }
      console.log(
        'SEA-04 packaged wake-mode work',
        reference.snapshot.hash,
        JSON.stringify(result.runs[3].accepted.work.at(-1)),
      );
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
