import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';
import { ageingCell, expectedAgeingWork } from './fixtures/ageing-workers.mjs';

const patches = 129;
const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'ageing-worker-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.ageingWorkers = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = ({ message }) => { worker.terminate(); reject(new Error(message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { followAgeing } from '../../packages/physics/tests/fixtures/ageing-workers.mjs';
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
        equalRows(a.cell, b.cell) && equalRows(a.words, b.words) &&
        JSON.stringify(a.appearances) === JSON.stringify(b.appearances);
    }
    async function verify() {
      const scalar = await followAgeing(${patches}, 0);
      const one = await followAgeing(${patches}, 1);
      const two = await followAgeing(${patches}, 2);
      const four = await followAgeing(${patches}, 4);
      const runs = [scalar, one, two, four];
      const state = scalar.accepted.state;
      return {
        isolated: crossOriginIsolated,
        helpers: [starts, stops],
        hash: state.snapshot.hash,
        exact: runs.every(({ accepted, replay }) =>
          equalStates(state, accepted.state) && equalStates(accepted.state, replay.state)
        ),
        changed: state.readings[0].consumedThickness > state.before[0].consumedThickness &&
          state.readings[2].rotActivity > 0 &&
          state.readings[3].consumedThickness > state.before[3].consumedThickness &&
          state.readings[5].coatingThickness > state.readings[5].innerCoatingThickness,
        cell: state.cell,
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
    ['ageing-kernel', /^ageing-kernel-(?!shared-).*\.wasm$/],
    ['ageing-kernel-shared', /^ageing-kernel-shared-.*\.wasm$/],
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
      await page.goto('http://127.0.0.1:' + address.port + '/');
      const result = await page.evaluate(() =>
        Promise.race([
          window.ageingWorkers,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged material ageing helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.ok(result.isolated);
      assert.deepEqual(result.helpers, [4, 4]);
      assert.ok(result.exact);
      assert.ok(result.changed);
      assert.deepEqual(result.cell, ageingCell);
      assert.ok(result.work[0].every((receipt) => receipt === undefined));
      for (const [i, threads] of [1, 2, 4].entries()) {
        for (const receipt of result.work[i + 1]) assert.deepEqual(receipt, expectedAgeingWork(patches, threads));
      }
      console.log('BIO-04 packaged ageing patch work', result.hash, JSON.stringify(result.work[3].at(-1)));
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
