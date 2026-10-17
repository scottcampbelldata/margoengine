// Close-up screenshots of one CAD file through the CAD-scale page (tests/cad-scale.html), for judging shading and
// geometry where the benchmark's whole-model shots are too small: same loader, lighting and display as the benchmark.
//   node scripts/cad-inspect.mjs --file=test-results/cad-corpus/nist/x.stp --format=step [--kernel=margo]
//     [--views='[{"name":"flange","azimuth":35,"elevation":30,"zoom":0.3,"focus":[1,0.5,0.5],"cut":"lower"}]']
// Each view: azimuth and elevation in degrees, zoom scales the framing distance, focus is a point in the model's bounds
// (0 to 1 per axis), cut 'upper' or 'lower' keeps that half of a cut at mid height. Without --views: the benchmark view,
// four close-ups around the model, and the cut from above. Shots go to test-results/cad-inspect/<file>/<name>.png.
import { mkdir } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = arg('file'),
  format = arg('format'),
  kernel = arg('kernel');
if (!file || !format)
  throw new TypeError('Pass --file=<path inside this checkout> and --format=<step|iges|stl|obj|glb|gltf>');
const views = arg('views')
  ? JSON.parse(arg('views'))
  : [
      { name: 'whole' },
      ...[35, 125, 215, 305].map((azimuth) => ({ name: `close-${azimuth}`, azimuth, zoom: 0.45 })),
      { name: 'cut-from-above', elevation: 60, cut: 'lower' },
    ];
const out = `test-results/cad-inspect/${file.replace(/^.*[\\/]/, '').replace(/[^\w.-]+/g, '_')}${kernel ? `-${kernel}` : ''}`;
await mkdir(out, { recursive: true });
const q = new URLSearchParams({ url: `/${file.replaceAll('\\', '/')}`, format, frames: '10' });
if (kernel) q.set('kernel', kernel);
const release = await acquire({ owner: 'cad-inspect' });
try {
  const browser = await openBrowser({ startPath: `/tests/cad-scale.html?${q}`, port: 5234 });
  try {
    const { page } = browser;
    await page.waitForFunction(() => window.cadScale, null, { timeout: 10 * 60_000 });
    const result = await page.evaluate(() => window.cadScale);
    if (!result.ok) throw new Error(`Load failed at ${result.stage}: ${result.error ?? result.errors?.join('; ')}`);
    console.log(`${file}: ${result.parts} parts, ${result.triangles} triangles`);
    for (const view of views) {
      await page.evaluate((v) => window.cadScaleView(v), view);
      const path = `${out}/${view.name}.png`;
      await page.locator('canvas').screenshot({ path });
      console.log(path);
    }
  } finally {
    await browser.close();
  }
} finally {
  release();
}
