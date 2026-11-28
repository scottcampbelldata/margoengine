import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';
import { expectedPlantWork } from './fixtures/vegetation-threads-worker.mjs';

const isolation = {
  name: 'vegetation-thread-isolation',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, close } = await openBrowser({
  startPath: '/tools/shot/blank.html',
  port: 'free',
  plugins: [isolation],
  softwareAdapterOk: true,
});

async function productionWorker() {
  const root = await mkdtemp(resolve('test-results/vegetation-consumer-'));
  await writeFile(join(root, 'index.html'), '<script type="module" src="./main.js"></script>');
  await writeFile(
    join(root, 'main.js'),
    `
      window.plantProof = new Promise((done, reject) => {
        const worker = new Worker(new URL('./world-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => { worker.terminate(); done(data); };
        worker.onerror = (error) => { worker.terminate(); reject(new Error(error.message)); };
      });
    `,
  );
  await writeFile(
    join(root, 'world-worker.js'),
    `
      import { PlantSway } from '@margoengine/physics/vegetation';
      import { PhysicsWorld, worldMemory } from '@margoengine/physics/world';

      async function run(shared, threads) {
        const sway = await PlantSway.load({ threads });
        const world = new PhysicsWorld({ memory: worldMemory(shared), rate: { num: 60, den: 1 } });
        const plant = {
          root: [0, 0, 0], height: 1.6, baseDiameter: 0.08, density: 700, youngModulus: 1.2e8,
          initialDisplacement: [0.012, 0.003, 0, 0],
        };
        try {
          world.add(sway, { plants: Array(13).fill(plant) });
          world.advance(3);
          return { state: world.takeSnapshot().bytes, work: sway.workCounts(), moved: sway.readSway()[0] !== 0.012 };
        } finally {
          sway[Symbol.dispose]();
        }
      }

      async function compare() {
        const ActualWorker = globalThis.Worker;
        let helpers = 0;
        globalThis.Worker = class extends ActualWorker {
          constructor(url, options) { super(url, options); helpers++; }
        };
        try {
          const [serial, parallel] = [await run(false, 1), await run(true, 4)];
          return {
            isolated: crossOriginIsolated,
            helpers,
            exact: serial.state.length === parallel.state.length &&
              serial.state.every((value, i) => value === parallel.state[i]),
            work: parallel.work,
            moved: parallel.moved,
          };
        } finally {
          globalThis.Worker = ActualWorker;
        }
      }
      void compare().then(result => postMessage(result), error => postMessage({ error: error.stack ?? String(error) }));
    `,
  );
  await build({ root, configFile: false, publicDir: false, logLevel: 'warn', build: { target: 'es2022' } });
  const assets = join(root, 'dist/assets');
  const files = await readdir(assets);
  assert.equal(files.filter((name) => name.startsWith('solver-phase-thread-') && name.endsWith('.js')).length, 1);
  for (const base of ['vegetation-kernel', 'vegetation-kernel-shared']) {
    const variants = files.filter(
      (name) =>
        name.startsWith(base + '-') &&
        name.endsWith('.wasm') &&
        (base.endsWith('shared') || !name.startsWith('vegetation-kernel-shared-')),
    );
    assert.equal(variants.length, 1);
    assert.deepEqual(
      await readFile(join(assets, variants[0])),
      await readFile(new URL('../dist/' + base + '.wasm', import.meta.url)),
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
    const address = app.httpServer.address();
    assert.ok(address && typeof address === 'object');
    await page.goto('http://127.0.0.1:' + address.port + '/');
    const result = await page.evaluate(() =>
      Promise.race([
        window.plantProof,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Packaged vegetation worker did not finish.')), 20_000),
        ),
      ]),
    );
    assert.equal(result.error, undefined, result.error);
    assert.ok(result.isolated && result.exact && result.moved);
    assert.equal(result.helpers, 3);
    assert.deepEqual(result.work, expectedPlantWork(Array(13).fill(true), 4));
    console.log('BIO-01 packaged Chromium modal work', result.work);
  } finally {
    await app.close();
  }
}
try {
  const outcome = await page.evaluate(async () => {
    const { PlantSway } = await import('/packages/physics/dist/vegetation.js');
    const windowError = await PlantSway.load({ threads: 4 }).then(
      (solver) => {
        solver[Symbol.dispose]();
        return null;
      },
      (error) => ({ name: error.name, code: error.code, message: error.message }),
    );
    const worker = new Worker('/packages/physics/tests/fixtures/vegetation-threads-worker.mjs', { type: 'module' });
    let timeout;
    try {
      const result = await new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Plant sway worker receipt timed out.')), 30_000);
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (error) => reject(new Error(error.message));
        worker.onmessageerror = () => reject(new Error('Plant sway worker receipt could not be read.'));
      });
      return { isolated: crossOriginIsolated, windowError, ...result };
    } finally {
      clearTimeout(timeout);
      worker.terminate();
    }
  });
  assert.equal(outcome.isolated, true);
  assert.equal(outcome.windowError?.name, 'MargoError');
  assert.equal(outcome.windowError?.code, 'unsupported');
  assert.match(outcome.windowError.message, /worker.*threads: 1/i);
  assert.equal(outcome.error, undefined, outcome.error);
  const { baseline, reports, far } = outcome;
  assert.deepEqual(
    reports.map(({ shared, threads, helpers }) => [shared, threads, helpers]),
    [
      [true, 1, 0],
      [true, 2, 1],
      [true, 4, 3],
    ],
  );
  for (const report of [baseline, ...reports]) {
    assert.ok(report.originShiftExact && report.acceptedCellAgrees && report.exactReplay && report.readsAgree);
    assert.ok(report.changed);
    assert.equal(report.hash, baseline.hash);
    assert.deepEqual(report.initialCells, [far, far]);
    assert.deepEqual(report.shiftedCells, [
      [0, 0, 0],
      [0, 0, 0],
    ]);
    assert.deepEqual(report.restoredCells, report.initialCells);
    assert.deepEqual(report.status, [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(report.coldWork, expectedPlantWork([], report.threads));
    assert.deepEqual(report.work, expectedPlantWork(report.standing, report.threads));
    assert.deepEqual(report.replayWork, report.work);
  }
  for (const report of reports) assert.ok(report.exactStart && report.exactCheckpoint && report.exactFinal);
  console.log('BIO-01 isolated Chromium modal work', reports.at(-1).hash, reports.at(-1).work);
  await productionWorker();
} finally {
  await close();
}
