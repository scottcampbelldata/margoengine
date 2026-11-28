import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';
import { aeolianWork } from './fixtures/aeolian-workers.mjs';

const scratch = resolve('test-results');
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, 'aeolian-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.aeolianProof = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = (error) => { worker.terminate(); reject(new Error(error.message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { aeolianWorkerRun } from '../../packages/physics/tests/fixtures/aeolian-workers.mjs';
    const NativeWorker = globalThis.Worker;
    let helpers = 0;
    globalThis.Worker = class extends NativeWorker {
      constructor(url, options) { super(url, options); helpers++; }
    };
    function equal(left, right) {
      const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
      const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
      return a.length === b.length && a.every((value, i) => value === b[i]);
    }
    async function verify() {
      const scalar = await aeolianWorkerRun(33, 27, 'sand', 1, false);
      const parallel = await aeolianWorkerRun(33, 27, 'sand', 4, true);
      return {
        isolated: crossOriginIsolated,
        exact: equal(scalar.start.bytes, parallel.start.bytes) &&
          equal(scalar.accepted.snapshot.bytes, parallel.accepted.snapshot.bytes) &&
          equal(parallel.accepted.snapshot.bytes, parallel.replay.snapshot.bytes) &&
          equal(scalar.accepted.bed, parallel.accepted.bed) &&
          scalar.accepted.fields.every((field, index) => equal(field.words, parallel.accepted.fields[index].words)),
        firstWind: parallel.firstWind,
        afterShift: parallel.accepted.fields.map(({ cell }) => cell),
        helpers,
        work: parallel.accepted.work,
        hash: parallel.accepted.snapshot.hash,
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
  assert.equal(files.filter((name) => name.startsWith('solver-phase-thread-') && name.endsWith('.js')).length, 1);
  for (const base of ['aeolian-kernel', 'aeolian-kernel-shared']) {
    const matches = files.filter(
      (name) =>
        name.startsWith(base + '-') &&
        name.endsWith('.wasm') &&
        (base.endsWith('shared') || !name.startsWith('aeolian-kernel-shared-')),
    );
    assert.equal(matches.length, 1, `Expected one ${base} Wasm asset in the consumer.`);
    assert.deepEqual(
      await readFile(join(assets, matches[0])),
      await readFile(new URL(`../dist/${base}.wasm`, import.meta.url)),
    );
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
          window.aeolianProof,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged aeolian helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.ok(result.isolated && result.exact);
      assert.equal(result.helpers, 3);
      assert.deepEqual(result.firstWind, [7.5, 0.125, 15.1875]);
      assert.deepEqual(
        result.afterShift,
        Array.from({ length: 4 }, () => [0, 0, 0]),
      );
      assert.deepEqual(result.work, aeolianWork(891, 6, 4));
      console.log('EARTH-07 packaged Chromium aeolian work', result.hash, result.work);
    } finally {
      await close();
    }
  } finally {
    await app.close();
  }
} finally {
  if (dirname(root) === scratch) await rm(root, { recursive: true, force: true });
}
