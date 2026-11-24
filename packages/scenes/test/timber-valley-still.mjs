// Real-GPU check of @margoengine/scenes/timber-valley: every view draws with no GPU error and is not blank; the forest
// shows (the ridge view with the forest's walls is not one flat colour); the fire burns, its embers fly and its smoke
// and flames change the fire-line view against the same view with fire=none; a model from a .gltf drawn through the
// biome mesh registry (`meshes`, here a repository sample prop in place of the procedural rock) loads and draws with no
// error. With --out=<folder> it saves each still as <view>.png (use --w=1920 --h=1080 for film stills); with
// --library=<folder> /asset-library/ URLs are served from that folder (the asset library), and --query adds settings.
// Run from the repository root after building packages:
//   node packages/scenes/test/timber-valley-still.mjs   (MARGO_COMPAT=1 for the WebGL2 compatibility layer)
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const w = Number(arg('w', 640)),
  h = Number(arg('h', 360)),
  out = arg('out'),
  extra = arg('query', ''),
  library = arg('library'),
  views = arg('views', 'aerial-west,town,ridge,fire-line').split(','),
  port = 5319, // its own: dune-coast-still serves on 5318
  context = await openBrowser({ startPath: '/packages/scenes/test/timber-valley-still.html', port }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
if (library)
  // Matched on the path: a page URL whose query names an /asset-library/ model must still load the page itself.
  await page.route((url) => url.pathname.startsWith('/asset-library/'), async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/asset-library\//, ''));
    try {
      await route.fulfill({ body: await readFile(join(library, path)) });
    } catch {
      await route.fulfill({ status: 404, body: '' });
    }
  });
await page.setViewportSize({ width: Math.max(w, 1440), height: Math.max(h, 1100) });
if (out) await mkdir(out, { recursive: true });
console.log('device', context.hardware?.compat ? 'webgl2-compat layer' : 'webgpu');
const still = async (view, query = '') => {
  await page.goto(
    `http://127.0.0.1:${port}/packages/scenes/test/timber-valley-still.html?view=${view}&w=${w}&h=${h}${query ? '&' + query : ''}${extra ? '&' + extra : ''}`,
  );
  await page.waitForFunction(() => window.ready, null, { timeout: 300000 });
  const r = await page.evaluate(() => window.check.run());
  assert.deepEqual(r.errors, [], `${view} ${query}`);
  const png = await page.locator('canvas').screenshot();
  return { r, png, img: await decodePNG(png) };
};
const spread = (img) => {
  let sum = 0,
    sq = 0;
  const n = img.data.length / 4;
  for (let i = 0; i < img.data.length; i += 4) {
    const l = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
    sum += l;
    sq += l * l;
  }
  return { mean: sum / n, sd: Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) };
};
try {
  for (const view of views) {
    const { r, png, img } = await still(view);
    if (out) await writeFile(join(out, `${view}.png`), png);
    const { mean, sd } = spread(img);
    console.log(view, `built in ${Math.round(r.built)} ms`, `${r.lots} lots`, 'fire', JSON.stringify(r.fire), `mean ${mean.toFixed(1)} sd ${sd.toFixed(1)}`);
    assert.ok(mean > 15 && mean < 245, `${view}: not blank (mean ${mean.toFixed(1)})`);
    assert.ok(sd > 8, `${view}: the picture has structure, not one flat colour (sd ${sd.toFixed(1)})`);
    assert.ok(r.lots > 0, 'the town lots are laid out');
    assert.ok(r.fire && r.fire.time >= 1800, `the fire has burned its fireTime: ${JSON.stringify(r.fire)}`);
    assert.equal(r.post[0], 'gtao', 'the occlusion pass runs first');
  }
  // The fire shows: the fire-line view with the fire differs from the same view with none.
  const burning = (await still('fire-line')).img,
    none = await still('fire-line', 'fire=none');
  assert.equal(none.r.fire, null);
  let changed = 0;
  for (let i = 0; i < burning.data.length; i += 4)
    if (Math.abs(burning.data[i] - none.img.data[i]) + Math.abs(burning.data[i + 2] - none.img.data[i + 2]) > 30) changed++;
  console.log('fire changes', ((400 * changed) / burning.data.length).toFixed(1), 'percent of the fire-line view');
  assert.ok(changed / (burning.data.length / 4) > 0.02, `the fire shows: ${changed} pixels`);
  // The mesh registry draws a .gltf model by key on the GPU.
  const rocks = await still('creek', 'rock=/examples/assets/kaykit/adventurers/props/arrow_bow.gltf&fire=none');
  assert.ok(rocks.r.rockTriangles > 0, 'the registry model loaded');
  assert.deepEqual(pageErrors, []);
  console.log('timber valley still check passed');
} finally {
  await context.close();
}
