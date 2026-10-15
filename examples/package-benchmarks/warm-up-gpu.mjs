// First-use hitch per feature with and without warmUp (@margoengine/quality/warm, HANDOFF 5i.c), real GPU.
// After npm run build:packages, on AC power, holding the GPU lock:
//   node scripts/gpu-lock.mjs run --owner=<id> -- node examples/package-benchmarks/warm-up-gpu.mjs [--runs=3] [--only=ssao,dof] [--no-quiet]
// Every sample launches a fresh browser (fresh profile: cold shader caches, as on a first visit). Runs the quiet gate
// first unless --no-quiet (then, or if it times out, the numbers are diagnostic). The final frame of each warm sample is compared with the
// cold sample of the same feature (delta 0 everywhere, so the images should match): `image` = max RGB difference and
// share of differing pixels. Writes examples/package-benchmarks/results/warm-up-gpu.json.
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {waitForQuiet, onAC} from '../../scripts/quiet-gate.mjs';
import {decodePNG} from '../../tests/support/png.js';

const root = resolve(import.meta.dirname, '../..'), arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const runs = Number(arg('runs') ?? 3), only = (arg('only') ?? '').split(',').filter(Boolean);
const features = ['ssao', 'bloom', 'dof', 'tonemap', 'shadows', 'sky', 'grass'].filter(f => !only.length || only.includes(f));
// The quiet gate waits at most 5 minutes (this runs holding the GPU lock); a machine that never got quiet is recorded and
// the numbers are labelled diagnostic.
if (!onAC()) throw new Error('On battery: plug in before timing runs');
const quiet = process.argv.includes('--no-quiet') ? null : await waitForQuiet({timeout: 300}).catch(error => ({failed: String(error.message ?? error)}));
const server = await createServer({root, configFile: false, logLevel: 'error', optimizeDeps: {noDiscovery: true, include: []}, server: {host: '127.0.0.1', port: 0, hmr: false}});
await server.listen();
const url = new URL('examples/package-benchmarks/warm-up.html', server.resolvedUrls.local[0]).href;
const channel = process.env.BROWSER_CHANNEL ?? 'msedge', samples = [], shots = new Map();
let environment;
try {
  // Alternate cold and warm runs so drift (thermals, background load) hits both equally.
  for (let run = 0; run < runs; run++) for (const feature of features) for (const warm of [false, true]) {
    const browser = await chromium.launch({channel, headless: true, args: ['--enable-unsafe-webgpu']});
    try {
      const page = await browser.newPage({viewport: {width: 1280, height: 720}}), errors = [];
      page.on('pageerror', e => errors.push(e.message)); page.on('console', m => {if (m.type() === 'error') errors.push(m.text());});
      await page.goto(url); await page.waitForFunction(() => window.ready);
      environment ??= {browser: `${channel} ${browser.version()}`, gpu: await page.evaluate(async () => {const i = (await navigator.gpu.requestAdapter()).info; return [i.vendor, i.architecture, i.description].filter(Boolean).join(' ');})};
      const result = await page.evaluate(options => window.run(options), {feature, warm});
      if (errors.length) result.errors = errors;
      const image = await decodePNG(await page.screenshot()), cold = !warm && image;
      if (warm) {
        const before = shots.get(feature + run);
        let max = 0, changed = 0;
        for (let i = 0; i < image.data.length; i += 4) {const d = Math.max(...[0, 1, 2].map(c => Math.abs(image.data[i + c] - before.data[i + c]))); max = Math.max(max, d); changed += d > 0;}
        result.image = {maxDiff: max, changed: +(changed / (image.data.length / 4)).toFixed(5)};
      } else shots.set(feature + run, cold);
      samples.push(result);
      console.log(`${feature} ${warm ? 'warm' : 'cold'}: first ${result.firstFrameMs.toFixed(1)} ms, next ${result.nextFrameMs.toFixed(1)}, steady ${result.afterMedianMs.toFixed(1)}${warm ? `, warmUp ${result.warmUpMs.toFixed(0)} ms ${JSON.stringify(result.report)} image vs cold ${JSON.stringify(result.image)}` : ''}${errors.length ? ' ERRORS ' + errors[0] : ''}`);
    } finally {await browser.close();}
  }
} finally {await server.close();}
const median = values => values.sort((a, b) => a - b)[values.length >> 1], pick = (feature, warm) => samples.filter(s => s.feature === feature && s.warm === warm);
const summary = Object.fromEntries(features.map(feature => [feature, Object.fromEntries([false, true].map(warm => {
  const s = pick(feature, warm);
  return [warm ? 'warm' : 'cold', {firstFrameMs: +median(s.map(x => x.firstFrameMs)).toFixed(1), hitchMs: +median(s.map(x => x.hitchMs)).toFixed(1), steadyMs: +median(s.map(x => x.afterMedianMs)).toFixed(1),
    ...(warm ? {warmUpMs: +median(s.map(x => x.warmUpMs)).toFixed(0), firstWarmFrameMs: +median(s.map(x => x.warmFramesMs[0] ?? 0)).toFixed(1), pipelines: median(s.map(x => x.report.pipelines)), fallbacks: median(s.map(x => x.report.fallbacks)),
      rebooted: s.some(x => x.report.rebooted), imageMaxDiff: Math.max(...s.map(x => x.image.maxDiff))} : {})}];
}))]));
console.table(Object.fromEntries(Object.entries(summary).map(([f, {cold, warm}]) => [f, {coldFirst: cold.firstFrameMs, warmFirst: warm.firstFrameMs, steady: cold.steadyMs, warmUpMs: warm.warmUpMs, firstWarmFrame: warm.firstWarmFrameMs, pipelines: warm.pipelines, fallbacks: warm.fallbacks, rebooted: warm.rebooted, imageMaxDiff: warm.imageMaxDiff}])));
const report = {method: 'Fresh browser per sample (cold shader caches). helmet + floor, 1280x720 DPR 1, default tier (4x MSAA, no ?quality); feature attached after 40 steady frames. ' +
  'Frame = render() call to queue.onSubmittedWorkDone. firstFrameMs: first visible frame that draws the feature (cold: right after attach; warm: after await warmUp(engine), whose warm frames are offscreen). hitchMs = first - steady median after. Medians over runs.',
  diagnostic: !quiet || !!quiet.failed, quiet, acPowerAfter: onAC(), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), recordedAt: new Date().toISOString(), environment, runs, summary, samples};
mkdirSync(resolve(import.meta.dirname, 'results'), {recursive: true});
writeFileSync(resolve(import.meta.dirname, 'results/warm-up-gpu.json'), JSON.stringify(report, null, 1) + '\n');
