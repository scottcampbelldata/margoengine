import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'flood-volume-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.floodProof = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = ({ message }) => { worker.terminate(); reject(new Error(message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { equalFloodWords, followFlood } from '../../packages/physics/tests/fixtures/flood-volume-workers.mjs';
    const BrowserWorker = globalThis.Worker;
    let starts = 0, stops = 0;
    globalThis.Worker = class extends BrowserWorker {
      constructor(url, config) { super(url, config); starts++; }
      terminate() { stops++; super.terminate(); }
    };
    async function verify() {
      const scalar = await followFlood();
      const serial = await followFlood(1);
      const parallel = await followFlood(4);
      const exact = scalar.exact && serial.exact && parallel.exact &&
        equalFloodWords(scalar.accepted.bytes, serial.accepted.bytes) &&
        equalFloodWords(scalar.accepted.bytes, parallel.accepted.bytes) &&
        equalFloodWords(scalar.breaches, parallel.breaches) &&
        JSON.stringify(scalar.compartments) === JSON.stringify(parallel.compartments);
      return {
        exact, isolated: crossOriginIsolated, starts, stops, work: parallel.work,
        cell: parallel.cell, inflow: parallel.breaches[10], hash: parallel.accepted.hash,
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
  for (const variant of ['flood-volume-kernel', 'flood-volume-kernel-shared']) {
    const match = files.filter(
      (name) =>
        name.startsWith(variant + '-') &&
        name.endsWith('.wasm') &&
        (variant.endsWith('shared') || !name.startsWith('flood-volume-kernel-shared-')),
    );
    assert.equal(match.length, 1, `Keep ${variant} as a separate packaged asset.`);
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
          window.floodProof,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged flood volume helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.ok(result.isolated && result.exact && result.inflow < 0);
      assert.equal(result.starts, 3);
      assert.equal(result.stops, 3);
      assert.deepEqual(result.cell, [1_165_900_000, -1_048_500_000, 1_982_700_000]);
      assert.deepEqual(
        result.work.workers.map(({ planes }) => planes),
        [10, 12, 12, 13].map((planes) => planes * result.work.batches),
      );
      assert.ok(
        result.work.workers.every(
          ({ trianglePairs, intersectionPairs, fanPairs }) =>
            trianglePairs > 0 && intersectionPairs > 0 && fanPairs > 0,
        ),
      );
      console.log('SEA-10 packaged tilted flood volume work', result);
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
