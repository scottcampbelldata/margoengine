import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'hull-slamming-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.hullSlammingProof = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = ({ message }) => { worker.terminate(); reject(new Error(message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { bakeHullSlamming, SEA_WATER, slamStations } from '@margoengine/physics/seakeeping';
    import { equalProfiles, followSlamming, slammingMesh } from '../../packages/physics/tests/fixtures/hull-slamming-workers.mjs';
    const BrowserWorker = globalThis.Worker;
    const controller = new AbortController();
    let starts = 0, stops = 0, cancel = false;
    globalThis.Worker = class extends BrowserWorker {
      constructor(url, settings) { super(url, settings); starts++; }
      postMessage(...args) {
        super.postMessage(...args);
        if (cancel) queueMicrotask(() => controller.abort());
      }
      terminate() { stops++; super.terminate(); }
    };
    async function verify() {
      const mesh = slammingMesh();
      const source = slamStations(mesh, SEA_WATER, 25);
      const serial = await bakeHullSlamming(mesh, { stations: 25 });
      const parallel = await bakeHullSlamming(mesh, { stations: 25, threads: 4 });
      const success = { starts, stops };
      const [left, right, off] = await Promise.all([
        followSlamming(mesh), followSlamming(mesh, parallel), followSlamming(mesh, undefined, false),
      ]);
      const exact = equalProfiles(source, serial.profiles) && equalProfiles(source, parallel.profiles) &&
        left.exact && right.exact && left.load === right.load && right.load > off.load &&
        left.accepted.bytes.length === right.accepted.bytes.length &&
        left.accepted.bytes.every((value, i) => value === right.accepted.bytes[i]);
      cancel = true;
      const aborted = await bakeHullSlamming(mesh, { stations: 25, threads: 4, signal: controller.signal }).then(
        () => null, (error) => error.name,
      );
      return { exact, cell: right.cell, work: parallel.work, success, aborted, starts, stops, load: right.load };
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
  const match = files.filter((name) => /^hull-slamming-kernel-.*\.wasm$/.test(name));
  assert.equal(match.length, 1, 'Keep the optional hull slamming Wasm asset external.');
  assert.deepEqual(
    await readFile(join(assets, match[0])),
    await readFile(new URL('../dist/hull-slamming-kernel.wasm', import.meta.url)),
  );
  assert.equal(files.filter((name) => /^hull-slamming-thread-.*\.js$/.test(name)).length, 1);
  const app = await preview({ root, configFile: false, logLevel: 'warn', preview: { host: '127.0.0.1', port: 0 } });
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
          window.hullSlammingProof,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged hull slamming helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.equal(result.exact, true);
      assert.deepEqual(result.cell, [1_165_900_000, -1_048_500_000, 1_982_700_000]);
      assert.deepEqual(result.success, { starts: 3, stops: 3 });
      assert.equal(result.aborted, 'AbortError');
      assert.equal(result.starts, 6);
      assert.equal(result.stops, 6);
      assert.equal(result.work.threads, 4);
      assert.deepEqual(
        result.work.workers.map(({ stations }) => stations),
        [6, 6, 6, 7],
      );
      assert.ok(
        result.work.workers.every(
          ({ quadraturePairs, profileComparisons }) => quadraturePairs > 0 && profileComparisons > 0,
        ),
      );
      console.log('SEA-11 packaged hull slamming work', result.work, 'accepted vertical load N', result.load);
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
