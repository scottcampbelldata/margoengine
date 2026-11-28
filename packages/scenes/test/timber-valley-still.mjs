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
import { WATER_LOOKS } from '@margoengine/water/settings';
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
if (out) await mkdir(out, { recursive: true });
console.log('device', context.hardware?.compat ? 'webgl2-compat layer' : 'webgpu');
// The views asked for take --query; the fixed comparisons below (fire against none, day against night) take only their
// own settings, so --query=hour=22 does not turn their day still into a night one.
const still = async (view, query = '') => {
  await page.goto(
    `http://127.0.0.1:${port}/packages/scenes/test/timber-valley-still.html?view=${view}&w=${w}&h=${h}${query ? '&' + query : ''}`,
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
  // KB-BIOMES-RIVERSTEP1: from the creek bank, far from where the camera stood at attach, the water fills the channel
  // ahead: blue over red in the lower middle of the frame, where lost ground detail left brown flat floor.
  const quiet = await still('creek', 'fire=none&weather=calm&hour=13&quality=preview'),
    bank = quiet.img;
  // KB-SKY-CLOUDBLOB1: the cumulus stand clear over the highest ground. KB-BIOMES-LOOKFAMILY1: the scene's default
  // look reaches the creek's water.
  assert.ok(quiet.r.cloudBase > quiet.r.peak + 500, `clouds from ${quiet.r.cloudBase}, ground to ${quiet.r.peak}`);
  assert.deepEqual(quiet.r.waterColor, [...WATER_LOOKS.animatedFeature.color]);
  // KB-SCENES-TVTAA1: a preview draws no TAA; film (the default, every view below) does, with the swaying scatters' motion.
  assert.equal(quiet.r.taa, false, 'preview draws no TAA');
  let red = 0,
    blue = 0;
  for (let y = Math.floor(bank.height * 0.75); y < Math.floor(bank.height * 0.95); y++)
    for (let x = Math.floor(bank.width * 0.3); x < Math.floor(bank.width * 0.5); x++) {
      red += bank.data[(y * bank.width + x) * 4];
      blue += bank.data[(y * bank.width + x) * 4 + 2];
    }
  console.log('creek ahead, blue over red', (blue / red).toFixed(2));
  assert.ok(blue > 1.3 * red, `the creek's water lies ahead of its bank: blue ${blue} against red ${red}`);
  for (const view of views) {
    const { r, png, img } = await still(view, extra);
    if (out) await writeFile(join(out, `${view}.png`), png);
    const { mean, sd } = spread(img);
    console.log(
      view,
      `built in ${Math.round(r.built)} ms`,
      `${r.lots} lots`,
      'fire',
      JSON.stringify(r.fire),
      `mean ${mean.toFixed(1)} sd ${sd.toFixed(1)}`,
    );
    assert.ok(mean > 15 && mean < 245, `${view}: not blank (mean ${mean.toFixed(1)})`);
    assert.ok(sd > 8, `${view}: the picture has structure, not one flat colour (sd ${sd.toFixed(1)})`);
    assert.ok(r.lots > 0, 'the town lots are laid out');
    assert.ok(r.fire && r.fire.time >= 1800, `the fire has burned its fireTime: ${JSON.stringify(r.fire)}`);
    assert.equal(r.post[0], 'gtao', 'the occlusion pass runs first');
    if (!/quality=preview/.test(extra)) {
      assert.ok(r.taa, `${view}: film quality resolves with TAA`);
      assert.ok(r.swaying > 0, `${view}: the swaying scatters draw their own motion (${r.swaying})`);
    }
  }
  // The fire shows: the fire-line view with the fire differs from the same view with none.
  const burning = (await still('fire-line')).img,
    none = await still('fire-line', 'fire=none');
  assert.equal(none.r.fire, null);
  let changed = 0;
  for (let i = 0; i < burning.data.length; i += 4)
    if (Math.abs(burning.data[i] - none.img.data[i]) + Math.abs(burning.data[i + 2] - none.img.data[i + 2]) > 30)
      changed++;
  console.log('fire changes', ((400 * changed) / burning.data.length).toFixed(1), 'percent of the fire-line view');
  assert.ok(changed / (burning.data.length / 4) > 0.02, `the fire shows: ${changed} pixels`);
  // The mesh registry draws a .gltf model by key on the GPU.
  const rocks = await still('creek', 'rock=/examples/assets/kaykit/adventurers/props/arrow_bow.gltf&fire=none');
  assert.ok(rocks.r.rockTriangles > 0, 'the registry model loaded');
  // KB-SCENES-NIGHTSUN1: at 22:00 the sun is 24 degrees down: the sky is the night's (stars, the moon of that date, blue
  // over the ridge, not the day's warm haze) and the moonlit town, with no fire, is far darker than the afternoon's.
  const sky = (img) => {
      let r = 0,
        b = 0,
        n = 0;
      for (let y = 0; y < Math.floor(img.height * 0.15); y++)
        for (let x = 0; x < img.width; x++, n++) {
          r += img.data[(y * img.width + x) * 4];
          b += img.data[(y * img.width + x) * 4 + 2];
        }
      return { r: r / n, b: b / n };
    },
    daySky = sky((await still('ridge', 'fire=none')).img),
    nightSky = sky((await still('ridge', 'fire=none&hour=22')).img),
    dayTown = spread((await still('town', 'fire=none')).img).mean,
    nightTown = spread((await still('town', 'fire=none&hour=22')).img).mean;
  console.log('sky over the ridge, day', JSON.stringify(daySky), 'night', JSON.stringify(nightSky));
  console.log('town mean, day', dayTown.toFixed(1), 'night', nightTown.toFixed(1));
  assert.ok(nightSky.b > nightSky.r && nightSky.b < daySky.b, 'the night sky is dark and blue');
  assert.ok(nightTown < 0.5 * dayTown, `the night is far darker than the day: ${nightTown} against ${dayTown}`);
  assert.deepEqual(pageErrors, []);
  console.log('timber valley still check passed');
} finally {
  await context.close();
}
