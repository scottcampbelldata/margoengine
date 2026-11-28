import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';
import { iceCell, expectedIceWork } from './fixtures/ice-thermal-workers.mjs';

const sites = 257;
const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'ice-thermal-worker-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.iceWorkers = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = ({ message }) => { worker.terminate(); reject(new Error(message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { followIce } from '../../packages/physics/tests/fixtures/ice-thermal-workers.mjs';
    const BrowserWorker = globalThis.Worker;
    let starts = 0, stops = 0;
    globalThis.Worker = class extends BrowserWorker {
      constructor(url, config) { super(url, config); starts++; }
      terminate() { stops++; super.terminate(); }
    };
    async function verify() {
      const scalar = await followIce(${sites}, 0);
      const one = await followIce(${sites}, 1);
      const two = await followIce(${sites}, 2);
      const four = await followIce(${sites}, 4);
      return { isolated: crossOriginIsolated, helpers: [starts, stops], runs: [scalar, one, two, four] };
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
    ['ice-thermal-kernel', /^ice-thermal-kernel-(?!shared-).*\.wasm$/],
    ['ice-thermal-kernel-shared', /^ice-thermal-kernel-shared-.*\.wasm$/],
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
          window.iceWorkers,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged ice thermodynamics helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.ok(result.isolated);
      assert.deepEqual(result.helpers, [4, 4]);
      const { state } = result.runs[0].accepted;
      assert.ok(state.first[6].steam > 0 && state.first[6].meltwater > 0);
      assert.ok(state.samples[0].thickness > state.first[0].thickness);
      assert.ok(state.samples[1].thickness > state.first[1].thickness);
      assert.ok(state.samples[2].length > state.first[2].length);
      for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, iceCell);
      for (const [threads, run] of [0, 1, 2, 4].map((count, i) => [count, result.runs[i]])) {
        const { accepted, replay } = run;
        assert.deepEqual(accepted.state, state);
        assert.deepEqual(replay, accepted);
        for (const receipt of accepted.work) assert.deepEqual(receipt, expectedIceWork(sites, threads));
      }
      console.log('ICE-05 packaged phase-energy work', state.snapshot.hash, result.runs[3].accepted.work.at(-1));
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
