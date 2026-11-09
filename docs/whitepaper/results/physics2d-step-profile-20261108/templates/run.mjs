import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, hostname } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'vite';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { launchBrowser, resolveBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const directory = '.lane/p/current-step-profile-v1';
const manifest = JSON.parse(readFileSync(directory + '/manifest.json'));
const artifacts = JSON.parse(readFileSync(directory + '/artifacts.json')).artifacts;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.ok(!existsSync(directory + '/results.json'), 'Never replace an existing profile');
const cpuTimes = () => cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
const cpuBefore = cpuTimes();
const report = { started: new Date().toISOString(), host: hostname(), cpu: cpus()[0].model, logicalCpus: cpus().length, node: process.version, busyDiagnostic: true, artifacts: artifacts.map(({ calibration, ...a }) => a), expectedHashes: manifest.expected, phases: manifest.phases, countNames: manifest.counts, publicCountNames: manifest.publicCounts, method: { rows: 100, settleSteps: 60, measuredSteps: 40, rounds: 8, alternatingOrder: true, fingerprintReadsOutsideTimer: true, emptyLoopObservedInWat: true, phaseExtremaAreNonAdditive: true }, nodePrecheck: [], browsers: [], failure: null };
const save = () => writeFileSync(directory + '/results.json', JSON.stringify(report, null, 2) + '\n');
save();
const release = await acquire({ owner: 'lane-P-current-complete-step-profile-v1', mode: 'exclusive', max: 15, waitMax: 0.1 });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] }, server: { port: 0, hmr: false, watch: null, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } } });
const reference = [];
try {
  // Accuracy-only first: no elapsed measurements are taken around these checks.
  for (const a of artifacts) {
    const bytes = readFileSync(a.file);
    assert.equal(hash(bytes), a.sha256);
    const { instance } = await WebAssembly.instantiate(bytes, { env: { probe_now: () => performance.now() } });
    const k = instance.exports;
    assert.equal(k.checks(), 3);
    const checks = [], hashes = [];
    for (let i = 0; i < 3; ++i) {
      checks.push(k.check(i));
      hashes.push(k.bits(i).toString(16).padStart(16, '0'));
    }
    assert.deepEqual(checks, [0, 0, 0]);
    assert.deepEqual(hashes, manifest.expected);
    k.bench_pyramid(100);
    const states = [];
    for (let step = 0; step < 100; ++step) {
      const awake = k.bench_step();
      const counts = manifest.publicCounts.map((_, i) => k.profile_public_count(i).toString());
      const state = k.profile_state().toString(16).padStart(16, '0');
      if (step >= 60) assert.equal(awake, 5050);
      states.push({ step: step + 1, awake, state, counts });
    }
    if (!reference.length) reference.push(...states);
    else assert.deepEqual(states, reference);
    report.nodePrecheck.push({ name: a.name, checks, hashes, states });
    console.log(a.name + ': all3 explicit hashes/shipped checks and100 complete-step state/work fingerprints pass');
    save();
  }
  await server.listen();
  for (const name of ['default', 'firefox']) {
    const browser = await launchBrowser({ ...(name === 'default' ? {} : { name }), needs: name === 'firefox' ? 'none' : 'webgpu', headless: true, ...(name === 'firefox' ? { executablePath: process.env.REPLAY_FIREFOX } : {}) });
    try {
      const page = await browser.newPage();
      // Vite's own 404 response still establishes the isolated same-origin document.
      await page.goto(server.resolvedUrls.local[0] + 'packages/physics2d/tests/kernel-wasm.html');
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const result = await page.evaluate(async ({ artifacts, manifest, reference }) => {
        const ensure = (ok, message) => { if (!ok) throw new Error(message); };
        const modules = [];
        for (const a of artifacts) {
          let importedCalls = 0;
          const bytes = await (await fetch('/' + a.file)).arrayBuffer();
          const { instance } = await WebAssembly.instantiate(bytes, { env: { probe_now() { importedCalls++; return performance.now(); } } });
          const k = instance.exports;
          ensure(k.checks() === 3, 'checks count');
          const checks = [], hashes = [];
          for (let i = 0; i < 3; ++i) {
            checks.push(k.check(i)); hashes.push(k.bits(i).toString(16).padStart(16, '0'));
          }
          ensure(checks.every((c) => c === 0), 'shipped checks ' + a.name);
          ensure(JSON.stringify(hashes) === JSON.stringify(manifest.expected), 'full pins ' + a.name);
          modules.push({ name: a.name, k, checks, hashes, getCalls: () => importedCalls });
        }
        const calibration = [];
        const instrumented = modules.find((m) => m.name === 'instrumented');
        const n = 100000;
        // Warm only the calibration export, not the benchmark workload.
        instrumented.k.profile_calibrate(1000, 0); instrumented.k.profile_calibrate(1000, 1);
        for (let round = 0; round < 12; ++round) {
          const values = {};
          for (const clock of round % 2 ? [1, 0] : [0, 1]) {
            const beforeCalls = instrumented.getCalls(), start = performance.now();
            const checksum = instrumented.k.profile_calibrate(n, clock);
            const elapsed = performance.now() - start;
            const calls = instrumented.getCalls() - beforeCalls;
            ensure(calls === (clock ? n : 0), 'calibration import count');
            ensure(Number.isFinite(checksum), 'calibration observable checksum');
            if (!clock) ensure(checksum === n * (n - 1) / 2, 'empty loop checksum');
            values[clock ? 'clock' : 'empty'] = { elapsed, checksum, calls };
          }
          calibration.push({ round, n, ...values, estimatedImportMs: Math.max(0, values.clock.elapsed - values.empty.elapsed) / n });
        }
        const rounds = [];
        for (let round = 0; round < 8; ++round) {
          const order = round % 2 ? [...modules].reverse() : modules;
          const record = { round, order: order.map((m) => m.name), runs: [] };
          for (const m of order) {
            const { k } = m;
            k.bench_pyramid(100);
            for (let i = 0; i < 60; ++i) k.bench_step();
            const samples = [];
            for (let sample = 0; sample < 40; ++sample) {
              const beforeCalls = m.getCalls(), start = performance.now();
              const awake = k.bench_step();
              const elapsed = performance.now() - start;
              const hostClockCalls = m.getCalls() - beforeCalls;
              // All exports, including the large public state/cache hash, are outside elapsed.
              const phases = manifest.phases.map((_, i) => k.profile_phase(i));
              const entries = manifest.phases.map((_, i) => Number(k.profile_entries(i)));
              const counts = manifest.counts.map((_, i) => Number(k.profile_count(i)));
              const publicCounts = manifest.publicCounts.map((_, i) => k.profile_public_count(i).toString());
              const state = k.profile_state().toString(16).padStart(16, '0');
              const clockCalls = Number(k.profile_clock_calls());
              ensure(awake === 5050, 'awake work ' + m.name);
              ensure(state === reference[sample + 60].state, 'state ' + m.name + ' step ' + (sample + 61));
              ensure(JSON.stringify(publicCounts) === JSON.stringify(reference[sample + 60].counts), 'work ' + m.name);
              ensure(clockCalls === hostClockCalls, 'host/Rust clock count');
              ensure(phases.every((p) => Number.isFinite(p) && p >= 0), 'phase domain');
              if (m.name === 'instrumented') ensure(entries.reduce((a, b) => a + b, 0) + 1 === clockCalls, 'phase entry closure');
              const phaseSum = phases.reduce((a, b) => a + b, 0);
              samples.push({ sample, worldStep: sample + 61, elapsed, phases, phaseSum, outerMinusPhaseSum: elapsed - phaseSum, entries, counts, publicCounts, awake, state, clockCalls, hostClockCalls });
            }
            record.runs.push({ name: m.name, samples });
          }
          rounds.push(record);
        }
        return { userAgent: navigator.userAgent, crossOriginIsolated, checks: modules.map(({ name, checks, hashes }) => ({ name, checks, hashes })), calibration, rounds };
      }, { artifacts: report.artifacts, manifest, reference });
      assert.deepEqual(errors, []);
      assert.equal(result.crossOriginIsolated, true);
      report.browsers.push({ name: name === 'default' ? resolveBrowser({}).name : name, version: browser.version(), ...result });
      console.log(name + ': matched8 rounds complete; all measured states/work and39 clock calls accounted');
      save();
      await page.close();
    } finally { await browser.close(); }
  }
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  save();
  throw error;
} finally {
  report.finished = new Date().toISOString();
  const cpuAfter = cpuTimes();
  report.aggregateCpuBusyPercent = 100 * (1 - (cpuAfter.idle - cpuBefore.idle) / (cpuAfter.total - cpuBefore.total));
  save();
  await closeAll({ servers: [server] });
  await release();
}
