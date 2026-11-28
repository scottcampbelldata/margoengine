import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'outdoor-sound-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.outdoorSoundProof = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = ({ message }) => { worker.terminate(); reject(new Error(message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { outdoorSoundRun } from '../../packages/physics/tests/fixtures/outdoor-sound-workers.mjs';
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
      const scalar = await outdoorSoundRun(63, 0);
      const native = await outdoorSoundRun(63, 1);
      const parallel = await outdoorSoundRun(63, 4);
      return {
        isolated: crossOriginIsolated,
        exact: equal(scalar.start.bytes, parallel.start.bytes) &&
          equal(scalar.accepted.snapshot.bytes, parallel.accepted.snapshot.bytes) &&
          equal(native.accepted.snapshot.bytes, parallel.accepted.snapshot.bytes) &&
          equal(parallel.accepted.snapshot.bytes, parallel.replay.snapshot.bytes) &&
          equal(scalar.accepted.field.values, parallel.accepted.field.values),
        blocked: parallel.accepted.countBlocked,
        acceptedCell: parallel.accepted.field.cell,
        initial: parallel.initial,
        restored: parallel.restored,
        work: parallel.accepted.work,
        hash: parallel.accepted.snapshot.hash,
        helpers,
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
  for (const base of ['outdoor-sound-kernel', 'outdoor-sound-kernel-shared']) {
    const matches = files.filter(
      (name) =>
        name.startsWith(base + '-') &&
        name.endsWith('.wasm') &&
        (base.endsWith('shared') || !name.startsWith('outdoor-sound-kernel-shared-')),
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
          window.outdoorSoundProof,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Packaged outdoor sound helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.ok(result.isolated && result.exact);
      assert.equal(result.helpers, 3);
      assert.ok(result.blocked > 0 && result.blocked < 62);
      assert.deepEqual(result.restored, result.initial);
      assert.equal(result.acceptedCell[1], result.initial[1] - 1);
      assert.equal(result.work.links, 63);
      assert.equal(result.work.samples, (62 + result.blocked) * 17);
      assert.equal(result.work.bandPairs, 4 * result.work.samples);
      assert.deepEqual(
        result.work.workers.map(({ links }) => links),
        [15, 16, 16, 16],
      );
      assert.ok(result.work.workers.every((worker) => worker.bandPairs > 0));
      console.log('SOUND-01 packaged Chromium outdoor sound work', result.hash, result.work);
    } finally {
      await close();
    }
  } finally {
    await app.close();
  }
} finally {
  if (dirname(root) === output) await rm(root, { recursive: true, force: true });
}
