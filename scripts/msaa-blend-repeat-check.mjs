// Repro for docs/known-bugs.md "4x MSAA blending is not repeatable": draws one still frame many times and reports
// every frame that differs from the first. It exits 1 when any frame differs (it is a repro, not a check:merge gate).
//   node scripts/gpu-lock.mjs run --owner=<you> -- node scripts/msaa-blend-repeat-check.mjs [--frames=30] [--mask=7]
//     [--grid=6] [--khronos[=ToyCar,IridescenceLamp]] [--captures=4] [--max-minutes=15]
//     [--replay=LightsPunctualLamp --pixel=292,160 [--replay-frames=300] [--replay-mask=7] [--adapter=swiftshader]]
// Part 1, plain WebGPU (scripts/support/msaa-blend-repeat.html, no Margo code): the same commands every frame, and the
// multisampled colour copied before and after a blended pass that multiplies by one constant colour. Samples that are
// equal before the pass in every frame but differ after it show the GPU blending differently from frame to frame.
// `--mask=7` keeps the blended pipeline off one sample, which makes the frames equal on the GPUs measured.
// Part 2, `--khronos`: the Khronos gallery models (examples/khronos-gallery.html?model=Name, 640x480, reduced motion,
// as scripts/visual-compat.mjs captures them) loaded `--captures` times on native WebGPU, each capture compared with
// the first. Needs `npm run build:packages` first.
// Part 3, `--replay=Model`: one still frame of the model recorded (scripts/support/webgpu-trace.js, every object, shader
// and byte) and replayed on a fresh device with no Margo code (scripts/support/webgpu-replay.html). It reports the 4
// samples of `--pixel` after the last multisampled pass and each frame's whole canvas against the most common frame, and
// checks that this frame is the live page's frame. `--replay-mask=7` replays with the blended pipelines off one sample,
// `--adapter=swiftshader` asks Chromium for its software adapter. With `--replay` the other parts do not run.
import { mkdir, writeFile } from 'node:fs/promises';
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
const replayModel = arg('replay'),
  replayFrames = Number(arg('replay-frames', 300)),
  replayMask = arg('replay-mask'),
  adapter = arg('adapter'),
  pixel = arg('pixel', '0,0').split(',').map(Number);
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

const launch = () =>
  launchBrowser({
    headless: true,
    args: ['--enable-unsafe-webgpu', ...(adapter ? [`--use-webgpu-adapter=${adapter}`] : [])],
  });

/** Part 3: records one still frame of the gallery model and replays it with no Margo code; true when frames differ. */
async function replayKhronos(origin) {
  const c = await browser.newContext({ viewport: { width: 640, height: 480 }, reducedMotion: 'reduce' }),
    p = await c.newPage(),
    tracePath = resolve(root, 'test-results/msaa-replay-trace.json');
  p.on('pageerror', (e) => console.error(`  pageerror: ${e.message}`));
  await p.route('**/khronos-gallery.js*', async (route) => {
    const response = await route.fetch(),
      body = await response.text(),
      marker = 'gpuErrors = [];';
    if (!body.includes(marker))
      throw new Error('msaa-blend-repeat: the gallery no longer has the line this repro hooks');
    await route.fulfill({
      response,
      body:
        "import { installTrace as __install } from '/scripts/support/webgpu-trace.js'; window.__tracer = __install();\n" +
        body.replace(marker, `${marker} window.__gallery = { engine, device };`),
    });
  });
  await p.goto(`${origin}/examples/khronos-gallery.html?model=${replayModel}`);
  await p.waitForFunction("document.body.dataset.ready==='true'", null, { timeout: 120_000 });
  await p.waitForTimeout(1000); // fixed-wait: running frames settle lazily built pipelines before the recording
  const parts = await p.evaluate(async () => {
    const { engine, device } = window.__gallery;
    engine.stop();
    await device.queue.onSubmittedWorkDone();
    const trace = await window.__tracer.record(device, () => engine.render({ delta: 0 }));
    await device.queue.onSubmittedWorkDone();
    window.__text = JSON.stringify(trace);
    return Math.ceil(window.__text.length / 5e7);
  });
  let text = '';
  for (let i = 0; i < parts; i++) text += await p.evaluate((k) => window.__text.slice(k * 5e7, (k + 1) * 5e7), i);
  await mkdir(resolve(root, 'test-results'), { recursive: true });
  await writeFile(tracePath, text);
  await p.addStyleTag({ content: '#caption{display:none}' }); // the page's text is not in the frame
  const live = await decodePNG(await p.locator('canvas').first().screenshot({ animations: 'disabled' }));
  // The replay runs in a new browser: nothing of the engine's page shares its process.
  await browser.close();
  browser = await launch();
  const context = await browser.newContext(),
    page = await context.newPage();
  page.on('pageerror', (e) => console.error(`  pageerror: ${e.message}`));
  page.on('crash', () => console.error('  the replay page crashed'));
  page.on('console', (m) => m.type() === 'error' && console.error(`  console: ${m.text()}`));
  await page.goto(`${origin}/scripts/support/webgpu-replay.html?src=/test-results/msaa-replay-trace.json`);
  await page.waitForFunction(() => window.replayReady, null, { timeout: 60_000 });
  const r = await page.evaluate(
    ([n, at, mask]) => window.replay(n, at, [], { whole: true, ...(mask === undefined ? {} : { blendMask: mask }) }),
    [replayFrames, pixel, replayMask === undefined ? undefined : Number(replayMask)],
  );
  await context.close();
  const { reference, wholeDiffer, frameSets } = r,
    referenceBytes = Buffer.from(reference.bytes, 'base64');
  let unlike = 0,
    box = [Infinity, Infinity, -1, -1];
  if (reference.width === live.width && reference.height === live.height)
    for (let k = 0; k < referenceBytes.length; k += 4)
      // The stand-in has the canvas format: green, and red plus blue, hold for either channel order.
      if (
        referenceBytes[k + 1] !== live.data[k + 1] ||
        referenceBytes[k] + referenceBytes[k + 2] !== live.data[k] + live.data[k + 2]
      ) {
        unlike++;
        const x = (k / 4) % live.width,
          y = Math.floor(k / 4 / live.width);
        box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
      }
  console.log(
    `${replayModel} replayed ${replayFrames} times with no Margo code on ${r.gpu}${replayMask === undefined ? '' : ` (blended pipelines mask ${replayMask})`}: ${r.renderPasses} render passes, probed pass ${r.probedPass}, validation errors ${r.errors.length}`,
  );
  if (r.errors.length) console.log(`  first error: ${r.errors[0]}`);
  console.log(
    `  most common replayed frame against the live page: ${reference.width}x${reference.height} vs ${live.width}x${live.height}, ${unlike} pixels differ${unlike ? ` inside ${box}` : ''}`,
  );
  console.log(`  samples at ${pixel}, distinct sets: ${JSON.stringify(r.values)}`);
  console.log(
    `  whole canvas: ${frameSets} distinct frames, ${wholeDiffer.length} of ${replayFrames} differ from the most common`,
  );
  for (const d of wholeDiffer.slice(0, 8))
    console.log(`    frame ${d.frame}: ${d.pixels} pixels, max ${d.max}, first at ${d.first}`);
  return wholeDiffer.length > 0 || r.differ.length > 0;
}
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
  browser = await launch();
  console.log(`${browserLabel()} ${browser.version()}`);
  if (replayModel) {
    failed = await replayKhronos(origin);
    await closeAll({ browser, servers: [server] });
    process.exit(failed ? 1 : 0);
  }

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
