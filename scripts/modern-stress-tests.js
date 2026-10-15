import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, relative } from 'node:path';
import { build } from 'vite';
import { openBrowser } from './browser.js';
import { stressOptions, stressProfile, installStressGPU, scenarios } from '../tests/support/stress-profiles.js';
import { decodePNG } from '../tests/support/png.js';

const options = stressOptions(process.argv.slice(2)),
  start = Date.now();
const output = resolve(`test-results/stress/seed-${options.seed}-shard-${options.shard}`);
await mkdir(output, { recursive: true });
await build({
  configFile: false,
  publicDir: false,
  base: './',
  logLevel: 'error',
  build: {
    outDir: `${output}/harness`,
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: resolve('tests/modern-stress.html') },
  },
});
const startPath = `/${relative('.', output).replaceAll('\\', '/')}/harness/tests/modern-stress.html`;
const browser = await openBrowser({ startPath, port: 0 });
const origin = new URL(browser.page.url()).origin,
  instance = browser.page.context().browser();
const report = {
  version: 1,
  started: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
  options,
  hardware: browser.hardware,
  sessions: [],
  passed: 0,
  failed: 0,
};
await browser.page.close();
await writeFile(`${output}/sessions.jsonl`, '');
await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
const percentile = (values, p) =>
  values.length ? values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
let fatal;
try {
  assert.ok(
    report.hardware.webgpu,
    'WebGPU unavailable; select a supported browser/adapter or explicitly enable SwiftShader',
  );
  for (let index = options.shard; index < options.sessions; index += options.shards) {
    const profile = stressProfile(options.seed, index),
      errors = [],
      begun = Date.now();
    const context = await instance.newContext({
      viewport: { width: 640, height: 480 },
      deviceScaleFactor: profile.dpr,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeout);
    const entry = { index, profile, status: 'failed', errors };
    let timer, capture;
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
    page.on('crash', () => errors.push('page crashed'));
    page.on('console', (message) => {
      if (message.type() === 'error' || /ValidationError|Invalid .*Pipeline|Error while parsing/.test(message.text()))
        errors.push(`console: ${message.text()}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
    });
    await page.exposeFunction('stressCapture', async () => {
      capture = await page.locator('canvas').screenshot();
      const pixels = await decodePNG(capture);
      let varied = 0;
      for (let i = 4; i < pixels.data.length; i += 4)
        if (
          Math.abs(pixels.data[i] - pixels.data[0]) +
            Math.abs(pixels.data[i + 1] - pixels.data[1]) +
            Math.abs(pixels.data[i + 2] - pixels.data[2]) >
          15
        )
          varied++;
      assert.ok(varied > 10, `Blank output: ${varied} non-background pixels`);
      entry.pixels = varied;
    });
    try {
      await context.addInitScript(installStressGPU, profile);
      await page.goto(`${origin}${startPath}`);
      await page.waitForFunction(() => window.runStress);
      const cdp = profile.scenario === 'soak' ? await context.newCDPSession(page) : null;
      // shortcut: heap includes harness request records, use heap snapshots to investigate very long soaks.
      const heap = async () => {
        await cdp.send('HeapProfiler.collectGarbage');
        return (await cdp.send('Runtime.getHeapUsage')).usedSize;
      };
      const exercise = async () => {
        const result = await page.evaluate(({ profile, options }) => window.runStress(profile, options), {
          profile,
          options,
        });
        if (cdp) {
          const samples = [await heap()];
          for (let cycle = 1; cycle < options.cycles; cycle++) {
            const next = await page.evaluate(({ profile, options }) => window.runStress(profile, options), {
              profile,
              options,
            });
            result.frames.push(...next.frames);
            samples.push(await heap());
          }
          const growth = samples.at(-1) - samples[0];
          assert.ok(
            growth < 8 * 1024 * 1024,
            `Retained heap grew by ${growth} bytes after ${options.cycles} lifecycles`,
          );
          entry.heap = { samples, growth, budget: 8 * 1024 * 1024 };
          entry.cycles = options.cycles;
        }
        return result;
      };
      const result = await Promise.race([
        exercise(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Session exceeded ${options.timeout}ms`)), options.timeout);
        }),
      ]);
      const state = await page.evaluate(() => {
        const s = window.stressGPU;
        return {
          errors: s.errors,
          requests: s.requests,
          created: s.created,
          destroyed: s.destroyed,
          alive: s.alive,
          aliveDevices: s.aliveDevices,
          peak: s.peak,
          injected: s.injected,
        };
      });
      errors.push(...state.errors);
      assert.deepEqual(errors, [], `Runtime/GPU errors in session ${index}`);
      const { frames, ...details } = result;
      Object.assign(entry, details, {
        resources: state,
        frameCount: frames.length,
        completedFrameMs: {
          median: percentile(frames, 0.5),
          p95: percentile(frames, 0.95),
          max: frames.length ? frames.reduce((max, value) => Math.max(max, value), 0) : null,
        },
        status: 'passed',
      });
      if (index < scenarios.length) {
        if (capture) await writeFile(`${output}/${index}-${profile.scenario}.png`, capture);
      }
    } catch (error) {
      entry.failure = error.stack ?? String(error);
      console.error(`FAIL session ${index} (${profile.scenario}): ${error.message}`);
      if (capture) await writeFile(`${output}/${index}-failure.png`, capture);
      else await page.screenshot({ path: `${output}/${index}-failure.png` }).catch(() => {});
      entry.resources = await page
        .evaluate(() => {
          const s = window.stressGPU;
          return (
            s && {
              errors: s.errors,
              requests: s.requests,
              created: s.created,
              destroyed: s.destroyed,
              alive: s.alive,
              peak: s.peak,
              injected: s.injected,
            }
          );
        })
        .catch(() => null);
    } finally {
      clearTimeout(timer);
      await context.close();
      entry.elapsedMs = Date.now() - begun;
      report.sessions.push(entry);
      report.elapsedMs = Date.now() - start;
      if (entry.status === 'passed') report.passed++;
      else report.failed++;
      await appendFile(`${output}/sessions.jsonl`, JSON.stringify(entry) + '\n');
      await writeFile(
        `${output}/progress.json`,
        JSON.stringify({
          sessions: report.sessions.length,
          passed: report.passed,
          failed: report.failed,
          elapsedMs: report.elapsedMs,
        }),
      );
    }
    if (report.sessions.length % 10 === 0 || index + options.shards >= options.sessions)
      console.log(
        `${report.sessions.length} sessions: ${report.passed} passed, ${report.failed} failed (${Math.round(report.elapsedMs / 1000)}s)`,
      );
  }
} catch (error) {
  fatal = error;
  report.fatal = error.stack ?? String(error);
} finally {
  report.finished = new Date().toISOString();
  report.elapsedMs = Date.now() - start;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(`Stress evidence: ${output}/report.json`);
if (fatal) throw fatal;
assert.equal(report.failed, 0, `${report.failed} stress sessions failed; see ${output}/report.json`);
