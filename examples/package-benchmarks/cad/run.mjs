// Real-GPU CAD benchmark. From the repository root, after `npm run build:packages`:
//   node examples/package-benchmarks/cad/run.mjs [--sizes=10000,50000,max] [--edges] [--low] [--step] [--culled[=px]] [--label=name]
//   --culled[=px]: GPU culling of the core meshes with @margoengine/culling CulledMeshes (minRadius px, default 0), CPU culling off
//   --imposters=px: each 27-part module shows as one @margoengine/lod imposter while its bounding sphere is under px pixels
//   --machinery=, --culling=, --lod=: URL of another build's dist folder (before/after; Git Bash: MSYS_NO_PATHCONV=1)
// BENCH_CONDITIONS (free text, e.g. machine state) and BENCH_CORE (core commit) are recorded in the JSON when set.
// Writes examples/package-benchmarks/cad/results-<label>.json. Headless Edge (BROWSER_CHANNEL to override), vsync and the
// frame-rate limit off so FPS is throughput, cross-origin isolated so performance.now() has 5 µs resolution.
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {writeFile, stat} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {cpus, totalmem} from 'node:os';
import {requireAC} from './power.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const flag = name => process.argv.includes(`--${name}`);
const sizes = arg('sizes', '10000,50000,max').split(',').filter(Boolean), label = arg('label', 'baseline'), port = +arg('port', 5231);
const modulesFor = size => size === 'max' ? Math.floor((100_000 - 1 - 105) / 30) : Math.ceil(+size / 27);
const isolate = (_, res, next) => {res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');next();};
const server = await createServer({configFile: false, logLevel: 'error', server: {host: '127.0.0.1', port, strictPort: true, fs: {strict: false}, hmr: false, watch: {ignored: ['**']}}, plugins: [{name: 'isolate', configureServer: s => {s.middlewares.use(isolate);}}]});
await server.listen();
const browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true, args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-precise-memory-info']});
const acPowerAtStart = requireAC();
const out = {label, date: new Date().toISOString(), acPowerAtStart, host: {cpu: cpus()[0].model, cores: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), node: process.version, browser: browser.version()}, viewport: [1432, 768], ...(process.env.BENCH_CONDITIONS ? {conditions: process.env.BENCH_CONDITIONS} : {}), ...(process.env.BENCH_CORE ? {core: process.env.BENCH_CORE} : {}), runs: []};
const open = async () => {const page = await browser.newPage({viewport: {width: 1432, height: 768}, deviceScaleFactor: 1});page.setDefaultTimeout(+(process.env.PAGE_TIMEOUT ?? 600_000));const errors = [];page.on('pageerror', e => errors.push(e.message));page.on('console', m => {if (process.env.DEBUG) console.log('page:', m.text());if (m.type() === 'error') errors.push(m.text());});await page.goto(`http://127.0.0.1:${port}/examples/package-benchmarks/cad/index.html`);await page.waitForFunction(() => window.ready);return {page, errors};};
try {
  {const {page} = await open();out.adapter = await page.evaluate(async () => {const a = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});return {...a.info.toJSON?.() ?? {vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description}, timestamp: a.features.has('timestamp-query')};});await page.close();}
  console.log('adapter', JSON.stringify(out.adapter));
  for (const size of sizes) {
    const {page, errors} = await open(), config = {modules: modulesFor(size), edges: flag('edges'), low: flag('low'), view: arg('view', 'overview'), bvh: !flag('no-bvh'), explode: !flag('no-explode'), still: flag('still'), pick: !flag('no-pick'), move: +arg('move', 0),...(flag('culled') || arg('culled') ? {culled: +(arg('culled') ?? 0)} : {}),...(arg('culling') ? {cullingBase: arg('culling')} : {}),...(arg('imposters') ? {imposters: +arg('imposters')} : {}),...(arg('lod') ? {lodBase: arg('lod')} : {}),...(arg('machinery') ? {machineryBase: arg('machinery')} : {})};
    const result = await page.evaluate(c => window.cad.run(c), config);result.size = size;result.pageErrors = errors;out.runs.push(result);
    console.log(size, JSON.stringify({parts: result.parts, kernel: result.kernel.tickCullMs.median, frameKernel: result.frame.kernelMs.median, collect: result.frame.collectMs.median, submit: result.frame.submitMs.median, cpu: result.frame.cpuMs.median, gpu: result.frame.gpuMs?.median, gpuDrawn: result.gpuDrawn, fps: result.frame.fps, pick: result.enginePick?.ms?.median, bvh: result.assemblyBVH, explode: result.explodedView?.animatingMs?.median, errors: [...errors, ...result.errors]}));
    await page.close();
  }
  if (flag('shot')) for (const ortho of [false, true]) {const {page} = await open();await page.evaluate(o => window.cad.view({ortho: o}), ortho);await page.locator('canvas').screenshot({path: `test-results/cad-edges-${ortho ? 'ortho' : 'perspective'}.png`});await page.close();}
  if (flag('step')) {
    const wasm = 'packages/machinery/dist/workers/occt-import-js.wasm', glue = 'packages/machinery/dist/workers/occt-import-js.js', worker = 'packages/machinery/dist/workers/cad-runtime.js';
    out.occt = {wasmBytes: (await stat(wasm)).size, wasmGzip: gzipSync(readFileSync(wasm), {level: 9}).length, glueBytes: (await stat(glue)).size, glueGzip: gzipSync(readFileSync(glue), {level: 9}).length, workerBytes: (await stat(worker)).size, workerGzip: gzipSync(readFileSync(worker), {level: 9}).length};
    out.step = [];
    for (const [file, format] of [['node_modules/occt-import-js/test/testfiles/cax-if/as1-oc-214.stp', 'step'], ['node_modules/occt-import-js/test/testfiles/cube-10x10mm/Cube 10x10.igs', 'iges']]) for (let i = 0; i < 3; i++) {
      const {page, errors} = await open();const r = await page.evaluate(c => window.cad.step(c), {url: '/' + file.split('/').map(encodeURIComponent).join('/'), format});r.fileBytes = (await stat(file)).size;r.run = i + 1;r.pageErrors = errors;out.step.push(r);console.log('step', JSON.stringify(r));await page.close();
    }
  }
} finally {await browser.close();await server.close();}
out.acPowerAtEnd = requireAC();
await writeFile(new URL(`./results-${label}.json`, import.meta.url), JSON.stringify(out, null, 1));
console.log('wrote', `examples/package-benchmarks/cad/results-${label}.json`);
