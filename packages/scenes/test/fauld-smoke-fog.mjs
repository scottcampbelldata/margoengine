// GPU check of the Fauld tunnels' fire smoke in the dusty air (KB-FAULD-SMOKEBLACK1):
//   node packages/scenes/test/fauld-smoke-fog.mjs [--out=<folder>] [--library=<asset library>]
// Frame fr096 looks down the drift at smoke some tens of metres off, in air the lamps and fires light. Every smoke
// column is one the volumetric fog draws, and no pixel under it is black: a puff drawn without the lit air in front of
// it covered the glow with a flat black shape (21,000 pixels at or under luma 1.5 at 960 x 540).
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const library = arg(
    'library',
    process.env.MARGO_ASSET_LIBRARY ?? resolve(process.cwd(), '../../Assets/blender-library'),
  ),
  out = arg('out', 'test-results/fauld-smoke-fog'),
  port = Number(arg('port', 5322)),
  context = await openBrowser({ startPath: '/examples/fauld/index.html', port }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
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
await page.setViewportSize({ width: 1280, height: 800 });
await mkdir(out, { recursive: true });
try {
  await page.goto(`http://127.0.0.1:${port}/examples/fauld/index.html?shot=fr096&w=960&h=540`);
  await page.waitForFunction(
    () => document.querySelector('#viewport')?.dataset.ready || document.querySelector('#viewport')?.dataset.error,
    null,
    { timeout: 600000 },
  );
  assert.equal(await page.evaluate(() => document.querySelector('#viewport').dataset.error), undefined);
  const r = await page.evaluate(async () => {
    await window.fauld.still(24);
    const { fires, smokes, fog } = window.fauld.scene.parts,
      columns = [...fires.map((f) => f.smoke), ...smokes].filter(Boolean);
    return {
      errors: window.fauld.errors,
      columns: columns.length,
      unfogged: columns.filter((s) => !fog.effects.has(s.effect)).length,
    };
  });
  const png = await page.locator('#viewport canvas').screenshot();
  await writeFile(join(out, 'fauld-fr096.png'), png);
  const img = await decodePNG(png);
  let black = 0;
  for (let i = 0; i < img.data.length; i += 4)
    if (0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2] <= 1.5) black++;
  console.log(`columns ${r.columns}, unfogged ${r.unfogged}, black pixels ${black}`);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(pageErrors, []);
  assert.ok(r.columns >= 3, 'the fire state has smoke columns');
  assert.equal(r.unfogged, 0, 'the fog draws every smoke column');
  assert.ok(black < 200, `${black} black pixels: smoke drawn without the lit air in front of it`);
  console.log('fauld smoke fog passed');
} finally {
  await context.close();
}
