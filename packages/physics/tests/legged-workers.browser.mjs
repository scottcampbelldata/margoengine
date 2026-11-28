import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';
import { expectedLeggedWork, leggedCell } from './fixtures/legged-workers.mjs';

const count = 73;
const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'legged-worker-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.leggedWorkers = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = ({ message }) => { worker.terminate(); reject(new Error(message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { followLegged } from '../../packages/physics/tests/fixtures/legged-workers.mjs';
    const ChromiumWorker = globalThis.Worker;
    let starts = 0, stops = 0;
    globalThis.Worker = class extends ChromiumWorker {
      constructor(url, config) { super(url, config); starts++; }
      terminate() { stops++; super.terminate(); }
    };
    async function verify() {
      const runs = [];
      for (const threads of [1, 2, 4]) runs.push(await followLegged(${count}, threads));
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
    ['locomotion-kernel', /^locomotion-kernel-(?!shared-).*\.wasm$/],
    ['locomotion-kernel-shared', /^locomotion-kernel-shared-.*\.wasm$/],
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
          window.leggedWorkers,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged legged helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.ok(result.isolated);
      assert.deepEqual(result.helpers, [4, 4]);
      const { state } = result.runs[0].accepted;
      for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, leggedCell);
      assert.ok(state.feet.flat().some(({ stance, force }) => stance && force[1] > 0));
      assert.ok(state.poses.some(({ gait }) => gait === 'trot') && state.poses.some(({ gait }) => gait === 'run'));
      for (const [i, threads] of [1, 2, 4].entries()) {
        const { accepted, replay } = result.runs[i];
        assert.deepEqual(accepted.state, state);
        assert.deepEqual(accepted, replay);
        for (const [frame, receipt] of accepted.work.entries())
          assert.deepEqual(receipt, expectedLeggedWork(accepted.stance[frame], threads));
      }
      console.log(
        'LIFE-01 packaged legged contact work',
        state.snapshot.hash,
        JSON.stringify(result.runs[2].accepted.work.at(-1)),
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
