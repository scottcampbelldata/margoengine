// KB1824 regression: GlassVaseFlowers (native transmission plus BLEND glass) built twice in one page repeats byte for
// byte where the GPU allows it. One-sample captures repeat exactly everywhere. At the default 4x the RTX A6000 differs
// on up to 28 pixels by up to 10 levels at 270 degrees in 4 of 5 rebuilds (KB5700f's NVIDIA family: blended primitives
// that cover a pixel more than once in one draw, docs/limits.md); with the BLEND glass made OPAQUE it repeats 5 of 5,
// and an AMD RDNA 2 iGPU on the same PC repeats the unchanged model 5 of 5. So off NVIDIA the 4x captures are asserted
// too, and on NVIDIA they are reported. From the repository root, after building packages:
// node packages/oit/test/gpu/repeat-check.mjs (MARGO_COMPAT=1 for the WebGL2 layer)
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { compatRun } from '../../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../../tests/support/png.js';

const url = '/examples/assets/khronos-samples/GlassVaseFlowers.glb',
  builds = 4;
const timer = setTimeout(() => {
  console.error('repeat-check: timed out after 600 s');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 600_000);
const context = await openBrowser({ startPath: '/packages/oit/test/gpu/real.html', port: 'free' }),
  { page } = context;
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const vendor = context.hardware?.webgpu?.vendor ?? '',
    nvidia = /nvidia/i.test(vendor) || /nvidia/i.test(context.hardware?.webglRenderer ?? '');
  const shot = async () => {
    const data = await page.evaluate(() => window.check.shot());
    return decodePNG(Buffer.from(data.split(',')[1], 'base64'));
  };
  const differing = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.data.length; i += 4)
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
    return n;
  };
  const report = {};
  for (const samples of [1, 4]) {
    const pictures = { 180: [], 270: [] };
    for (let b = 0; b < builds; b++) {
      await page.evaluate((o) => window.check.build(o), { samples, url });
      for (const angle of [180, 270]) {
        await page.evaluate((a) => window.check.turn(a), angle);
        pictures[angle].push(await shot());
      }
    }
    for (const angle of [180, 270])
      report[`${samples}x ${angle}`] = pictures[angle].slice(1).map((p) => differing(pictures[angle][0], p));
  }
  const errors = await page.evaluate(() => window.check.errors);
  console.log(JSON.stringify({ compat: compatRun(), vendor, nvidia, report }));
  assert.deepEqual(errors, []);
  for (const [name, counts] of Object.entries(report)) {
    if (name.startsWith('4x') && nvidia) continue;
    assert.deepEqual(
      counts,
      counts.map(() => 0),
      `GlassVaseFlowers ${name} repeats exactly: ${counts}`,
    );
  }
} finally {
  clearTimeout(timer);
  await context.close();
}
