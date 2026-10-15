// HANDOFF 1f.j / 1g.f, real browser. From the repository root after `npm run build:packages`:
//   node examples/package-benchmarks/workers/run.mjs [--rounds=6] [--skip-parse] [--skip-offscreen]
// Takes the GPU lock (main checkout's test-results/gpu.lock, checked every 60 s), requires AC power before and after.
// 1. offscreen.html in Edge and Chrome: core + packages on a transferred OffscreenCanvas in a worker, platform features
//    (Float16Array, Symbol.dispose, `using`), canvas screenshot must show drawn pixels.
// 2. parse.html in Edge: main-thread blocking while loading a large FBX, a USDZ, DamagedHelmet and a generated GLB, with
//    the main-thread loaders vs the /worker entries; alternating order per round, round 0 discarded, medians reported.
// Writes examples/package-benchmarks/results/workers.json (fixtures go to test-results/workers-*).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { bigGLB } from '../../../tests/support/big-glb.js';
import { acPower } from '../cad/power.mjs';
import { binary, grid } from '../../../packages/fbx/test/fixtures.js';
import { exportUSDZ } from '../../../packages/exporters/dist/index.js';
import { torusKnotGeometry, toGeometry } from '../../../packages/geometry/dist/index.js';

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const rounds = +arg('rounds', 6),
  median = (values) => {
    const s = [...values].sort((a, b) => a - b),
      m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/workers-big.glb', bigGLB({ segments: 400, meshes: 4 })); // 4 x 160,801 vertices, 960,000 indices each (accessors are capped at 1M elements)
writeFileSync('test-results/workers-grid.fbx', binary(grid(400), { compress: true }));
writeFileSync(
  'test-results/workers-knot.usdz',
  exportUSDZ({ nodes: [{ geometry: toGeometry(torusKnotGeometry(1, 0.3, 1000, 100)) }] }),
);

const lock =
  process.env.MARGO_GPU_LOCK_NESTED ??
  resolve(
    dirname(
      execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim(),
    ),
    'test-results/gpu.lock',
  );
for (;;) {
  try {
    mkdirSync(lock);
    break;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    console.log(new Date().toISOString(), 'gpu.lock held, waiting 60 s');
    await new Promise((r) => setTimeout(r, 60_000));
  }
}
const output = 'examples/package-benchmarks/results/workers.json',
  previous = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {};
const report = {
  date: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
  acPowerBefore: acPower(),
  offscreen: {},
  parse: { runs: [], medians: {} },
};
// A skipped section keeps its previous result (with that run's date and power state).
for (const section of ['offscreen', 'parse'])
  if (process.argv.includes(`--skip-${section}`) && previous[section])
    report[section] = {
      ...previous[section],
      from: {
        date: previous.date,
        commit: previous.commit,
        acPowerBefore: previous.acPowerBefore,
        acPowerAfter: previous.acPowerAfter,
      },
    };
try {
  assert.notEqual(report.acPowerBefore, false, 'On battery');
  if (!process.argv.includes('--skip-offscreen'))
    for (const channel of ['msedge', 'chrome']) {
      let context;
      try {
        context = await openBrowser({
          channel,
          startPath: '/examples/package-benchmarks/workers/offscreen.html',
          port: 5251,
        });
        const { page, hardware } = context,
          pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        page.on('console', (m) => {
          if (m.type() === 'error') pageErrors.push(m.text());
        });
        await page.waitForFunction(() => window.result, null, { timeout: 120_000 });
        const { result, features } = await page.evaluate(() => ({ result: window.result, features: window.features }));
        const image = await decodePNG(
          await page.locator('canvas').screenshot({ path: `test-results/workers-offscreen-${channel}.png` }),
        );
        let drawn = 0;
        const d = image.data;
        for (let i = 0; i < d.length; i += 4)
          if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 12) drawn++; // differs from the clear colour
        report.offscreen[channel] = {
          browser: hardware.browserVersion,
          adapter: hardware.webgpu,
          features,
          steps: result.steps ?? result,
          drawnFraction: +(drawn / (image.width * image.height)).toFixed(4),
          pageErrors,
        };
        console.log(channel, JSON.stringify(report.offscreen[channel], null, 1));
      } catch (error) {
        report.offscreen[channel] = { error: String(error.message ?? error) };
        console.log(channel, 'failed', error.message);
      } finally {
        await context?.close();
      }
    }
  if (!process.argv.includes('--skip-parse')) {
    const context = await openBrowser({ startPath: '/examples/package-benchmarks/workers/parse.html', port: 5252 });
    try {
      const { page, hardware } = context,
        pageErrors = [];
      page.setDefaultTimeout(300_000);
      page.on('pageerror', (e) => pageErrors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push(m.text());
      });
      report.parse.hardware = hardware;
      await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
      const names = await page.evaluate(() => window.bench.names);
      await page.evaluate(() => window.bench.warm());
      for (let round = 0; round < rounds; round++)
        for (const name of names)
          for (const mode of round % 2 ? ['worker', 'main'] : ['main', 'worker']) {
            const run = await page.evaluate(([n, m]) => window.bench.run(n, m), [name, mode]);
            run.round = round;
            assert.deepEqual(run.errors, [], `${name} ${mode}`);
            report.parse.runs.push(run);
            console.log(JSON.stringify(run));
          }
      for (const name of names)
        for (const mode of ['main', 'worker']) {
          const runs = report.parse.runs.filter((r) => r.name === name && r.mode === mode && r.round > 0);
          report.parse.medians[`${name} ${mode}`] = Object.fromEntries(
            ['loadMs', 'longestTaskMs', 'blockedMs', 'totalBlockingTimeMs', 'maxFrameGapMs', 'longTasks'].map((k) => [
              k,
              +median(runs.map((r) => r[k])).toFixed(1),
            ]),
          );
        }
      report.parse.pageErrors = pageErrors;
      console.table(report.parse.medians);
    } finally {
      await context.close();
    }
  }
  report.acPowerAfter = acPower();
  writeFileSync(output, JSON.stringify(report, null, 1));
  console.log(
    'wrote examples/package-benchmarks/results/workers.json; AC before/after',
    report.acPowerBefore,
    report.acPowerAfter,
  );
} finally {
  rmSync(lock, { recursive: true, force: true });
}
