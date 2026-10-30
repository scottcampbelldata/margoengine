// The visual check's WebGL2 compatibility run (docs/webgl2-compat-demos.md, roadmap milestone M8): every site demo and
// every Khronos gallery model, once on native WebGPU and once on the WebGL2 compatibility layer, in the same browser on
// the same GPU, compared pixel by pixel.
//   npm run visual:compat [-- --only=dof,earth] [--no-build] [--write] [--budget=50] [--max-minutes=90]
// Site demos run the layer the way a visitor without WebGPU gets it: `navigator.gpu` is removed before the page loads,
// so the page's own gate (examples/needs-webgpu.js) downloads @margoengine/webgl2-compat from the site build and
// installs it. Khronos models (a dev-server page without the gate) get the layer from scripts/support/compat-shim.js.
// Per demo: native twice (its run-to-run noise) and the layer once, in exact-pixel captures of the demo's still frame
// (prefers-reduced-motion, as the visual check). d = max RGB difference per pixel (0 to 255). "same" is the roadmap's
// parity rule (decision 4): at most 0.1% of pixels with d > 2 and a mean d of at most 0.25; "differs" states the
// numbers; "refused" means the demo showed the layer's refusal (MargoError code `unsupported`) and names it.
// Frame cost: the main-thread time of each animation frame's callbacks and the interval between frames, median of 60
// frames after the capture, both paths. `--budget=<ms>` fails a demo whose median frame on the layer costs more and
// at least twice its native frame (the per-frame budget check for integrated GPUs; default 50 ms).
// Gate: each demo's status must match scripts/support/visual-compat-expected.json, and a "differs" demo may not get
// worse than its recorded share and mean (x1.5 plus 0.001 / 0.25), and a demo recorded with an exact still frame (its two
// native captures equal pixel for pixel) must keep it, so native noise can never flip its status. `--write` records this run there and rewrites the
// table in docs/webgl2-compat-demos.md. Takes a shared slot of the GPU lock, like the visual check.
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { preview, createServer } from 'vite';
import { decodePNG } from '../tests/support/png.js';
import { acquire } from './gpu-lock.mjs';
import { demos } from './support/visual-demos.js';
import { compatShim } from './support/compat-shim.js';
import { compare, downsample, encodePNG } from './support/visual-image.js';
import { launchBrowser, browserLabel } from './lib/browser.mjs';
import { closeAll } from './support/shutdown.mjs';
import { SAME, gateProblems, record, verdict } from './support/visual-compat-status.js';

const root = resolve(import.meta.dirname, '..'),
  out = resolve(root, 'test-results/visual-compat'),
  expectedPath = resolve(root, 'scripts/support/visual-compat-expected.json'),
  docPath = resolve(root, 'docs/webgl2-compat-demos.md');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = (arg('only') ?? '').split(',').filter(Boolean),
  write = process.argv.includes('--write'),
  budget = Number(arg('budget') ?? 50),
  maxMinutes = Number(arg('max-minutes') ?? 90);
export { SAME };

const iphone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const views = {
  high: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, query: '?quality=high' },
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: iphone,
    query: '',
  },
  model: { viewport: { width: 640, height: 480 }, deviceScaleFactor: 1, query: '' },
};
const withQuery = (path, query) => (query && path.includes('?') ? `${path}&${query.slice(1)}` : path + query);
// Site demos the visual check leaves out (no baselines: their native picture is not pinned), compared here all the
// same, so every demo on the site runs on the layer. The dual viewport page runs both paths itself.
const viewportReady = "document.querySelector('#viewport')?.dataset.ready==='true'";
export const extraDemos = [
  ...['compute-lab', 'sciviz-volume', 'sciviz-points', 'sciviz-surface', 'ui-game'].map((id) => ({
    id,
    path: `demos/${id}.html`,
    ready: "document.querySelector('canvas')?.dataset.ready==='true'",
  })),
  { id: 'animator', path: 'demos/animator/', ready: '!!window.animatorDemo' },
  { id: 'light-keeper', path: 'demos/light-keeper/', ready: viewportReady },
];
// One view per demo: the desktop one (the gallery's model view). The robot page is character-animation's old URL.
const allCases = [...demos, ...extraDemos]
  .filter((demo) => demo.id !== 'robot-expressive')
  .map((demo) => {
    const view = demo.dev ? 'model' : (demo.views ?? ['high']).includes('high') ? 'high' : demo.views[0];
    return { id: demo.id, demo, view: views[view], viewName: view };
  });
const cases = allCases.filter((c) => !only.length || only.some((o) => c.id.includes(o)));

/** Page init script: the page has no WebGPU, so its gate loads the layer (a visitor without WebGPU). */
function noWebGPU() {
  delete Navigator.prototype.gpu;
  if (globalThis.WorkerNavigator) delete WorkerNavigator.prototype.gpu;
}
/** Page init script: times each animation frame's callbacks (main-thread work) and the frames' timestamps. */
function frameTimer() {
  const frames = (globalThis.__margoFrames = []),
    raf = requestAnimationFrame.bind(globalThis);
  let current;
  globalThis.requestAnimationFrame = (callback) =>
    raf((time) => {
      if (current?.time !== time) frames.push((current = { time, work: 0 }));
      const start = performance.now();
      try {
        callback(time);
      } finally {
        current.work += performance.now() - start;
      }
    });
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : NaN;
};
/** Median main-thread work and interval over the next 60 frames, in ms. */
async function frameCost(page) {
  return page.evaluate(
    () =>
      new Promise((done) => {
        const frames = globalThis.__margoFrames,
          from = frames.length;
        const started = performance.now();
        const wait = () => {
          // A paused demo (the gameplay sandbox under reduced motion) draws no frame: give up after 3 s without one.
          const waited = performance.now() - started;
          if (frames.length - from >= 61 || waited > 20_000 || (waited > 3000 && frames.length === from)) {
            const list = frames.slice(from, from + 61),
              work = list.slice(0, -1).map((f) => f.work),
              interval = list.slice(1).map((f, i) => f.time - list[i].time);
            done({ frames: work.length, work, interval });
          } else setTimeout(wait, 100); // fixed-wait: polls the frame list, which only grows when the page draws
        };
        wait();
      }),
  );
}

/** d > 2 share, mean and max over full-resolution captures, plus the visual check's changed and hot shares. */
function metrics(a, b) {
  const m = compare(a, b);
  if (m.size) return { over2: 1, mean: 255, max: 255, size: m.size, image: undefined };
  let over2 = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    const k = p * 4,
      d = Math.max(
        Math.abs(a.data[k] - b.data[k]),
        Math.abs(a.data[k + 1] - b.data[k + 1]),
        Math.abs(a.data[k + 2] - b.data[k + 2]),
      );
    if (d > 2) over2++;
  }
  const r = (v) => Number(v.toPrecision(3));
  return { over2: r(over2 / (a.width * a.height)), mean: r(m.mean), max: m.max, hot: r(m.hot), image: m.image };
}

if (!process.argv.includes('--no-build') && cases.some((c) => !c.demo.dev)) {
  const built = spawnSync(process.execPath, ['scripts/build-site.js'], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
// Hard limit for the whole run: on timeout everything is closed and the lock released by the exit handler.
const deadline = setTimeout(() => {
  console.error(`visual:compat: over ${maxMinutes} min, stopped`);
  process.exit(1);
}, maxMinutes * 60_000);
deadline.unref();
const releaseGpu = await acquire({ owner: 'visual-compat', mode: 'shared' });
process.on('exit', () => releaseGpu());
let server, devServer, browser;
let exitCode = 0;
try {
  await mkdir(out, { recursive: true });
  if (cases.some((c) => !c.demo.dev))
    server = await preview({
      configFile: false,
      root,
      build: { outDir: 'site/dist' },
      preview: { port: 0, strictPort: true },
      logLevel: 'error',
    });
  if (cases.some((c) => c.demo.dev))
    devServer = await (
      await createServer({
        configFile: false,
        root,
        logLevel: 'error',
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { port: 0, hmr: false, watch: null },
      })
    ).listen();
  const origin = server && new URL(server.resolvedUrls.local[0]).origin,
    devOrigin = devServer && new URL(devServer.resolvedUrls.local[0]).origin;
  browser = await launchBrowser({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const environment = { browser: `${browserLabel()} ${browser.version()}` };
  const expected = JSON.parse(await readFile(expectedPath, 'utf8').catch(() => '{"demos":{}}'));
  const rows = [];
  for (const { id, demo, view, viewName } of cases) {
    const { query, ...options } = view,
      url = (demo.dev ? devOrigin : origin) + '/' + withQuery(demo.path, query),
      row = { id, view: viewName, url: withQuery(demo.path, query), errors: [] };
    // `timed`: also measure the frame cost (the noise run skips it).
    const run = async (compat, timed = true) => {
      const context = await browser.newContext({ ...options, reducedMotion: 'reduce' }),
        page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console: ${m.text()}`);
      });
      await page.addInitScript(frameTimer);
      if (compat) await page.addInitScript(demo.dev ? compatShim : noWebGPU);
      const t = Date.now();
      try {
        await page.goto(url, { timeout: 90_000 });
        // On the layer, a refusal box is an answer too, and so is the needs-WebGPU message of a page kept off the layer.
        const ready = compat
          ? `(${demo.ready})||!!document.querySelector('[data-webgpu-refused],[data-no-webgpu]')`
          : demo.ready;
        await page.waitForFunction(ready, null, { timeout: compat ? 240_000 : 120_000 });
        const refusedText = await page
          .locator('[data-webgpu-refused]')
          .innerText({ timeout: 1 })
          .catch(() => null);
        if (refusedText) return { refused: refusedText.replace(/\s+/g, ' ').trim(), errors, ms: Date.now() - t };
        if (compat && (await page.locator('[data-no-webgpu]').count()))
          return { off: true, errors, ms: Date.now() - t };
        if (compat && !demo.dev) {
          const marked = await page.evaluate(() => 'webgpuCompat' in document.documentElement.dataset);
          if (!marked) throw new Error('the page did not install the WebGL2 compatibility layer');
        }
        // The page's own 'WebGL2 compatibility mode' note is not part of the scene.
        await page.addStyleTag({ content: '[data-webgpu-compat-note]{display:none!important}' });
        // fixed-wait: late UI text settles (the sandbox clock label ticks every 500 ms), as in visual-regression.js
        await page.waitForTimeout(1000);
        const cost = timed ? await frameCost(page) : undefined;
        const shot = () =>
          page.screenshot({ animations: 'disabled', mask: (demo.mask ?? []).map((s) => page.locator(s)) });
        let last = Buffer.alloc(0),
          next = await shot();
        for (let i = 0; i < 6 && !next.equals(last); i++) {
          await page.waitForTimeout(500); // fixed-wait: retakes the shot until two in a row match (a stable frame)
          [last, next] = [next, await shot()];
        }
        const gpu = await page.evaluate(async () => {
          const i = (await navigator.gpu.requestAdapter())?.info ?? {};
          return [i.vendor, i.architecture, i.description].filter(Boolean).join(' ');
        });
        return { image: await decodePNG(next), cost, gpu, errors, ms: Date.now() - t };
      } catch (error) {
        errors.push(`capture: ${String(error.message ?? error).split('\n')[0]}`);
        await page
          .screenshot({ path: resolve(out, `${id}.${compat ? 'compat' : 'native'}.failed.png`) })
          .catch(() => {});
        return { errors, ms: Date.now() - t };
      } finally {
        await context.close();
      }
    };
    const a = await run(false),
      b = await run(false, false),
      c = await run(true);
    environment.gpu ??= a.gpu;
    row.errors.push(...a.errors.map((e) => `native: ${e}`), ...c.errors.map((e) => `layer: ${e}`));
    if (!a.image || !b.image) row.status = 'native failed';
    else if (c.refused) row.status = 'refused';
    // Kept off the layer by its page (`needsWebGPU(area, { layer: false })`) while a known bug stands.
    else if (c.off) row.status = 'webgpu only';
    else if (!c.image) row.status = 'failed';
    else {
      row.noise = metrics(a.image, b.image);
      row.diff = metrics(a.image, c.image);
      row.status = verdict(row.diff);
      await writeFile(resolve(out, `${id}.native.png`), encodePNG(downsample(a.image, 2)));
      await writeFile(resolve(out, `${id}.compat.png`), encodePNG(downsample(c.image, 2)));
      if (row.diff.image) await writeFile(resolve(out, `${id}.diff.png`), encodePNG(downsample(row.diff.image, 2)));
      delete row.noise.image;
      delete row.diff.image;
      row.frame = {
        native: { work: median(a.cost.work), interval: median(a.cost.interval) },
        compat: { work: median(c.cost.work), interval: median(c.cost.interval) },
      };
    }
    row.refused = c.refused;
    row.seconds = { native: a.ms / 1000, compat: c.ms / 1000 };
    // The gate (scripts/support/visual-compat-status.js): the recorded status, no worse differences, an exact still
    // frame stays exact, the frame budget.
    const problems =
      row.status === 'native failed' || row.status === 'failed'
        ? [row.errors[0] ?? row.status]
        : gateProblems(row, expected.demos[id], { write, budget });
    if (problems.length) exitCode = 1;
    row.problems = problems;
    rows.push(row);
    const f = row.frame,
      d = row.diff;
    console.log(
      `${problems.length ? 'FAIL' : 'ok  '} ${id}: ${row.status}${d ? ` (d>2 ${(d.over2 * 100).toFixed(2)}%, mean ${d.mean}, max ${d.max}; native noise d>2 ${(row.noise.over2 * 100).toFixed(2)}%, mean ${row.noise.mean})` : ''}${row.refused ? ` "${row.refused}"` : ''}${f ? `; frame work ${f.native.work.toFixed(2)} / ${f.compat.work.toFixed(2)} ms, interval ${f.native.interval.toFixed(1)} / ${f.compat.interval.toFixed(1)} ms` : ''}${problems.length ? `: ${problems.join('; ')}` : ''}`,
    );
  }
  environment.date = new Date().toISOString();
  environment.commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ environment, rows }, null, 1) + '\n');
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  await writeFile(
    resolve(out, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Visual compat</title><style>body{font:14px system-ui;margin:16px;background:#111;color:#ddd}td{vertical-align:top;padding:6px;border-top:1px solid #333}img{max-width:360px;display:block}pre{white-space:pre-wrap;max-width:360px;font-size:12px}</style>
<h1>WebGL2 layer against native WebGPU</h1><p>${esc(JSON.stringify(environment))}</p><table>${rows
      .map(
        (r) =>
          `<tr><td><b>${esc(r.status)}</b> ${esc(r.id)}<pre>${esc(JSON.stringify({ diff: r.diff, noise: r.noise, frame: r.frame, refused: r.refused, problems: r.problems }, null, 1))}\n${esc(r.errors.slice(0, 6).join('\n'))}</pre></td>${r.diff ? ['native', 'compat', 'diff'].map((k) => `<td>${k}<img src="${r.id}.${k}.png"></td>`).join('') : ''}</tr>`,
      )
      .join('\n')}</table>`,
  );
  if (write) {
    for (const r of rows) if (r.status !== 'failed' && r.status !== 'native failed') expected.demos[r.id] = record(r);
    expected.demos = Object.fromEntries(Object.entries(expected.demos).sort(([x], [y]) => x.localeCompare(y)));
    await writeFile(expectedPath, JSON.stringify(expected, null, 1) + '\n');
    await writeDoc(rows, environment);
  }
  console.log(
    `visual:compat: ${rows.length} demos, ${rows.filter((r) => r.problems.length).length} failing; report test-results/visual-compat/index.html`,
  );
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await closeAll({ browser, servers: [server, devServer] }).catch((error) => console.warn(error.message));
  releaseGpu();
}
process.exit(exitCode);

/** Rewrites the generated table in docs/webgl2-compat-demos.md (between its two markers), keeping rows not rerun. */
async function writeDoc(rows, environment) {
  const doc = await readFile(docPath, 'utf8'),
    start = '<!-- visual-compat table: generated by npm run visual:compat -- --write -->',
    end = '<!-- end of the visual-compat table -->';
  const [before, rest] = doc.split(start),
    after = rest.split(end)[1];
  const old = new Map([...rest.split(end)[0].matchAll(/^\| `([^`]+)` .*$/gm)].map((m) => [m[1], m[0]]));
  const pct = (v) => `${(v * 100).toFixed(2)}%`,
    ms = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} ms` : '-');
  for (const r of rows) {
    const result =
      r.status === 'refused'
        ? `refused: ${r.refused.replace(/\|/g, '/')}`
        : r.status === 'same'
          ? 'runs, same pixels'
          : r.status === 'differs'
            ? `runs with differences: d > 2 on ${pct(r.diff.over2)} of pixels, mean d ${r.diff.mean}, max d ${r.diff.max}`
            : r.status === 'webgpu only'
              ? 'kept on WebGPU only (shows the needs-WebGPU message) until its bug on the layer is fixed, see known-bugs.md'
              : r.status;
    const noise = r.noise
      ? r.noise.max === 0
        ? 'exact'
        : `${pct(r.noise.over2)}, mean ${r.noise.mean}, max d ${r.noise.max}`
      : '-';
    const frame = r.frame
      ? `${ms(r.frame.native.work)} / ${ms(r.frame.compat.work)}; ${ms(r.frame.native.interval)} / ${ms(r.frame.compat.interval)}`
      : '-';
    old.set(r.id, `| \`${r.id}\` | ${r.view} | ${result} | ${noise} | ${frame} |`);
  }
  const table = [
    `Last recorded ${environment.date.slice(0, 10)} at ${environment.commit} on ${environment.gpu} (${environment.browser}); a row not rerun then keeps the numbers of its last run on the same machine.`,
    '',
    '| Demo | View | On the WebGL2 layer | Native run-to-run (d > 2, mean) | Frame work native / layer; interval native / layer |',
    '| --- | --- | --- | --- | --- |',
    ...[...old.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([, line]) => line),
  ].join('\n');
  await writeFile(docPath, `${before}${start}\n${table}\n${end}${after}`);
}
