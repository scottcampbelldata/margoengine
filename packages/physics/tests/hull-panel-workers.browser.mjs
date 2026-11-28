import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'hull-panel-consumer-'));
try {
  await writeFile(join(root, 'index.html'), '<script type="module" src="./index.js"></script>');
  await writeFile(
    join(root, 'index.js'),
    `
    window.hullPanelProof = new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./world.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.onerror = ({ message }) => { worker.terminate(); reject(new Error(message)); };
    });
  `,
  );
  await writeFile(
    join(root, 'world.js'),
    `
    import { bakeHullPanels } from '@margoengine/physics/seakeeping';
    import { equalPanels, followHull, hemisphere, hullPanelRun, options } from '../../packages/physics/tests/fixtures/hull-panel-workers.mjs';
    const BrowserWorker = globalThis.Worker;
    const controller = new AbortController();
    let starts = 0;
    let stops = 0;
    let abort = false;
    globalThis.Worker = class extends BrowserWorker {
      constructor(url, settings) { super(url, settings); starts++; }
      postMessage(...args) {
        super.postMessage(...args);
        if (abort) queueMicrotask(() => controller.abort());
      }
      terminate() { stops++; super.terminate(); }
    };
    async function verify() {
      const mesh = hemisphere(2, 11);
      const serial = await hullPanelRun(mesh, 1);
      const parallel = await hullPanelRun(mesh, 4);
      const life = { starts, stops };
      const left = await followHull(mesh, serial);
      const right = await followHull(mesh, parallel);
      const exact = equalPanels(serial, parallel) && left.exact && right.exact &&
        left.load === right.load && right.load !== 0 &&
        left.accepted.bytes.every((value, i) => value === right.accepted.bytes[i]);
      abort = true;
      const aborted = await bakeHullPanels(mesh, { ...options(8), threads: 4, signal: controller.signal }).then(
        () => null, (error) => error.name,
      );
      // Flush the callbacks for any peer whose message or abort triggered the first rejection.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { exact, cell: right.cell, work: parallel.work, life, aborted, starts, stops };
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
  const match = files.filter((name) => /^hull-panel-kernel-.*\.wasm$/.test(name));
  assert.equal(match.length, 1, 'Keep the optional hull panel Wasm asset external.');
  assert.deepEqual(
    await readFile(join(assets, match[0])),
    await readFile(new URL('../dist/hull-panel-kernel.wasm', import.meta.url)),
  );
  assert.equal(files.filter((name) => /^hull-panel-thread-.*\.js$/.test(name)).length, 1);
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
          window.hullPanelProof,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('The packaged hull panel helpers did not finish.')), 20_000),
          ),
        ]),
      );
      assert.equal(result.error, undefined, result.error);
      assert.equal(result.exact, true);
      assert.deepEqual(result.cell, [1_165_900_000, -1_048_500_000, 1_982_700_000]);
      assert.deepEqual(result.life, { starts: 3, stops: 3 });
      assert.equal(result.aborted, 'AbortError');
      assert.equal(result.starts, 6);
      assert.equal(result.stops, 6);
      assert.equal(result.work.threads, 4);
      assert.equal(result.work.frequencySolves, 8);
      assert.deepEqual(
        result.work.workers.map(({ systems }) => systems),
        [3, 2, 2, 2],
      );
      assert.ok(
        result.work.workers.every(
          ({ eliminationPairs, eliminationTail }) => eliminationPairs > 0 && eliminationTail > 0,
        ),
      );
      console.log('SEA-08 packaged hull-panel work', result.work);
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
