import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';
import { surfaceCell } from './fixtures/surface-energy-workers.mjs';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'surface-energy-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.surfaceEnergyProof = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = ({ message }) => { worker.terminate(); reject(new Error(message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { surfaceEnergyRun } from '../../packages/weather/tests/fixtures/surface-energy-workers.mjs';
    const NativeWorker = globalThis.Worker;
    let starts = 0;
    globalThis.Worker = class extends NativeWorker {
      constructor(url, options) { super(url, options); starts++; }
    };
    function equal(left, right) {
      const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
      const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
      return a.length === b.length && a.every((value, i) => value === b[i]);
    }
    async function verify() {
      const scalar = await surfaceEnergyRun(37, 29, 0);
      const single = await surfaceEnergyRun(37, 29, 1);
      const parallel = await surfaceEnergyRun(37, 29, 4);
      return {
        isolated: crossOriginIsolated,
        exact: equal(scalar.start.bytes, parallel.start.bytes) &&
          equal(scalar.accepted.snapshot.bytes, parallel.accepted.snapshot.bytes) &&
          equal(single.accepted.snapshot.bytes, parallel.accepted.snapshot.bytes) &&
          equal(parallel.accepted.snapshot.bytes, parallel.replay.snapshot.bytes) &&
          scalar.accepted.fields.every((field, index) => equal(field.words, parallel.accepted.fields[index].words)),
        work: parallel.accepted.work,
        hash: parallel.accepted.snapshot.hash,
        afterShift: parallel.accepted.fields.map(({ cell }) => cell),
        restoredCells: parallel.restoredCells,
        starts,
      };
    }
    void verify().then(result => postMessage(result), error => postMessage({ error: error.stack ?? String(error) }));
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
  for (const [asset, extension] of [
    ['surface-energy-kernel', 'wasm'],
    ['surface-energy-kernel-shared', 'wasm'],
    ['workers/surface-energy', 'js'],
  ]) {
    const filename = asset.replace('workers/', '');
    const expected = await readFile(new URL(`../dist/${asset}.${extension}`, import.meta.url));
    const candidates = files.filter((name) => name.startsWith(filename + '-') && name.endsWith('.' + extension));
    const contents = await Promise.all(candidates.map((name) => readFile(join(assets, name))));
    assert.equal(contents.filter((bytes) => bytes.equals(expected)).length, 1, `Expected one built ${asset} asset.`);
  }
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
          window.surfaceEnergyProof,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Packaged surface-energy helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.ok(result.isolated && result.exact);
      assert.equal(result.starts, 3);
      assert.deepEqual(
        result.afterShift,
        Array.from({ length: 5 }, () => [0, 0, 0]),
      );
      assert.deepEqual(
        result.restoredCells,
        Array.from({ length: 5 }, () => surfaceCell),
      );
      assert.equal(result.work.rows, 1073);
      assert.equal(result.work.pairs, 536);
      assert.deepEqual(
        result.work.workers.map(({ rows }) => rows),
        [268, 268, 268, 269],
      );
      assert.ok(result.work.pairedBalanceEvaluations > 15 * result.work.pairs);
      console.log('ATMO-09 packaged Chromium surface-energy work', result.hash, result.work);
    } finally {
      await close();
    }
  } finally {
    await app.close();
  }
} finally {
  if (dirname(root) === output) await rm(root, { recursive: true, force: true });
}
