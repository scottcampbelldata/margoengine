// The visual check's WebGL2 compatibility run (docs/webgl2-compat-demos.md, roadmap milestone M8): every site demo and
// every Khronos gallery model, once on native WebGPU and once on the WebGL2 compatibility layer, in the same browser on
// the same GPU, compared pixel by pixel.
//   npm run visual:compat [-- --only=dof,earth] [--no-build] [--write] [--max-minutes=90]
// The demos and how a page gets the layer: scripts/support/visual-compat-pages.js. Per demo: native twice (its
// run-to-run noise) and the layer once, in exact-pixel captures of the demo's still frame (prefers-reduced-motion, as
// the visual check). d = max RGB difference per pixel (0 to 255). "same" is the roadmap's parity rule (decision 4): at
// most 0.1% of pixels with d > 2 and a mean d of at most 0.25; "differs" states the numbers; "refused" means the demo
// showed the layer's refusal (MargoError code `unsupported`) and names it.
// Gate: each demo's status must match scripts/support/visual-compat-expected.json, and a "differs" demo may not get
// worse than its recorded share and mean (x1.5 plus 0.001 / 0.25), and a demo recorded with an exact still frame (its
// two native captures equal pixel for pixel) must keep it, so native noise can never flip its status. `--write` records
// this run there and rewrites the table in docs/webgl2-compat-demos.md (its frame column is the budget step's).
// Pixels only, so it takes a shared slot of the GPU lock, like the visual check. The frame cost and its budget are
// npm run visual:compat:budget (scripts/visual-compat-budget.mjs), which holds the GPU exclusively.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodePNG } from '../tests/support/png.js';
import { acquire } from './gpu-lock.mjs';
import { browserLabel, launchBrowser } from './lib/browser.mjs';
import { closeAll } from './support/shutdown.mjs';
import { rewriteTable } from './support/visual-compat-doc.js';
import { openCase, selectCases, startServers, withQuery } from './support/visual-compat-pages.js';
import { gateProblems, record, SAME, verdict } from './support/visual-compat-status.js';
import { compare, downsample, encodePNG } from './support/visual-image.js';

const root = resolve(import.meta.dirname, '..'),
  out = resolve(root, 'test-results/visual-compat'),
  expectedPath = resolve(root, 'scripts/support/visual-compat-expected.json');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = (arg('only') ?? '').split(',').filter(Boolean),
  write = process.argv.includes('--write'),
  maxMinutes = Number(arg('max-minutes') ?? 90);
export { SAME };
const cases = selectCases(only);

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
let servers = [],
  browser;
let exitCode = 0;
try {
  await mkdir(out, { recursive: true });
  const started = await startServers(cases);
  servers = started.servers;
  browser = await launchBrowser({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const environment = { browser: `${browserLabel()} ${browser.version()}` };
  const expected = JSON.parse(await readFile(expectedPath, 'utf8').catch(() => '{"demos":{}}'));
  const rows = [];
  for (const c of cases) {
    const { id, demo, viewName } = c,
      row = { id, view: viewName, url: withQuery(demo.path, c.view.query), errors: [] };
    const run = async (compat) => {
      let opened;
      try {
        opened = await openCase(browser, c, { compat, ...started });
        const { page, errors } = opened;
        if (opened.refused) return { refused: opened.refused, errors, ms: Date.now() - opened.started };
        if (opened.off) return { off: true, errors, ms: Date.now() - opened.started };
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
        return { image: await decodePNG(next), gpu, errors, ms: Date.now() - opened.started };
      } catch (error) {
        opened ??= error;
        if (!opened.errors) return { errors: [`capture: ${String(error.message ?? error).split('\n')[0]}`], ms: 0 };
        if (!opened.errors.some((e) => e.startsWith('capture: ')))
          opened.errors.push(`capture: ${String(error.message ?? error).split('\n')[0]}`);
        await opened.page
          ?.screenshot({ path: resolve(out, `${id}.${compat ? 'compat' : 'native'}.failed.png`) })
          .catch(() => {});
        return { errors: opened.errors, ms: Date.now() - opened.started };
      } finally {
        await opened?.context?.close();
      }
    };
    const a = await run(false),
      b = await run(false),
      l = await run(true);
    environment.gpu ??= a.gpu;
    row.errors.push(...a.errors.map((e) => `native: ${e}`), ...l.errors.map((e) => `layer: ${e}`));
    if (!a.image || !b.image) row.status = 'native failed';
    else if (l.refused) row.status = 'refused';
    // Kept off the layer by its page (`needsWebGPU(area, { layer: false })`) while a known bug stands.
    else if (l.off) row.status = 'webgpu only';
    else if (!l.image) row.status = 'failed';
    else {
      row.noise = metrics(a.image, b.image);
      row.diff = metrics(a.image, l.image);
      row.status = verdict(row.diff);
      await writeFile(resolve(out, `${id}.native.png`), encodePNG(downsample(a.image, 2)));
      await writeFile(resolve(out, `${id}.compat.png`), encodePNG(downsample(l.image, 2)));
      if (row.diff.image) await writeFile(resolve(out, `${id}.diff.png`), encodePNG(downsample(row.diff.image, 2)));
      delete row.noise.image;
      delete row.diff.image;
    }
    row.refused = l.refused;
    row.seconds = { native: a.ms / 1000, compat: l.ms / 1000 };
    // The gate (scripts/support/visual-compat-status.js): the recorded status, no worse differences, an exact still
    // frame stays exact.
    const problems =
      row.status === 'native failed' || row.status === 'failed'
        ? [row.errors[0] ?? row.status]
        : gateProblems(row, expected.demos[id], { write });
    if (problems.length) exitCode = 1;
    row.problems = problems;
    rows.push(row);
    const d = row.diff;
    console.log(
      `${problems.length ? 'FAIL' : 'ok  '} ${id}: ${row.status}${d ? ` (d>2 ${(d.over2 * 100).toFixed(2)}%, mean ${d.mean}, max ${d.max}; native noise d>2 ${(row.noise.over2 * 100).toFixed(2)}%, mean ${row.noise.mean})` : ''}${row.refused ? ` "${row.refused}"` : ''}${problems.length ? `: ${problems.join('; ')}` : ''}`,
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
          `<tr><td><b>${esc(r.status)}</b> ${esc(r.id)}<pre>${esc(JSON.stringify({ diff: r.diff, noise: r.noise, refused: r.refused, problems: r.problems }, null, 1))}\n${esc(r.errors.slice(0, 6).join('\n'))}</pre></td>${r.diff ? ['native', 'compat', 'diff'].map((k) => `<td>${k}<img src="${r.id}.${k}.png"></td>`).join('') : ''}</tr>`,
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
  await closeAll({ browser, servers }).catch((error) => console.warn(error.message));
  releaseGpu();
}
process.exit(exitCode);

/** Rewrites the pixel columns of the generated table in docs/webgl2-compat-demos.md; a row keeps its frame column. */
async function writeDoc(rows, environment) {
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  await rewriteTable((old) => {
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
      old.set(r.id, [r.id, r.view, result, noise, old.get(r.id)?.[4] ?? '-']);
    }
    return `Last recorded ${environment.date.slice(0, 10)} at ${environment.commit} on ${environment.gpu} (${environment.browser}); a row not rerun then keeps the numbers of its last run on the same machine.`;
  });
}
