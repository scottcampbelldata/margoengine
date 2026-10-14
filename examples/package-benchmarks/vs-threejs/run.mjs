// Margo vs three.js on the same machine, same scenes, same canvas. From the repository root after `npm run build:packages`:
//   node examples/package-benchmarks/vs-threejs/run.mjs [--rounds=5] [--only=boxes] [--frames=300] [--out=path.json]
// 1. Builds one minified production bundle per engine with Vite (Margo; three.js WebGLRenderer; three.js WebGPURenderer
//    with 'three' aliased to 'three/webgpu'), per-scene code split into lazy chunks.
// 2. Serves the repository over plain HTTP (no compression, no cache, cross-origin isolated for 5 µs timers).
// 3. Each run is a fresh headless browser (cold shader cache, fresh profile) with vsync and the frame-rate cap off, at
//    1280x720 CSS px and DPR 1. Engines alternate within each round and the order rotates every round.
// 4. Takes the GPU lock (test-results/gpu.lock in the main checkout; 60 s poll) and refuses to run on battery.
// Writes examples/package-benchmarks/results/vs-threejs.json (or --out) and screenshots to test-results/vs-threejs/.
import {chromium} from '@playwright/test';
import {build} from 'vite';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, extname, join, resolve, sep} from 'node:path';
import {gzipSync} from 'node:zlib';
import {cpus, totalmem} from 'node:os';
import {acPower} from '../cad/power.mjs';
import {decodePNG} from '../../../tests/support/png.js';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const rounds = +arg('rounds', 5), only = arg('only', ''), frames = +arg('frames', 300), port = +arg('port', 5251), out = arg('out', 'examples/package-benchmarks/results/vs-threejs.json');
const root = process.cwd(), here = 'examples/package-benchmarks/vs-threejs', dist = 'test-results/vs-threejs/dist';
const git = (...a) => execFileSync('git', a, {encoding: 'utf8'}).trim();
const three = JSON.parse(readFileSync('node_modules/three/package.json', 'utf8')).version;

const configs = [
  {scene: 'boxes', n: 1000}, {scene: 'boxes', n: 10000}, {scene: 'boxes', n: 50000}, {scene: 'boxes', n: 10000, move: 1},
  {scene: 'cad', n: 10000}, {scene: 'cad', n: 50000}, {scene: 'helmet'},
].filter(c => !only || only.split(',').some(o => `${c.scene}:${c.n ?? ''}`.startsWith(o)));
const variants = c => [{engine: 'margo'}, {engine: 'three-webgl', mode: 'mesh'}, {engine: 'three-webgpu', mode: 'mesh'}, ...(c.scene === 'helmet' ? [] : [{engine: 'three-webgl', mode: 'instanced'}, {engine: 'three-webgpu', mode: 'instanced'}])];
const key = c => `${c.scene}${c.n ? `-${c.n}` : ''}${c.move ? '-moving' : ''}`, vkey = v => `${v.engine}${v.mode === 'instanced' ? '-instanced' : ''}`;

// GPU lock in the main checkout: one wait loop, 60 s poll.
const lock = resolve(dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir')), 'test-results/gpu.lock');
for (;;) {try {mkdirSync(lock);break;} catch (e) {if (e.code !== 'EEXIST') throw e;console.log(new Date().toISOString(), 'gpu.lock held, waiting 60 s');await new Promise(r => setTimeout(r, 60_000));}}
let server;
try {
  const report = {date: new Date().toISOString(), commit: git('rev-parse', '--short', 'HEAD'), three, acPowerBefore: acPower(), rounds, frames, canvas: [1280, 720], dpr: 1,
    // Publishable only with the defaults (5 rounds x 300 frames) on a quiet machine: nothing else running, no other GPU job.
    note: rounds >= 5 && frames >= 300 && !only ? (process.env.BENCH_QUIET === '1' ? 'full run, operator confirmed a quiet machine' : 'full run; set BENCH_QUIET=1 once the machine is confirmed quiet') : 'SMOKE TEST, NOT FOR PUBLICATION',
    host: {cpu: cpus()[0].model, cores: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), os: process.platform, node: process.version}, bundles: {}, results: {}};
  if (report.acPowerBefore === false && process.env.BENCH_ALLOW_BATTERY !== '1') throw new Error('On battery: plug in (BENCH_ALLOW_BATTERY=1 records anyway).');

  // 1. Production bundles.
  for (const engine of ['margo', 'three-webgl', 'three-webgpu']) {
    await build({configFile: false, publicDir: false, logLevel: 'warn', resolve: {alias: engine === 'three-webgpu' ? [{find: /^three$/, replacement: 'three/webgpu'}] : []},
      build: {outDir: `${dist}/${engine}`, emptyOutDir: true, minify: true, target: 'es2022', reportCompressedSize: false, lib: {entry: `${here}/${engine}.js`, formats: ['es'], fileName: engine}}});
    report.bundles[engine] = Object.fromEntries(readdirSync(`${dist}/${engine}`).map(f => {const b = readFileSync(`${dist}/${engine}/${f}`);return [f, {raw: b.length, gzip: gzipSync(b, {level: 9}).length}];}));
  }
  const gzipOf = path => {const [engine, file] = path.split('/').slice(-2);return report.bundles[engine]?.[file]?.gzip ?? 0;};

  // 2. Static server.
  const types = {'.js': 'text/javascript', '.html': 'text/html', '.glb': 'model/gltf-binary', '.json': 'application/json', '.wasm': 'application/wasm'};
  server = createServer((req, res) => {
    const file = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root + sep)) {res.writeHead(403).end();return;}
    try {const body = readFileSync(file);res.writeHead(200, {'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp'}).end(body);}
    catch {res.writeHead(404).end();}
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));

  // 3. Runs.
  const args = ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-precise-memory-info', '--js-flags=--expose-gc', '--enable-webgpu-developer-features'];
  const shots = 'test-results/vs-threejs';mkdirSync(shots, {recursive: true});
  const once = async (config, variant, round) => {
    const browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true, args});
    try {
      const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1}), errors = [];
      page.on('pageerror', e => errors.push(e.message));page.on('console', m => {if (m.type() === 'error') errors.push(m.text());});
      const query = new URLSearchParams({engine: variant.engine, scene: config.scene, n: config.n ?? 0, move: config.move ?? 0, mode: variant.mode ?? 'mesh', frames});
      await page.goto(`http://127.0.0.1:${port}/${here}/index.html?${query}`);
      if (!report.hardware) report.hardware = {browser: browser.version(), ...await page.evaluate(async () => {
        const a = await navigator.gpu?.requestAdapter({powerPreference: 'high-performance'}), c = document.createElement('canvas').getContext('webgl2'), ext = c?.getExtension('WEBGL_debug_renderer_info');
        return {webgpu: a ? {vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description} : null, webgl: ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null, userAgent: navigator.userAgent};
      })};
      await page.waitForFunction(() => window.result, null, {timeout: 600_000});
      const result = await page.evaluate(() => window.result);result.pageErrors = errors;
      result.jsGzipBytes = result.resources?.filter(r => r.name.startsWith(`/${dist}/`)).reduce((s, r) => s + gzipOf(r.name), 0);
      if (round === 0) result.png = await page.locator('canvas').screenshot({path: `${shots}/${key(config)}-${vkey(variant)}.png`});
      return result;
    } finally {await browser.close();}
  };
  for (let round = 0; round < rounds; round++) for (const config of configs) {
    const list = variants(config), order = list.map((_, i) => list[(i + round) % list.length]);
    for (const variant of order) {
      if (acPower() === false && process.env.BENCH_ALLOW_BATTERY !== '1') throw new Error('On battery mid-run');
      const r = await once(config, variant, round), slot = ((report.results[key(config)] ??= {})[vkey(variant)] ??= {runs: []});
      if (r.png) {slot.png = r.png;delete r.png;}
      slot.runs.push(r);
      console.log(`round ${round + 1}/${rounds}`, key(config), vkey(variant), r.error ? `ERROR ${r.error.split('\n')[0]}` : JSON.stringify({load: r.loadMs, fps: r.throughput.fps, cpu: r.throughput.cpuMs?.median, gpu: r.gpu?.gpuMs?.median, serial: r.serialFrameMs?.median, heap: r.jsHeapMB, draws: r.info?.drawCalls, errors: [...r.errors, ...r.pageErrors].length}));
    }
  }

  // 4. Summary: median over rounds of each run's median; visual difference against Margo's frame.
  const median = a => {const s = a.filter(x => x != null).sort((x, y) => x - y);return s.length ? +(s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(2) : null;};
  for (const [name, byVariant] of Object.entries(report.results)) {
    const ref = byVariant.margo?.png && await decodePNG(byVariant.margo.png);
    for (const slot of Object.values(byVariant)) {
      const ok = slot.runs.filter(r => !r.error), pick = f => median(ok.map(f));
      slot.summary = {runs: slot.runs.length, failed: slot.runs.length - ok.length, loadMs: pick(r => r.loadMs), createMs: pick(r => r.createMs), buildMs: pick(r => r.buildMs), firstFrameMs: pick(r => r.firstFrameMs),
        fps: pick(r => r.throughput.fps), cpuMs: pick(r => r.throughput.cpuMs?.median), gpuMs: pick(r => r.gpu?.gpuMs?.median), serialFrameMs: pick(r => r.serialFrameMs?.median), jsHeapMB: pick(r => r.jsHeapMB),
        jsGzipBytes: ok[0]?.jsGzipBytes, drawCalls: ok[0]?.info?.drawCalls, samples: ok[0]?.samples, gpuMethod: ok[0]?.gpu?.method, errors: [...new Set(slot.runs.flatMap(r => [...r.errors, ...r.pageErrors]))].slice(0, 5)};
      if (ref && slot.png) {
        const img = await decodePNG(slot.png);let sum = 0, big = 0;
        for (let i = 0; i < img.data.length; i += 4) {const d = Math.max(Math.abs(img.data[i] - ref.data[i]), Math.abs(img.data[i + 1] - ref.data[i + 1]), Math.abs(img.data[i + 2] - ref.data[i + 2]));sum += d;if (d > 16) big++;}
        slot.summary.vsMargoImage = {meanMaxChannelDiff: +(sum / (img.width * img.height)).toFixed(2), over16Fraction: +(big / (img.width * img.height)).toFixed(4)};
      }
      delete slot.png;
    }
  }
  report.acPowerAfter = acPower();
  mkdirSync(dirname(out), {recursive: true});writeFileSync(out, JSON.stringify(report, null, 1));
  console.table(Object.fromEntries(Object.entries(report.results).flatMap(([name, v]) => Object.entries(v).map(([variant, s]) => [`${name} ${variant}`, (({loadMs, fps, cpuMs, gpuMs, serialFrameMs, jsHeapMB, drawCalls}) => ({loadMs, fps, cpuMs, gpuMs, serialFrameMs, jsHeapMB, drawCalls}))(s.summary)]))));
  console.log('wrote', out, 'AC before/after', report.acPowerBefore, report.acPowerAfter);
  if (report.acPowerAfter === false) console.log('WARNING: ended on battery; discard this run.');
} finally {server?.close();rmSync(lock, {recursive: true, force: true});}
