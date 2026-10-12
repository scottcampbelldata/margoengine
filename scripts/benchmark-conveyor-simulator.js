// Benchmarks the three.js conveyor simulator against its Margo port. Both single-file HTMLs are
// loaded unmodified and driven through the window.freshAssembly API they share.
//   node scripts/benchmark-conveyor-simulator.js "<three.js html>" ["<margo html>"]
// RUNS (default 5) sets how many times each page is measured. Runs are interleaved and alternate which
// page goes first, so drift in machine load lands on both; the report gives medians and ranges.
// Build the Margo file first with examples/conveyor-simulator/build.mjs.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {chromium} from '@playwright/test';
import {summarize} from './benchmark-three-vs-margo.js';

const RUNS = Number(process.env.RUNS ?? 5), WARMUP = 60, FRAMES = 600, PICKS = 48, STAGE_TIMEOUT = 120000, VIEWPORT = {width: 1280, height: 720};
const three = process.argv[2] && resolve(process.argv[2]);
if (!three) throw new Error('Usage: node scripts/benchmark-conveyor-simulator.js <three.js simulator html> [margo simulator html]');
const files = {three, margo: resolve(process.argv[3] ?? join(dirname(three), 'conveyor simulator (margo).html'))};

// Runs in the page before its own scripts: API call counters and the time the assembly became ready.
function instrument() {
  const counts = window.gpuCounts = new Uint32Array(4);
  const wrap = (proto, names, index) => {
    for (const name of proto ? names : []) {const original = proto[name]; if (original) proto[name] = function (a, b, c, d, e) {counts[index]++; return original.call(this, a, b, c, d, e);};}
  };
  wrap(globalThis.GPURenderPassEncoder?.prototype, ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'], 0);
  wrap(globalThis.GPUComputePassEncoder?.prototype, ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect'], 1);
  wrap(globalThis.WebGL2RenderingContext?.prototype, ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'], 2);
  document.addEventListener('fresh-assembly-ready', () => {window.readyAt = performance.now();});
}

// Runs in the page once the assembly is ready. The only engine-specific code is how to place the
// camera and which render function to time; each viewer still draws through its own frame loop.
function installBench() {
  const viewer = window.freshAssembly, isThree = !!viewer.renderer, owner = isThree ? viewer.renderer : viewer.engine, render = owner.render;
  let renderMs = 0, renders = 0;
  owner.render = function (...args) {const start = performance.now(), result = render.apply(this, args); renderMs += performance.now() - start; renders++; return result;};
  const camera = () => isThree ? {position: viewer.camera.position.toArray(), target: viewer.controls.target.toArray()} : {position: [...viewer.camera.position], target: [...viewer.camera.target]};
  const place = position => {
    if (isThree) viewer.camera.position.set(...position); else viewer.camera.position = position;
    viewer.controls.dispatchEvent({type: 'change'}); // Both viewers redraw on the controls' change event.
  };
  const nextFrame = () => new Promise(requestAnimationFrame);
  const steps = {
    orbit(start, phase) {
      const angle = phase * Math.PI * 2, x = start.position[0] - start.target[0], z = start.position[2] - start.target[2];
      place([start.target[0] + x * Math.cos(angle) + z * Math.sin(angle), start.position[1], start.target[2] - x * Math.sin(angle) + z * Math.cos(angle)]);
    },
    explode(_, phase) {viewer.setExplode(0.5 - 0.5 * Math.cos(phase * Math.PI * 2));},
  };
  window.bench = {
    async reset() {viewer.restoreAssembly(); viewer.setView('full', true); await nextFrame(); await nextFrame();},
    async run(kind, warmup, frames) {
      await this.reset();
      const start = camera(), timestamps = [];
      let stepMs = 0;
      for (let i = -warmup; i <= frames; i++) {
        if (i === 0) {window.gpuCounts.fill(0); renderMs = renders = stepMs = 0;}
        const before = performance.now();
        steps[kind](start, (i + warmup) / frames);
        stepMs += performance.now() - before;
        const time = await nextFrame();
        if (i >= 0) timestamps.push(time);
      }
      const result = {timestamps, renders, renderMs: renderMs / renders, stepMs: stepMs / (frames + 1), calls: Array.from(window.gpuCounts, count => count / renders), snapshot: viewer.snapshot()};
      await this.reset();
      return result;
    },
    // Clicks are real mouse input from the runner; this reports how long each one took to be applied.
    // three.js raycasts synchronously inside pointerup. Margo resolves an asynchronous 3x3 ID readback
    // and fires fresh-assembly-pick once the selection is applied.
    watchClick() {
      return new Promise(done => {
        let start, readback = false;
        const finish = () => done({ms: performance.now() - start, selected: viewer.state.selected?.name ?? null, readback});
        addEventListener('pointerup', () => {start = performance.now();}, {capture: true, once: true});
        if (isThree) {addEventListener('pointerup', finish, {once: true}); return;}
        const picking = viewer.picking, pick = picking.onPick;
        picking.onPick = function (...args) {readback = true; return pick.apply(this, args);};
        document.addEventListener('fresh-assembly-pick', () => {picking.onPick = pick; finish();}, {once: true});
      });
    },
  };
}

const server = createServer((request, response) => {
  const file = files[new URL(request.url, 'http://localhost').pathname.slice(1)];
  if (!file) {response.writeHead(204).end(); return;} // The browser also asks for a favicon.
  response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
  createReadStream(file).pipe(response);
}).listen(0, '127.0.0.1');
await new Promise(ready => server.once('listening', ready));

// A stalled page fails the run with the stage name instead of hanging it.
const within = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not finish in ${STAGE_TIMEOUT / 1000} s`)), STAGE_TIMEOUT).unref())]);
const heap = async cdp => (await cdp.send('Performance.getMetrics')).metrics.find(metric => metric.name === 'JSHeapUsedSize').value;
const results = [];
let browser;
try {
  // Frame pacing is uncapped so frame intervals measure the engines, not the display's refresh rate.
  const args = ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit', ...JSON.parse(process.env.BROWSER_ARGS ?? '[]')];
  const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
  browser = await chromium.launch({headless: process.env.HEADED !== '1', channel: channel === 'bundled' ? undefined : channel, args});
  if (!Number.isInteger(RUNS) || RUNS < 1) throw new RangeError('RUNS must be a positive integer');
  for (let run = 0; run < RUNS; run++) for (const name of run % 2 ? ['margo', 'three'] : ['three', 'margo']) {
    const label = `run ${run + 1}/${RUNS} ${name}`;
    const html = await readFile(files[name], 'latin1'), script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
    const context = await browser.newContext({viewport: VIEWPORT, deviceScaleFactor: 1}), page = await context.newPage(), cdp = await context.newCDPSession(page), errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    await cdp.send('Performance.enable');
    await page.addInitScript(instrument);
    console.error(`${label}: loading`);
    await page.goto(`http://127.0.0.1:${server.address().port}/${name}`);
    await page.waitForFunction(() => window.readyAt || window.freshAssembly?.state.error, {}, {timeout: 180000});
    const loaded = await page.evaluate(() => ({readyMs: window.readyAt, error: window.freshAssembly.state.error ?? null, check: window.freshAssembly.state.selfCheck}));
    assert.equal(loaded.error, null, `${name}: ${loaded.error}\n${errors.join('\n')}`);
    assert.ok(loaded.check.passed, `${name} self-check: ${loaded.check.problems.join(' ')}`);
    await page.waitForTimeout(4000); // Both viewers swap in the HDR environment after reporting ready.
    await page.evaluate(installBench);
    await page.evaluate(() => window.bench.reset());
    await page.screenshot({path: `test-results/conveyor-simulator-${name}.png`});

    const entry = {name, run, loadMs: loaded.readyMs, check: loaded.check, scriptBytes: Buffer.byteLength(script, 'latin1'), scriptGzipBytes: gzipSync(Buffer.from(script, 'latin1')).length};
    for (const kind of ['orbit', 'explode']) {
      console.error(`${label}: ${kind}`);
      const collections = [];
      const collect = event => {for (const item of event.value) if ((item.name === 'MinorGC' || item.name === 'MajorGC') && item.ph === 'X') collections.push(item.name);};
      await cdp.send('HeapProfiler.collectGarbage');
      const before = await heap(cdp);
      cdp.on('Tracing.dataCollected', collect);
      await cdp.send('Tracing.start', {categories: 'devtools.timeline,v8', transferMode: 'ReportEvents'});
      const run = await within(page.evaluate(([kind, warmup, frames]) => window.bench.run(kind, warmup, frames), [kind, WARMUP, FRAMES]), `${name} ${kind}`);
      const after = await heap(cdp), traced = new Promise(done => cdp.once('Tracing.tracingComplete', done));
      await cdp.send('Tracing.end'); await traced; cdp.off('Tracing.dataCollected', collect);
      assert.ok(run.renders >= FRAMES, `${name} ${kind}: only ${run.renders} renders in ${FRAMES} frames`);
      entry[kind] = {...summarize(run.timestamps), renderMs: run.renderMs, stepMs: run.stepMs, calls: run.calls, heapDelta: after - before,
        minorGCs: collections.filter(type => type === 'MinorGC').length, majorGCs: collections.filter(type => type === 'MajorGC').length};
      entry.snapshot = run.snapshot;
    }

    console.error(`${label}: picking`);
    const box = await page.locator('#assembly-canvas').boundingBox(), picks = [];
    for (let i = 0; i < PICKS; i++) {
      const x = box.x + box.width * (0.2 + 0.6 * (i % 8) / 7), y = box.y + box.height * (0.3 + 0.4 * Math.floor(i / 8) / 5);
      await page.evaluate(() => {window.clicked = window.bench.watchClick();}); // Listeners are in place before the click is sent.
      await page.mouse.click(x, y);
      picks.push(await within(page.evaluate(() => window.clicked), `${name} click ${i + 1}`));
      await page.waitForTimeout(50);
    }
    const median = hit => {const sorted = picks.filter(pick => !!pick.selected === hit).map(pick => pick.ms).sort((a, b) => a - b); return sorted.length ? sorted[sorted.length >> 1] : NaN;};
    entry.pick = {hitMedian: median(true), missMedian: median(false), max: Math.max(...picks.map(pick => pick.ms)), hits: picks.filter(pick => pick.selected).length, readbacks: picks.filter(pick => pick.readback).length, selected: picks.map(pick => pick.selected), readback: picks.map(pick => pick.readback)};
    await cdp.send('HeapProfiler.collectGarbage');
    entry.heapBytes = await heap(cdp);
    entry.backend = await page.evaluate(() => window.freshAssembly.renderer ? 'webgl2' : window.freshAssembly.engine.backend);
    entry.hardware = await page.evaluate(async () => {const info = (await navigator.gpu?.requestAdapter({powerPreference: 'high-performance'}))?.info; return info ? {vendor: info.vendor, architecture: info.architecture, fallback: info.isFallbackAdapter ?? null} : null;});
    assert.deepEqual(errors, [], `${name} reported errors`);
    results.push(entry);
    await context.close();
  }

  const runs = {three: results.filter(entry => entry.name === 'three'), margo: results.filter(entry => entry.name === 'margo')};
  const agreement = runs.three.map((entry, i) => entry.pick.selected.filter((part, click) => part === runs.margo[i].pick.selected[click]).length);
  const median = values => {const sorted = [...values].sort((x, y) => x - y), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;};
  // "median (min to max)" over the runs of one page; a single value when they all agree.
  const spread = (entries, value, digits) => {
    const values = entries.map(value).filter(Number.isFinite);
    if (!values.length) return 'n/a';
    const low = Math.min(...values).toFixed(digits), high = Math.max(...values).toFixed(digits);
    return low === high ? low : `${median(values).toFixed(digits)} (${low} to ${high})`;
  };
  const mb = bytes => bytes / 1048576, kib = bytes => (bytes / 1024).toFixed(1);
  const row = (label, format) => `| ${label} | ${format(runs.three)} | ${format(runs.margo)} |`;
  const scenario = (kind, title) => [
    row(`${title}: frames per second`, r => spread(r, e => 1000 / e[kind].mean, 0)),
    row(`${title}: frame interval mean (ms)`, r => spread(r, e => e[kind].mean, 2)),
    row(`${title}: frame interval p95 (ms)`, r => spread(r, e => e[kind].p95, 2)),
    row(`${title}: frame interval p99 (ms)`, r => spread(r, e => e[kind].p99, 2)),
    row(`${title}: render call on the main thread (ms)`, r => spread(r, e => e[kind].renderMs, 3)),
    row(`${title}: draw / compute-dispatch calls per frame`, r => `${spread(r, e => e[kind].calls[0] + e[kind].calls[2], 0)} / ${spread(r, e => e[kind].calls[1], 0)}`),
    row(`${title}: heap change (MB)`, r => spread(r, e => mb(e[kind].heapDelta), 1)),
    row(`${title}: minor GCs`, r => spread(r, e => e[kind].minorGCs, 0)),
    row(`${title}: major GCs`, r => spread(r, e => e[kind].majorGCs, 0)),
  ];
  const agreed = Math.min(...agreement) === Math.max(...agreement) ? agreement[0] : `${Math.min(...agreement)} to ${Math.max(...agreement)}`;
  const lines = [
    '# Conveyor simulator: three.js vs Margo',
    '',
    `Captured ${new Date().toISOString()} with ${browser.version()} (${process.env.HEADED === '1' ? 'headed' : 'headless'}), ${VIEWPORT.width}x${VIEWPORT.height} at device pixel ratio 1, adapter \`${JSON.stringify(runs.margo[0].hardware)}\`.`,
    '',
    `Both pages embed the same 569-part GLB, HDR environment and assembly facts. Each page was measured ${RUNS} time${RUNS === 1 ? '' : 's'} in a fresh browser context, interleaved and alternating which page ran first. Cells show the median over those runs with the range in brackets. Each scenario runs ${WARMUP} warm-up frames and ${FRAMES} measured frames with vsync and the frame-rate limit disabled.`,
    '',
    `| | three.js (${runs.three[0].backend}) | Margo (${runs.margo[0].backend}) |`,
    '|---|---:|---:|',
    row('Viewer script, raw / gzip (KiB)', r => `${kib(r[0].scriptBytes)} / ${kib(r[0].scriptGzipBytes)}`),
    row('Navigation to assembly ready (ms)', r => spread(r, e => e.loadMs, 0)),
    row('JS heap after all scenarios (MB)', r => spread(r, e => mb(e.heapBytes), 1)),
    row('Parts / triangles drawn', r => `${r[0].snapshot.physicalParts} / ${r[0].snapshot.renderer.triangles}`),
    ...scenario('orbit', 'Orbit'),
    ...scenario('explode', 'Explode sweep'),
    row('Explode sweep: state update per frame (ms)', r => spread(r, e => e.explode.stepMs, 3)),
    row(`Clicks that selected a part, of ${PICKS}`, r => spread(r, e => e.pick.hits, 0)),
    row('Click on a part to selection, per-run median (ms)', r => spread(r, e => e.pick.hitMedian, 1)),
    row('Click on empty space, per-run median (ms)', r => spread(r, e => e.pick.missMedian, 1)),
    row('Slowest click in a run (ms)', r => spread(r, e => e.pick.max, 1)),
    row('Clicks that needed a GPU readback', r => spread(r, e => e.pick.readbacks, 0)),
    '',
    `The two viewers selected the same part (or both missed) on ${agreed} of ${PICKS} clicks per run.`,
    '',
    '## What is not equal',
    '',
    '- three.js renders through WebGL2 with 4x MSAA; Margo renders through WebGPU with no multisampling. Margo shades fewer samples per pixel.',
    '- Margo draws a 2-pixel jump-flood outline on the selected part; three.js draws a bounding box.',
    '- Lighting is matched in kind (two directional lights, a hemisphere light, HDR image-based lighting, ACES filmic tone mapping at exposure 1.08) but not pixel for pixel.',
    '- Frame intervals are requestAnimationFrame cadence with pacing uncapped. They include GPU back-pressure in both engines but are not a GPU timing. "Render call" is main-thread time inside `renderer.render` / `engine.render` only.',
    '- three.js selects inside the click event. Margo skips the GPU when the click ray misses the bounding box of every visible part; otherwise it renders a culled 3x3 ID pass and awaits its readback. Click time ends when the port reports the selection applied.',
    '- three.js casts a ray through the exact click point. Margo prefers the center pixel, then its neighbors within one pixel; silhouette selections can therefore differ.',
    '- Heap change is retained plus not-yet-collected heap after a forced GC before the scenario, not bytes allocated. Tracing and call counting add overhead to both.',
    '- One machine, one browser. Frame rates at this level move with machine load; compare the ranges, not single values.',
    '',
  ];
  await mkdir('test-results', {recursive: true});
  await writeFile('benchmarks/conveyor-simulator.md', lines.join('\n'));
  await writeFile('test-results/benchmark-conveyor-simulator.json', JSON.stringify(results, null, 2));
  console.log(lines.slice(6, lines.indexOf('## What is not equal') - 1).join('\n'));
} finally {
  await browser?.close();
  server.close();
}
