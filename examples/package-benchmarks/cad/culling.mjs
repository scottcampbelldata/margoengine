// Real-GPU benchmark and pixel check for @margoengine/culling. From the repository root, after `npm run build:packages`:
//   node examples/package-benchmarks/cad/culling.mjs [--sizes=10000,50000,max] [--modes=core,none,frustum,occlusion] [--views=orbit,still,grazing] [--layouts=sheet,stack] [--check] [--label=culling]
// Takes test-results/gpu.lock (waits while another GPU run holds it), checks AC power before every run and repeats a run
// that started or ended on battery. Writes examples/package-benchmarks/cad/results-<label>.json.
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {writeFile, mkdir, rm} from 'node:fs/promises';
import {cpus, totalmem} from 'node:os';
import {execFileSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {acPower} from './power.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const flag = name => process.argv.includes(`--${name}`);
const list = (name, fallback) => arg(name, fallback).split(',').filter(Boolean);
const sizes = list('sizes', '10000,50000,max'), modes = list('modes', 'core,none,frustum,occlusion'), views = list('views', 'orbit,still'), layouts = list('layouts', 'sheet'), label = arg('label', 'culling'), port = +arg('port', 5232);
const modulesFor = size => size === 'max' ? Math.floor((100_000 - 1 - 105) / 30) : Math.ceil(+size / 27);
// The lock lives in the main checkout so git worktrees share it.
const lock = resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {encoding: 'utf8'}).trim(), '../test-results/gpu.lock');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitForAC() {while (acPower() === false) {console.log('on battery, waiting for AC');await sleep(30_000);}}

await mkdir(dirname(lock), {recursive: true});
for (;;) {try {await mkdir(lock);break;} catch (error) {if (error.code !== 'EEXIST') throw error;console.log('gpu.lock held, waiting');await sleep(15_000);}}
const isolate = (_, res, next) => {res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');next();};
let server, browser;
try {
  server = await createServer({configFile: false, logLevel: 'error', server: {host: '127.0.0.1', port, strictPort: true, fs: {strict: false}, hmr: false, watch: {ignored: ['**']}}, plugins: [{name: 'isolate', configureServer: s => {s.middlewares.use(isolate);}}]});
  await server.listen();
  browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true, args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-precise-memory-info']});
  const out = {label, date: new Date().toISOString(), host: {cpu: cpus()[0].model, cores: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), node: process.version, browser: browser.version()}, viewport: [1432, 768], runs: [], discarded: 0};
  const open = async () => {const page = await browser.newPage({viewport: {width: 1432, height: 768}, deviceScaleFactor: 1});page.setDefaultTimeout(600_000);const errors = [];page.on('pageerror', e => errors.push(e.message));page.on('console', m => {if (process.env.DEBUG) console.log('page:', m.text());if (m.type() === 'error') errors.push(m.text());});await page.goto(`http://127.0.0.1:${port}/examples/package-benchmarks/cad/culling.html`);await page.waitForFunction(() => window.ready);return {page, errors};};
  {const {page} = await open();out.adapter = await page.evaluate(async () => {const a = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});return {vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description, timestamp: a.features.has('timestamp-query')};});await page.close();}
  console.log('adapter', JSON.stringify(out.adapter));
  const measure = async (fn, config) => {
    for (;;) {
      await waitForAC();const {page, errors} = await open();const acPowerAtStart = acPower();
      const result = await page.evaluate(([f, c]) => window.culling[f](c), [fn, config]);const acPowerAtEnd = acPower();await page.close();
      if (acPowerAtStart === false || acPowerAtEnd === false) {out.discarded++;console.log('discarded (battery)');continue;}
      return {...result, acPowerAtStart, acPowerAtEnd, pageErrors: errors};
    }
  };
  if (flag('check')) {
    out.checks = [];
    for (const layout of ['sheet', 'stack']) for (const culling of ['occlusion', 'frustum']) {const r = await measure('check', {modules: +arg('check-modules', 1024), culling, layout});out.checks.push(r);console.log('check', layout, culling, JSON.stringify({differingPixels: r.differingPixels, drawn: [r.drawnPartsMin, r.drawnPartsMax], of: r.parts, twin: r.lastFrameTwinPixels, errors: [...r.errors, ...r.pageErrors]}));}
  }
  for (const layout of layouts) for (const size of sizes) for (const view of views) for (const mode of modes) {
    if (layout !== 'sheet' && mode === 'core') continue;
    const r = await measure('run', {modules: modulesFor(size), mode, view, layout, low: flag('low')});r.size = size;out.runs.push(r);
    console.log(layout, size, view, mode, JSON.stringify({parts: r.parts, drawn: r.drawnParts, cpu: r.frame.cpuMs.median, gpu: r.frame.gpuMs?.median, fps: r.frame.fps, serial: r.serial.frameMs.median, errors: [...r.errors, ...r.pageErrors]}));
  }
  await writeFile(new URL(`./results-${label}.json`, import.meta.url), JSON.stringify(out, null, 1));
  console.log('wrote', `examples/package-benchmarks/cad/results-${label}.json`);
} finally {await browser?.close();await server?.close();await rm(lock, {recursive: true, force: true});}
