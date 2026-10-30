// Repro for docs/known-bugs.md "4x MSAA blending is not repeatable": draws one still frame many times and reports
// every frame that differs from the first. It exits 1 when any frame differs (it is a repro, not a check:merge gate).
//   node scripts/gpu-lock.mjs run --owner=<you> -- node scripts/msaa-blend-repeat-check.mjs [--frames=30] [--mask=7]
//     [--grid=6] [--khronos[=ToyCar,IridescenceLamp]] [--captures=4] [--max-minutes=15]
// Part 1, plain WebGPU (scripts/support/msaa-blend-repeat.html, no Margo code): the same commands every frame, and the
// multisampled colour copied before and after a blended pass that multiplies by one constant colour. Samples that are
// equal before the pass in every frame but differ after it show the GPU blending differently from frame to frame.
// `--mask=7` keeps the blended pipeline off one sample, which makes the frames equal on the GPUs measured.
// Part 2, `--khronos`: the Khronos gallery models (examples/khronos-gallery.html?model=Name, 640x480, reduced motion,
// as scripts/visual-compat.mjs captures them) loaded `--captures` times on native WebGPU, each capture compared with
// the first. Needs `npm run build:packages` first.
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { decodePNG } from '../tests/support/png.js';
import { acquire } from './gpu-lock.mjs';
import { launchBrowser, browserLabel } from './lib/browser.mjs';
import { closeAll } from './support/shutdown.mjs';

const root = resolve(import.meta.dirname, '..');
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.includes('=') ? hit.slice(name.length + 3) : '';
};
const frames = Number(arg('frames', 30)),
  captures = Number(arg('captures', 4)),
  maxMinutes = Number(arg('max-minutes', 15)),
  khronos = arg('khronos'),
  models = khronos === undefined ? [] : (khronos || 'ToyCar,IridescenceLamp').split(',');
const query = new URLSearchParams();
for (const name of ['mask', 'grid', 'size']) if (arg(name) !== undefined) query.set(name, arg(name));
if (!(frames >= 2) || !(captures >= 2))
  throw new RangeError('msaa-blend-repeat: --frames and --captures must be 2 or more');

// Hard limit for the whole run: on timeout the exit handler releases the lock.
setTimeout(() => {
  console.error(`msaa-blend-repeat: over ${maxMinutes} min, stopped`);
  process.exit(1);
}, maxMinutes * 60_000).unref();
const release = await acquire({ owner: 'msaa-blend-repeat', mode: 'shared' });
process.on('exit', () => release());
let server,
  browser,
  failed = false;
try {
  server = await (
    await createServer({
      configFile: false,
      root,
      logLevel: 'error',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { port: 0, hmr: false, watch: null },
    })
  ).listen();
  const origin = new URL(server.resolvedUrls.local[0]).origin;
  browser = await launchBrowser({ headless: true, args: ['--enable-unsafe-webgpu'] });
  console.log(`${browserLabel()} ${browser.version()}`);

  const context = await browser.newContext(),
    page = await context.newPage();
  page.on('pageerror', (e) => console.error(`  pageerror: ${e.message}`));
  await page.goto(`${origin}/scripts/support/msaa-blend-repeat.html?${query}`);
  await page.waitForFunction('window.reproReady === true', null, { timeout: 60_000 });
  const { gpu, rows } = await page.evaluate((n) => window.repeatFrames(n), frames);
  await context.close();
  const bad = rows.filter((r) => r.after || r.resolved);
  console.log(
    `plain WebGPU ${query.size ? `(${query}) ` : ''}on ${gpu}: ${frames} frames, ${bad.length} differ from frame 0`,
  );
  for (const r of bad.slice(0, 5))
    console.log(
      `  frame ${r.frame}: samples before the blended pass ${r.before}, after it ${r.after}, resolved texels ${r.resolved}; ${r.example}`,
    );
  if (bad.length) failed = true;
  if (rows.some((r) => r.before))
    console.log('  (the opaque pass differs too: the blended pass is not the only cause here)');

  for (const model of models) {
    const shots = [];
    for (let i = 0; i < captures; i++) {
      const c = await browser.newContext({ viewport: { width: 640, height: 480 }, reducedMotion: 'reduce' }),
        p = await c.newPage();
      await p.goto(`${origin}/examples/khronos-gallery.html?model=${model}`);
      await p.waitForFunction("document.body.dataset.ready==='true'", null, { timeout: 120_000 });
      const shot = () => p.screenshot({ animations: 'disabled' });
      let last = Buffer.alloc(0),
        next = await shot();
      for (let k = 0; k < 6 && !next.equals(last); k++) {
        await p.waitForTimeout(500); // fixed-wait: retakes the shot until two in a row match, as scripts/visual-compat.mjs
        [last, next] = [next, await shot()];
      }
      shots.push(await decodePNG(next));
      await c.close();
    }
    const counts = shots.slice(1).map((b) => {
      const a = shots[0];
      let n = 0;
      for (let k = 0; k < a.data.length; k += 4)
        if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2]) n++;
      return n;
    });
    console.log(`Khronos ${model}: captures 2..${captures} differ from capture 1 on ${counts.join(', ')} pixels`);
    if (counts.some(Boolean)) failed = true;
  }
} finally {
  await closeAll({ browser, servers: [server] });
}
process.exit(failed ? 1 : 0);
