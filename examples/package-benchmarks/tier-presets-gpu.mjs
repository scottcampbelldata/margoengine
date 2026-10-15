// Light tier with and without the tier presets (HANDOFF 5i.b), on the island (examples/gameplay-sandbox) and the depth-of-field
// demo (packages/dof/examples). Each run loads the page fresh at `?quality=low` (1x MSAA, DPR 1, paced to ~60 FPS);
// variant "off" blocks `globalThis.margoPreset` before the page runs (every package keeps its defaults), "on" is the page
// as shipped. Rounds alternate the order (ABBA). Island: engine frames per second and the Stats profiler's whole-frame GPU
// span (every 15th frame, all passes timestamped). DOF: submits per second (one per frame) and submit-to-done GPU time.
// Run after `npm run build:packages`, through the GPU lock, on AC power:
//   node scripts/gpu-lock.mjs run --owner=<id> -- node examples/package-benchmarks/tier-presets-gpu.mjs [--pages=island,dof] [--rounds=4] [--seconds=6]
// Timings count only after scripts/quiet-gate.mjs passes; when the machine stays busy the result is labelled diagnostic.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {onAC, waitForQuiet} from '../../scripts/quiet-gate.mjs';

const root = resolve(import.meta.dirname, '../..'), arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const config = {pages: arg('pages', 'island,dof').split(','), rounds: +arg('rounds', 4), seconds: +arg('seconds', 6), label: arg('label', 'run')};
const median = v => {const x = v.slice().sort((p, q) => p - q), m = x.length >> 1; return x.length ? x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2 : null;};
const pct = (v, f) => {const x = v.slice().sort((p, q) => p - q); return x.length ? x[Math.min(x.length - 1, Math.floor(x.length * f))] : null;};
const pages = {
  island: {root: 'examples/gameplay-sandbox', configFile: 'examples/gameplay-sandbox/vite.config.ts', port: 5196, query: '?quality=low&gpuTiming',
    ready: () => window.sandbox && window.afterlightStartup?.phase === 'complete' || document.body.classList.contains('failed'),
    // Freeze the sky clock and the camera; the island's particle menu stays at its light-tier default.
    prepare: () => {const s = sandbox; s.sky.options.timeScale = 0; s.sky.options.hours = 17.6; s.actions.fill(0); s.state[4] = 0; s.state[5] = 0.18;
      const p = s.stats.profiler, read = p.read; window.presetSpans = [];
      p.read = async function () {const ms = await read.call(this); if (ms !== null) presetSpans.push(this.elapsedMilliseconds); return ms;};
      return {frames: () => s.timing[1], particles: s.particles?.capacity ?? 0, shadowResolution: s.shadows.options.resolution};}},
  dof: {root: 'packages/dof/examples', port: 5197, query: '?quality=low', ready: () => !!window.dofDemo || /Unable/.test(document.querySelector('#status')?.textContent ?? ''),
    prepare: () => ({maxRadius: dofDemo.effect.options.maxRadius ?? 16})},
};
// Before any page script: count submits and time each one to onSubmittedWorkDone; "off" makes margoPreset unassignable.
const probe = off => {
  if (off) Object.defineProperty(globalThis, 'margoPreset', {get: () => undefined, set() {}, configurable: false});
  const t = window.presetProbe = {submits: 0, gpu: []}, submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (buffers) {const start = performance.now(), result = submit.call(this, buffers); t.submits++;
    this.onSubmittedWorkDone().then(() => t.gpu.push(performance.now() - start)); return result;};
  const request = GPUAdapter.prototype.requestDevice; // the Stats profiler needs timestamp queries (island)
  GPUAdapter.prototype.requestDevice = function (d = {}) {return request.call(this, this.features.has('timestamp-query') ? {...d, requiredFeatures: [...(d.requiredFeatures ?? []), 'timestamp-query']} : d);};
};

const report = {recordedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), config, runs: []};
assert.ok(onAC(), 'On battery: GPU timing is throttled, run on AC power');
try {if (process.argv.includes('--no-quiet')) throw new Error('--no-quiet'); report.machine = await waitForQuiet({timeout: 600}); report.diagnostic = false;}
catch (error) {if (!onAC()) throw error; report.diagnostic = true; report.machine = {note: String(error.message)}; console.error('DIAGNOSTIC run:', error.message);}
const servers = [];
let browser;
try {
  browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: false,
    args: ['--start-maximized', '--enable-webgpu-developer-features', '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']});
  report.browserVersion = browser.version();
  for (const name of config.pages) {
    const page = pages[name], server = await createServer({root: resolve(root, page.root), configFile: page.configFile ? resolve(root, page.configFile) : false,
      server: {host: '127.0.0.1', port: page.port, strictPort: true, fs: {allow: [root]}}, optimizeDeps: {entries: ['index.html']}, logLevel: 'error'});
    await server.listen(); servers.push(server);
    for (let round = 0; round < config.rounds; round++) for (const variant of round % 2 ? ['on', 'off'] : ['off', 'on']) {
      assert.ok(onAC(), 'Power dropped to battery; discard this run');
      const context = await browser.newContext({viewport: null}), tab = await context.newPage(), errors = [];
      tab.on('pageerror', e => errors.push(e.message)); tab.on('console', m => {if (m.type() === 'error' && !m.location().url.endsWith('favicon.ico')) errors.push(m.text());});
      await tab.addInitScript(probe, variant === 'off');
      await tab.goto(`http://127.0.0.1:${page.port}/${page.query}`);
      await tab.waitForFunction(page.ready, null, {timeout: 120000});
      const row = await tab.evaluate(async ({prepare, seconds}) => {
        const scene = (0, eval)(`(${prepare})`)(), frames = scene.frames ?? (() => presetProbe.submits), c = document.querySelector('canvas');
        await new Promise(r => setTimeout(r, 3000)); window.presetSpans && (presetSpans.length = 0);
        const gpuFrom = presetProbe.gpu.length, f0 = frames(), s0 = presetProbe.submits, t0 = performance.now();
        await new Promise(r => setTimeout(r, seconds * 1000));
        const elapsed = performance.now() - t0, {frames: _, ...facts} = scene;
        return {fps: (frames() - f0) * 1000 / elapsed, submitsPerSecond: (presetProbe.submits - s0) * 1000 / elapsed, gpu: presetProbe.gpu.slice(gpuFrom), spans: window.presetSpans?.slice() ?? [],
          preset: globalThis.margoPreset ?? null, margoLow: globalThis.margoLow ?? null, canvas: [c.width, c.height], ...facts};
      }, {prepare: page.prepare.toString(), seconds: config.seconds});
      await context.close();
      assert.deepEqual(errors, [], `${name} ${variant}: page errors`);
      assert.equal(row.margoLow, 1, 'light tier'); assert.equal(row.preset === null, variant === 'off', 'variant controls the preset');
      const summary = {fps: +row.fps.toFixed(1), submitsPerSecond: +row.submitsPerSecond.toFixed(1), gpuP50: median(row.gpu), gpuP90: pct(row.gpu, 0.9), spanP50: median(row.spans), spanP90: pct(row.spans, 0.9), spans: row.spans.length};
      report.runs.push({page: name, variant, round, ...row, gpu: undefined, spans: undefined, summary});
      console.log(JSON.stringify({page: name, variant, round, canvas: row.canvas, particles: row.particles, shadowResolution: row.shadowResolution, maxRadius: row.maxRadius, ...summary}));
    }
  }
  assert.ok(onAC(), 'Power dropped to battery during the run; discard it');
  report.summary = {};
  for (const name of config.pages) for (const variant of ['off', 'on']) {
    const rows = report.runs.filter(r => r.page === name && r.variant === variant).map(r => r.summary), m = key => median(rows.map(r => r[key]).filter(v => v !== null));
    report.summary[`${name}/${variant}`] = {fps: m('fps'), submitsPerSecond: m('submitsPerSecond'), gpuP50: m('gpuP50'), gpuP90: m('gpuP90'), spanP50: m('spanP50'), spanP90: m('spanP90'), rounds: rows.length};
  }
  console.log(JSON.stringify(report.summary, null, 1));
  const out = resolve(import.meta.dirname, `results/tier-presets-${config.label}.json`); writeFileSync(out, JSON.stringify(report, null, 1) + '\n'); console.log('wrote', out);
} finally {await browser?.close(); for (const server of servers) await server.close();}
