// Whole-app GPU frame time of the Afterlight island (examples/gameplay-sandbox) with each @margoengine/vfx build
// swapped in at the same particle count, light tier (1x MSAA, DPR 1, paced to 60) and full tier (4x MSAA, DPR 1).
// Run on AC power with nothing else using the GPU, after `npm run build:packages`:
//   node examples/package-benchmarks/vfx-island.mjs --variants=base:test-results/vfx-base,new:packages/vfx/dist
//     [--counts=100000,1000000] [--tiers=low,high] [--rounds=4] [--seconds=6] [--label=name]
// Every round runs the variants in alternating order (ABBA...). Frame GPU numbers come from the Stats profiler
// (every 15th frame, all passes timestamped): `span` is first pass start to last pass end, `vfx` the particle
// simulate + draw passes. Variant "off" (always included) has no particles. Sky time and camera are frozen.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, rmdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

const root = resolve(import.meta.dirname, '../..'), arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const config = {variants: [['off', ''], ...arg('variants', 'base:test-results/vfx-base,new:packages/vfx/dist').split(',').map(v => v.split(':'))],
  counts: arg('counts', '100000,1000000').split(',').map(Number), tiers: arg('tiers', 'low,high').split(','), rounds: +arg('rounds', 4), seconds: +arg('seconds', 6), label: arg('label', 'run')};
const power = () => execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline'], {encoding: 'utf8'}).trim() === 'True';
const lock = process.env.MARGO_GPU_LOCK_NESTED ?? resolve(dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {encoding: 'utf8'}).trim()), 'test-results/gpu.lock');
for (;;) {try {mkdirSync(lock); break;} catch (e) {if (e.code !== 'EEXIST') throw e; console.log('GPU lock held, waiting'); await new Promise(r => setTimeout(r, 15000));}}
let server, browser;
const median = v => {const x = v.slice().sort((p, q) => p - q), m = x.length >> 1; return x.length ? x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2 : null;};
try {
  const report = {recordedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {encoding: 'utf8'}).trim(), config, acPowerBefore: power(), runs: []};
  assert.ok(report.acPowerBefore, 'On battery: GPU timing is throttled, run on AC power');
  server = await createServer({root: resolve(root, 'examples/gameplay-sandbox'), configFile: resolve(root, 'examples/gameplay-sandbox/vite.config.ts'),
    server: {host: '127.0.0.1', port: 5198, strictPort: true, fs: {allow: [root]}}, optimizeDeps: {entries: ['index.html']}, logLevel: 'error'});
  await server.listen();
  browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: false,
    args: ['--start-maximized', '--enable-webgpu-developer-features', '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']});
  report.browserVersion = browser.version();
  for (const tier of config.tiers) {
    const context = await browser.newContext({viewport: null}), page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => {if (m.type() === 'error') errors.push(m.text());});
    // The demo does not ask for timestamp queries; add them so the Stats profiler can time every pass.
    await page.addInitScript(() => {const request = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = function (d = {}) {return request.call(this, this.features.has('timestamp-query') ? {...d, requiredFeatures: [...(d.requiredFeatures ?? []), 'timestamp-query']} : d);};});
    await page.goto(`http://127.0.0.1:5198/?quality=${tier}&gpuTiming`);
    await page.waitForFunction(() => window.sandbox && window.afterlightStartup?.phase === 'complete' || document.body.classList.contains('failed'), null, {timeout: 120000});
    const scene = await page.evaluate(() => {const s = sandbox; s.sky.options.timeScale = 0; s.sky.options.hours = 17.6; s.actions.fill(0); s.state[4] = 0; s.state[5] = 0.18;
      const p = s.stats.profiler, read = p.read; window.vfxSamples = []; window.vfxPass = {compute: -1, draw: -1};
      p.read = async function () {const pass = {...vfxPass}, ms = await read.call(this); if (ms !== null) vfxSamples.push({span: this.elapsedMilliseconds, sum: ms, passes: this.passCount,
        vfx: (pass.compute >= 0 ? this.passMilliseconds[pass.compute] : 0) + (pass.draw >= 0 ? this.passMilliseconds[pass.draw] : 0)}); return ms;};
      const c = document.querySelector('canvas'); return {canvas: [c.width, c.height], dpr: devicePixelRatio, margoLow: globalThis.margoLow ?? null, adapter: s.engine.gpu?.adapterInfo?.architecture};});
    for (const count of config.counts) for (let round = 0; round < config.rounds; round++) {
      const order = round % 2 ? config.variants.slice().reverse() : config.variants;
      for (const [name, dist] of order) {
        assert.ok(power(), 'Power dropped to battery; discard this run');
        const row = await page.evaluate(async ({name, url, count, seconds}) => {
          const s = sandbox, p = s.stats.profiler; s.particles?.dispose(); window.vfxEffect?.dispose(); window.vfxEffect = undefined;
          if (url) {const {VFX} = await import(url);
            const e = window.vfxEffect = VFX.attach(s.engine, {capacity: count, initialCount: count, rate: count / 20, position: [0, 4, 0], emissionExtent: [80, 3, 80], velocity: [0, 0.03, 0], gravity: [0, 0, 0],
              spread: 0.08, lifetime: [25, 45], size: 0.01, ground: 0.35, turbulence: 0.035, frequency: 0.22, color: [1, 0.85, 0.4, 0.5], intensity: 5});
            for (const kind of ['simulate', 'draw']) {const run = e[kind]; e[kind] = function (c) {vfxPass[kind === 'simulate' ? 'compute' : 'draw'] = p.state === 'recording' ? p.count : -1; return run.call(this, c);};}}
          else vfxPass.compute = vfxPass.draw = -1;
          await new Promise(r => setTimeout(r, 2500)); vfxSamples.length = 0; const frames = s.timing[1], start = performance.now();
          await new Promise(r => setTimeout(r, seconds * 1000));
          return {name, count, fps: (s.timing[1] - frames) * 1000 / (performance.now() - start), samples: vfxSamples.slice()};
        }, {name, url: dist ? '/@fs/' + resolve(root, dist, 'index.js').replaceAll('\\', '/') : '', count, seconds: config.seconds});
        const summary = {span: median(row.samples.map(x => x.span)), sum: median(row.samples.map(x => x.sum)), vfx: median(row.samples.map(x => x.vfx)), samples: row.samples.length};
        report.runs.push({tier, round, ...row, summary}); console.log(JSON.stringify({tier, round, name, count, fps: +row.fps.toFixed(1), ...summary}));
      }
    }
    report[tier] = {scene, errors}; assert.deepEqual(errors, []); await context.close();
  }
  report.acPowerAfter = power(); assert.ok(report.acPowerAfter, 'Power dropped to battery during the run; discard it');
  report.summary = {};
  for (const tier of config.tiers) for (const count of config.counts) for (const [name] of config.variants) {
    const rows = report.runs.filter(r => r.tier === tier && r.count === count && r.name === name), all = rows.flatMap(r => r.samples);
    report.summary[`${tier}/${count}/${name}`] = {spanMs: median(all.map(x => x.span)), spanRoundMedians: rows.map(r => r.summary.span), vfxMs: median(all.map(x => x.vfx)), fps: median(rows.map(r => r.fps)), samples: all.length};
  }
  console.log(JSON.stringify(report.summary, null, 1));
  const out = resolve(import.meta.dirname, `results/vfx-island-${config.label}.json`); writeFileSync(out, JSON.stringify(report, null, 1) + '\n'); console.log('wrote', out);
} finally {await browser?.close(); await server?.close(); rmdirSync(lock);}
