import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';

const scratch = resolve('test-results');
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, 'wind-traction-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.windProof = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = (error) => { worker.terminate(); reject(new Error(error.message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { tractionWorld } from '../../packages/physics/tests/fixtures/wind-traction-world.mjs';
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
      const scalar = await tractionWorld(1027);
      const serial = await tractionWorld(1027, 1);
      const parallel = await tractionWorld(1027, 4);
      return {
        isolated: crossOriginIsolated,
        exact: [serial, parallel].every((result) =>
          equal(result.first, scalar.first) && equal(result.held, scalar.held) &&
          equal(result.replayHeld, scalar.held) && equal(result.accepted.bytes, scalar.accepted.bytes) &&
          equal(result.replay.bytes, result.accepted.bytes)),
        firstSample: parallel.firstSample,
        helpers,
        counts: parallel.counts,
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
  for (const base of ['wind-traction-kernel', 'wind-traction-kernel-shared']) {
    const matches = files.filter(
      (name) =>
        name.startsWith(base + '-') &&
        name.endsWith('.wasm') &&
        (base.endsWith('shared') || !name.startsWith('wind-traction-kernel-shared-')),
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
          window.windProof,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged wind workers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.ok(result.isolated && result.exact);
      assert.equal(result.helpers, 3);
      assert.deepEqual(result.firstSample, [8.25, -8.5, 9.25]);
      assert.equal(result.counts.probes, 65);
      assert.equal(result.counts.panels, 79_235);
      assert.equal(result.counts.simdPanelPairs, 39_585);
      assert.deepEqual(
        result.counts.workers.map(({ probes }) => probes),
        [15, 15, 15, 20],
      );
      console.log('AERO-01 packaged Chromium wind traction work', result.counts);
    } finally {
      await close();
    }
  } finally {
    await app.close();
  }
} finally {
  if (dirname(root) === scratch) await rm(root, { recursive: true, force: true });
}
