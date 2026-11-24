// Stills of the Fauld places from their shot files (tools/shot/shots/fauld-frNNN.json), one per shot at its mid probe:
//   node packages/scenes/test/fauld-still.mjs --shots=fr008,fr074 --out=<folder> [--w=1920 --h=1080] [--library=<asset library>]
// Each still must draw with no GPU error and not be blank. The asset library (models, the OS Terrain 50 grid) is served
// at /asset-library/ from --library, else MARGO_ASSETS, else the Assets folder beside the Projects folder (../../Assets).
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const w = Number(arg('w', 1280)),
  h = Number(arg('h', 720)),
  out = arg('out', 'test-results/fauld-stills'),
  library = arg('library', process.env.MARGO_ASSETS ?? resolve(process.cwd(), '../../Assets')),
  shots = arg('shots', 'fr008').split(','),
  port = 5321,
  context = await openBrowser({ startPath: '/packages/scenes/test/fauld-still.html', port }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
await page.route(
  (url) => url.pathname.startsWith('/asset-library/'),
  async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/asset-library\//, ''));
    try {
      await route.fulfill({ body: await readFile(join(library, path)) });
    } catch {
      await route.fulfill({ status: 404, body: '' });
    }
  },
);
await page.setViewportSize({ width: Math.max(w, 1440), height: Math.max(h, 1100) });
await mkdir(out, { recursive: true });
const failed = [];
try {
  for (const shot of shots) {
    try {
      await page.goto(`http://127.0.0.1:${port}/packages/scenes/test/fauld-still.html?shot=${shot}&w=${w}&h=${h}`);
      await page.waitForFunction(() => window.ready, null, { timeout: 600000 });
      const r = await page.evaluate(() => window.check.run());
      const png = await page.locator('canvas').screenshot();
      await writeFile(join(out, `fauld-${shot}.png`), png);
      const img = await decodePNG(png);
      let sum = 0;
      for (let i = 0; i < img.data.length; i += 4) sum += img.data[i] + img.data[i + 1] + img.data[i + 2];
      const mean = sum / (img.data.length / 4) / 3;
      console.log(
        shot,
        `built ${Math.round(r.built)} ms`,
        `${r.fields} fields ${r.hedges} hedges ${r.trees} trees ${r.lanes} lanes`,
        `mean ${mean.toFixed(1)}`,
        r.errors.length ? `ERRORS ${r.errors[0]}` : '',
      );
      assert.deepEqual(r.errors, [], shot);
      assert.ok(mean > 8 && mean < 248, `${shot} is blank (mean ${mean.toFixed(1)})`);
    } catch (e) {
      failed.push(`${shot}: ${e.message.split('\n')[0]}`);
      console.log('FAILED', shot, e.message.split('\n')[0]);
    }
  }
  if (pageErrors.length) console.log('page errors', pageErrors.slice(0, 5));
  assert.deepEqual(failed, []);
  console.log('fauld stills passed');
} finally {
  await context.close();
}
