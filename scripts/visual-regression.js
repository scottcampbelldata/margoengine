// Visual regression for the site demos (HANDOFF 1h.f). Needs a real GPU, so it is not part of `npm run verify`.
//   npm run visual:check  [-- --only=earth,dof-high] [--runs=N] [--no-build]   compare against tests/visual baselines
//   npm run visual:update [-- --only=...] [--runs=3] [--no-build]             re-capture baselines and noise tolerances
// Run `npm run build:packages` first; the script builds the site (scripts/build-site.js) and serves site/dist.
// Refuses on battery, takes test-results/gpu.lock in the main checkout (waits, polling every 60 s), and discards the
// run if AC power is lost. Report, actual and diff images: test-results/visual/index.html.
//
// Determinism: every capture runs in a fresh browser context with prefers-reduced-motion: reduce, which every demo
// honours as its pause (still frame at t = 0: delta 0 / animation paused / rotation paused), and a forced tier
// (`?quality=high|low`; phones are picked by user agent). The demo's own readiness signal (submitPrincipalScene /
// data-ready / full-detail upgrade) gates the screenshot. Dynamic text (FPS, telemetry) is masked.
// Comparison: images are box-downsampled (`factor`) to cut storage and pixel-level noise; per pixel d = max RGB
// difference (0-255). Gated: `changed` = share of pixels with d > 0 (catches small wide shifts such as a light colour;
// sparse particle noise barely moves it) and `hot` = share with d > HOT (local changes). `mean` and `max` are reported.
// `visual:update` captures each view
// `runs` times in separate browser launches and stores the worst pairwise run-to-run noise and the tolerance derived from it.
import {chromium} from '@playwright/test';
import {preview, createServer} from 'vite';
import {spawnSync, execFileSync} from 'node:child_process';
import {mkdir, rm, readFile, writeFile, copyFile} from 'node:fs/promises';
import {rmSync, readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {deflateSync, crc32} from 'node:zlib';
import {decodePNG} from '../tests/support/png.js';
import {acPower} from '../examples/package-benchmarks/cad/power.mjs';

const root = resolve(import.meta.dirname, '..'), baselines = resolve(root, 'tests/visual'), out = resolve(root, 'test-results/visual');
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const update = process.argv.includes('--update'), only = (arg('only') ?? '').split(',').filter(Boolean);
const runs = Number(arg('runs') ?? (update ? 4 : 1));
const HOT = 24; // a pixel off by more than ~10% in some channel
// Tolerance = noise floor x MARGIN + a floor-independent allowance (so a bit-exact demo still tolerates a stray pixel).
const MARGIN = 3, ALLOWANCE = {changed: 0.0005, hot: 0.0002}, GATED = Object.keys(ALLOWANCE);

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const desktop = {viewport: {width: 1280, height: 720}, deviceScaleFactor: 1, factor: 2};
const views = {
  high: {...desktop, query: '?quality=high'},
  light: {...desktop, query: '?quality=low'},
  phone: {viewport: {width: 390, height: 844}, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: iphone, factor: 6, query: ''},
  model: {viewport: {width: 640, height: 480}, deviceScaleFactor: 1, factor: 2, query: ''},
};
// path: URL path under the site root; ready: page expression true once the principal scene (and any full-detail
// upgrade) is on screen; mask: dynamic elements painted over. tonemap reads no tier, so its light view is skipped.
const demos = [
  {id: 'night-citadel', path: 'night-citadel/', ready: '!!window.nightCitadel?.readiness', mask: ['#fps', '#delta', '#refresh-note']},
  {id: 'gameplay-sandbox', path: 'gameplay-sandbox/', ready: '!!window.sandbox', mask: ['#telemetry *']},
  {id: 'character-animation', path: 'demos/character-animation.html', ready: "document.querySelector('#viewport')?.dataset.ready==='true'"},
  {id: 'flight-helmet', path: 'demos/flight-helmet.html', ready: "document.querySelector('#viewport')?.dataset.ready==='true'&&window.extensionDemo.quality!=='preview'"},
  {id: 'windy-meadow', path: 'demos/windy-meadow.html', ready: "document.querySelector('#viewport')?.dataset.ready==='true'"},
  {id: 'earth', path: 'demos/earth/', ready: "!!window.earthDemo&&window.earthDemo.quality!=='preview'"},
  {id: 'dof', path: 'demos/dof/', ready: '!!window.dofDemo', views: ['high', 'light', 'phone']},
  {id: 'tonemap', path: 'demos/tonemap/', ready: '!!window.tonemapDemo', views: ['high', 'phone']},
  // Khronos sample assets (HANDOFF 5w): one small view per model, served by a Vite dev server from the repo root
  // (`dev`) because the site build must not ship 250 MB of models. Models that fail to load are left out.
  ...JSON.parse(readFileSync(resolve(import.meta.dirname, '../examples/assets/khronos/manifest.json'), 'utf8')).models.filter(m => m.render?.verdict !== 'fails').map(m => ({
    id: `khronos-${m.name}`, path: `examples/khronos-gallery.html?model=${m.name}`, dev: true, ready: "document.body.dataset.ready==='true'", views: ['model']})),
];
const cases = demos.flatMap(demo => (demo.views ?? Object.keys(views)).map(view => ({id: `${demo.id}-${view}`, demo, view: views[view]})))
  .filter(c => !only.length || only.some(o => c.id.includes(o)));

// PNG: 8-bit RGB, per-row filter chosen by the minimum-sum heuristic.
function encodePNG({width, height, data}) {
  const stride = width * 3, raw = Buffer.alloc((stride + 1) * height), row = new Uint8Array(stride), prev = new Uint8Array(stride), cand = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) row[x * 3 + c] = data[(y * width + x) * 4 + c];
    let best = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? row[i - 3] : 0, b = prev[i], c = i >= 3 ? prev[i - 3] : 0, p = a + b - c;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
        cand[i] = row[i] - pred; sum += cand[i] < 128 ? cand[i] : 256 - cand[i];
      }
      if (sum < best) {best = sum; raw[y * (stride + 1)] = f; raw.set(cand, y * (stride + 1) + 1);}
    }
    prev.set(row);
  }
  const chunk = (type, body) => {const b = Buffer.alloc(body.length + 12); b.writeUInt32BE(body.length); b.write(type, 4, 'latin1'); body.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + body.length)), 8 + body.length); return b;};
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, {level: 9})), chunk('IEND', Buffer.alloc(0))]);
}
function downsample({width, height, data}, f) {
  const w = Math.floor(width / f), h = Math.floor(height / f), o = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    let sum = 0; for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) sum += data[((y * f + j) * width + x * f + i) * 4 + c];
    o[(y * w + x) * 4 + c] = Math.round(sum / (f * f));
  }
  return {width: w, height: h, data: o};
}
function compare(a, b) {
  if (a.width !== b.width || a.height !== b.height) return {changed: 1, hot: 1, mean: 255, max: 255, size: `${b.width}x${b.height} vs ${a.width}x${a.height}`};
  const n = a.width * a.height, diff = new Uint8Array(n * 4); let sum = 0, changed = 0, hot = 0, max = 0;
  for (let p = 0; p < n; p++) {
    const k = p * 4, d = Math.max(Math.abs(a.data[k] - b.data[k]), Math.abs(a.data[k + 1] - b.data[k + 1]), Math.abs(a.data[k + 2] - b.data[k + 2]));
    sum += d; if (d) changed++; if (d > HOT) hot++; if (d > max) max = d;
    const gray = (a.data[k] + a.data[k + 1] + a.data[k + 2]) / 10; // dimmed baseline; any changed pixel shows red
    diff[k] = d ? Math.min(255, gray + 48 + d * 8) : gray; diff[k + 1] = diff[k + 2] = gray; diff[k + 3] = 255;
  }
  return {changed: changed / n, hot: hot / n, mean: sum / n, max, image: {width: a.width, height: a.height, data: diff}};
}
const round = v => Number(v.toPrecision(3));

// Power and the GPU lock (shared with the other GPU scripts in the main checkout).
if (acPower() === false) {console.error('On battery: refusing to run (GPU and CPU are throttled). Plug in and retry.'); process.exit(1);}
const lock = process.env.MARGO_GPU_LOCK_NESTED ?? resolve(dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {cwd: root, encoding: 'utf8'}).trim()), 'test-results/gpu.lock');
if (!process.argv.includes('--no-build') && cases.some(c => !c.demo.dev)) {
  const built = spawnSync(process.execPath, ['scripts/build-site.js'], {cwd: root, stdio: 'inherit'});
  if (built.status !== 0) process.exit(built.status ?? 1);
}
await mkdir(dirname(lock), {recursive: true});
for (;;) {try {await mkdir(lock); break;} catch (e) {if (e.code !== 'EEXIST') throw e; console.log('gpu.lock held, waiting 60 s'); await new Promise(r => setTimeout(r, 60_000));}}
const unlock = () => rmSync(lock, {recursive: true, force: true});
process.on('SIGINT', () => {unlock(); process.exit(130);});

const started = Date.now(), results = new Map(cases.map(c => [c.id, {id: c.id, url: c.demo.path + c.view.query, captures: [], errors: []}]));
let server, devServer, environment = {}, exitCode = 0;
try {
  await rm(out, {recursive: true, force: true}); await mkdir(out, {recursive: true});
  const powerBefore = acPower();
  if (cases.some(c => !c.demo.dev)) server = await preview({configFile: false, root, build: {outDir: 'site/dist'}, preview: {port: 0, strictPort: true}, logLevel: 'error'});
  const origin = server && new URL(server.resolvedUrls.local[0]).origin;
  if (cases.some(c => c.demo.dev)) devServer = await (await createServer({configFile: false, root, logLevel: 'error', optimizeDeps: {noDiscovery: true, include: []}, server: {port: 0, hmr: false}})).listen();
  const devOrigin = devServer && new URL(devServer.resolvedUrls.local[0]).origin;
  for (let run = 0; run < runs; run++) {
    const browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true, args: ['--enable-unsafe-webgpu']});
    try {
      environment.browser = `${process.env.BROWSER_CHANNEL ?? 'msedge'} ${browser.version()}`;
      for (const {id, demo, view} of cases) {
        const {factor, query, ...options} = view, result = results.get(id), t = Date.now();
        const context = await browser.newContext({...options, reducedMotion: 'reduce'}), page = await context.newPage();
        page.on('pageerror', e => result.errors.push(`pageerror: ${e.message}`));
        page.on('console', m => {if (m.type() === 'error') result.errors.push(`console: ${m.text()}`);});
        try {
          await page.goto((demo.dev ? devOrigin : origin) + '/' + demo.path + query);
          await page.waitForFunction(demo.ready, null, {timeout: 120_000});
          environment.gpu ??= await page.evaluate(async () => {const i = (await navigator.gpu.requestAdapter()).info; return [i.vendor, i.architecture, i.description].filter(Boolean).join(' ');});
          // Let late UI text settle (sandbox clock label ticks every 500 ms) and a few frames present.
          await page.waitForTimeout(1000);
          await page.evaluate(() => document.fonts.ready.then(() => new Promise(r => {let n = 4; const f = () => --n ? requestAnimationFrame(f) : r(); requestAnimationFrame(f);})));
          const png = await page.screenshot({animations: 'disabled', mask: (demo.mask ?? []).map(s => page.locator(s))});
          result.captures.push(downsample(await decodePNG(png), factor));
        } catch (error) {
          result.errors.push(`capture: ${String(error.message ?? error).split('\n')[0]}`);
          await page.screenshot({path: resolve(out, `${id}.failed.png`)}).catch(() => {});
        } finally {await context.close();}
        console.log(`run ${run + 1}/${runs} ${id} ${((Date.now() - t) / 1000).toFixed(1)} s${result.captures.length > run ? '' : ' FAILED'}`);
      }
    // Edge's shutdown can hang after a power change (seen 2026-10-14); do not let it block the remaining runs.
    } finally {await Promise.race([browser.close(), new Promise(r => setTimeout(r, 15_000))]);}
  }
  const powerAfter = acPower();
  environment = {...environment, acPowerBefore: powerBefore, acPowerAfter: powerAfter, date: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim()};
  if (powerAfter === false) throw new Error('AC power was lost during the run: results discarded. Plug in and retry.');

  const manifestPath = resolve(baselines, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '{"views":{}}'));
  const rows = [];
  for (const r of results.values()) {
    const failed = r.captures.length < runs || r.errors.some(e => e.startsWith('pageerror') || e.startsWith('capture'));
    if (update) {
      if (failed) {exitCode = 1; console.log(`FAIL ${r.id}: not updated (${r.errors[0] ?? 'missing capture'})`); rows.push({...r, status: 'not updated'}); continue;}
      const noise = r.captures.flatMap((a, i) => r.captures.slice(i + 1).map(b => compare(a, b))), floor = Object.fromEntries(['changed', 'hot', 'mean', 'max'].map(k => [k, round(Math.max(0, ...noise.map(n => n[k])))]));
      const tolerance = Object.fromEntries(GATED.map(k => [k, round(floor[k] * MARGIN + ALLOWANCE[k])]));
      await mkdir(baselines, {recursive: true});
      await writeFile(resolve(baselines, `${r.id}.png`), encodePNG(r.captures[0]));
      manifest.views[r.id] = {url: r.url, size: `${r.captures[0].width}x${r.captures[0].height}`, runs, noise: floor, tolerance};
      console.log(`updated ${r.id}: noise ${JSON.stringify(floor)} -> tolerance ${JSON.stringify(tolerance)}`);
      rows.push({...r, status: 'updated', noise: manifest.views[r.id].noise, tolerance});
      continue;
    }
    const entry = manifest.views[r.id], baseline = entry && await readFile(resolve(baselines, `${r.id}.png`)).then(b => decodePNG(new Uint8Array(b))).catch(() => undefined);
    if (!baseline || failed) {exitCode = 1; const why = !baseline ? 'no baseline (run visual:update)' : r.errors[0]; console.log(`FAIL ${r.id}: ${why}`); rows.push({...r, status: 'FAIL', why}); continue;}
    // Worst of the runs against the baseline.
    const score = m => Math.max(...GATED.map(k => m[k] / entry.tolerance[k]));
    const worst = r.captures.map(c => ({...compare(baseline, c), capture: c})).reduce((a, b) => score(b) > score(a) ? b : a), pass = score(worst) <= 1;
    if (!pass) exitCode = 1;
    await copyFile(resolve(baselines, `${r.id}.png`), resolve(out, `${r.id}.baseline.png`));
    await writeFile(resolve(out, `${r.id}.actual.png`), encodePNG(worst.capture));
    if (worst.image) await writeFile(resolve(out, `${r.id}.diff.png`), encodePNG(worst.image));
    const metrics = {changed: round(worst.changed), hot: round(worst.hot), mean: round(worst.mean), max: worst.max};
    console.log(`${pass ? 'pass' : 'FAIL'} ${r.id}: changed ${metrics.changed} (limit ${entry.tolerance.changed}), hot ${metrics.hot} (limit ${entry.tolerance.hot}), mean ${metrics.mean}, max ${metrics.max}`);
    rows.push({...r, status: pass ? 'pass' : 'FAIL', metrics, noise: entry.noise, tolerance: entry.tolerance, images: true});
  }
  if (update) {manifest.environment = environment; manifest.method = {hot: HOT, margin: MARGIN, allowance: ALLOWANCE}; await writeFile(manifestPath, JSON.stringify(manifest, null, 1) + '\n');}
  else if (manifest.environment && (manifest.environment.gpu !== environment.gpu || manifest.environment.browser !== environment.browser))
    console.log(`warning: baselines are from ${manifest.environment.gpu} / ${manifest.environment.browser}; this run is ${environment.gpu} / ${environment.browser}`);
  const seconds = ((Date.now() - started) / 1000).toFixed(0), esc = s => String(s).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
  await writeFile(resolve(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Visual ${update ? 'update' : 'check'}</title>
<style>body{font:14px system-ui;margin:16px;background:#111;color:#ddd}td{vertical-align:top;padding:6px;border-top:1px solid #333}img{max-width:420px;display:block}.FAIL{color:#f66}.pass{color:#6c6}pre{white-space:pre-wrap;max-width:420px;font-size:12px}</style>
<h1>Visual ${update ? 'update' : 'check'}: ${rows.filter(r => r.status === 'pass' || r.status === 'updated').length}/${rows.length} ok</h1>
<p>${esc(JSON.stringify(environment))}<br>baselines: ${esc(JSON.stringify(manifest.environment ?? {}))}<br>${runs} run(s), ${seconds} s. d = max RGB difference per pixel; hot = share of pixels with d &gt; ${HOT}.</p>
<table>${rows.map(r => `<tr><td><b class="${r.status.split(' ')[0]}">${r.status}</b> ${esc(r.id)}<br><code>/${esc(r.url)}</code><pre>${esc(JSON.stringify({metrics: r.metrics, noise: r.noise, tolerance: r.tolerance, why: r.why}, null, 1))}\n${esc(r.errors.slice(0, 8).join('\n'))}</pre></td>${r.images ? ['baseline', 'actual', 'diff'].map(k => `<td>${k}<img src="${r.id}.${k}.png"></td>`).join('') : ''}</tr>`).join('\n')}</table>`);
  console.log(`${update ? 'updated' : 'checked'} ${rows.length} views in ${seconds} s; report test-results/visual/index.html`);
} catch (error) {console.error(error); exitCode = 1;}
finally {await server?.close(); await devServer?.close(); unlock();}
process.exit(exitCode);
