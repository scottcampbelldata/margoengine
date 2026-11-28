import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'crush-shell-worker-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.shellWorkers = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = ({ message }) => { worker.terminate(); reject(new Error(message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { CrushShellSolver } from '@margoengine/physics/crush';
    import { equalShellWords, followCrushShell } from '../../packages/physics/tests/fixtures/crush-shell-workers.mjs';
    const BrowserWorker = globalThis.Worker;
    let starts = 0, stops = 0;
    globalThis.Worker = class extends BrowserWorker {
      constructor(url, config) { super(url, config); starts++; }
      terminate() { stops++; super.terminate(); }
    };
    async function verify() {
      const scalar = await followCrushShell(1, false, true);
      const parallel = await followCrushShell(4, true, true);
      const snapshots = [scalar, parallel].every((run) =>
        equalShellWords(run.accepted.bytes, run.replay.accepted.bytes) &&
        equalShellWords(run.positions, run.replay.positions) &&
        JSON.stringify(run.receipts) === JSON.stringify(run.replay.receipts),
      );
      const exact = snapshots && equalShellWords(scalar.accepted.bytes, parallel.accepted.bytes) &&
        equalShellWords(scalar.positions, parallel.positions) &&
        JSON.stringify(scalar.budget) === JSON.stringify(parallel.budget);
      const success = [starts, stops];
      const controller = new AbortController();
      const unbound = await CrushShellSolver.load({ threads: 2, signal: controller.signal });
      controller.abort();
      const noAttach = [starts, stops];
      unbound[Symbol.dispose]();
      return { exact, isolated: crossOriginIsolated, success, noAttach, cell: parallel.cell,
        receipts: parallel.receipts, hash: parallel.accepted.hash, faceCount: parallel.faceCount,
        pressureFaceCount: parallel.pressureFaceCount };
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
  for (const variant of ['crush-shell-kernel', 'crush-shell-kernel-shared', 'crush-shell-kernel-threaded']) {
    const match = files.filter(
      (name) =>
        name.startsWith(variant + '-') &&
        name.endsWith('.wasm') &&
        (variant !== 'crush-shell-kernel' || !/^crush-shell-kernel-(shared|threaded)-/.test(name)),
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
          window.shellWorkers,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged crush-shell helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.ok(result.isolated && result.exact);
      assert.deepEqual(result.success, [3, 3]);
      assert.deepEqual(result.noAttach, [4, 4]);
      assert.deepEqual(result.cell, [1_165_900_000, -1_048_500_000, 1_982_700_000]);
      const final = result.receipts.at(-1);
      assert.equal(final.pairedFaces, (result.faceCount - 1) * final.forceEvaluations);
      assert.equal(final.pressureFaces, result.pressureFaceCount * final.forceEvaluations);
      assert.ok(final.plasticReturns > 0 && final.workers.every(({ pairedFaces }) => pairedFaces > 0));
      console.log('BREAK-03 packaged membrane work', { hash: result.hash, final });
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
