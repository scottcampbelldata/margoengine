// Real-GPU check of @margoengine/scenes/dune-coast: every reference view renders with no GPU error, the sand reads as
// pale warm sand (red over blue, brighter than the grey sky's lower band is dark), the views are not blank and the
// grass shows (the camp view with and without it differs on the near ground). With
// --out=<folder> it saves each still as <view>.png (use --w=1920 --h=1080 for film stills). Run from the repository
// root after building packages:
//   node packages/scenes/test/dune-coast-still.mjs   (MARGO_COMPAT=1 for the WebGL2 compatibility layer)
// Asset check stills: --shots=<file.json> renders a list of {name, query} entries (the page's asset, at, yaw, eye,
// look... options; see dune-coast-still.html) into --out as <name>.png instead of the reference views, and fails if
// a model does not load or draws nothing.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const w = Number(arg('w', 640)),
  h = Number(arg('h', 360)),
  out = arg('out'),
  extra = arg('query', ''),
  views = arg(
    'views',
    'first-flight,camp-buildings,killdevil-from-flat,flyer-on-rail,killdevil-back,landing-rail-view,surf',
  ).split(','),
  port = 5318, // its own: check-wgsl serves on 5317
  context = await openBrowser({ startPath: '/packages/scenes/test/dune-coast-still.html', port }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
await page.setViewportSize({ width: Math.max(w, 1440), height: Math.max(h, 1100) });
if (out) await mkdir(out, { recursive: true });
console.log('device', context.hardware?.compat ? 'webgl2-compat layer' : 'webgpu');
// The standard deviation of sRGB luma (0 to 255) over a region given in fractions of the image.
const lumaSpread = (img, y0, y1, x0, x1) => {
  let n = 0,
    sum = 0,
    sq = 0;
  for (let y = Math.floor(img.height * y0); y < Math.floor(img.height * y1); y++)
    for (let x = Math.floor(img.width * x0); x < Math.floor(img.width * x1); x++, n++) {
      const k = (y * img.width + x) * 4,
        l = 0.2126 * img.data[k] + 0.7152 * img.data[k + 1] + 0.0722 * img.data[k + 2];
      sum += l;
      sq += l * l;
    }
  return Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
};
const mean = (img, y0, y1, x0, x1) => {
  const m = [0, 0, 0];
  let n = 0;
  for (let y = Math.floor(img.height * y0); y < Math.floor(img.height * y1); y++)
    for (let x = Math.floor(img.width * x0); x < Math.floor(img.width * x1); x++, n++)
      for (let c = 0; c < 3; c++) m[c] += img.data[(y * img.width + x) * 4 + c];
  return m.map((v) => v / n);
};
const shots = arg('shots');
try {
  if (shots) {
    const { readFile } = await import('node:fs/promises');
    for (const { name, query } of JSON.parse(await readFile(shots, 'utf8'))) {
      const url = `http://127.0.0.1:${port}/packages/scenes/test/dune-coast-still.html?w=${w}&h=${h}&${query}`;
      await page.goto(url);
      await page.waitForFunction(() => window.ready, null, { timeout: 300000 });
      const r = await page.evaluate(() => window.check.run());
      assert.deepEqual(r.errors, [], name);
      if (query.includes('asset=')) assert.ok(r.asset?.primitives > 0, `${name}: the model loaded and has primitives`);
      const png = await page.locator('canvas').screenshot();
      if (out) await writeFile(join(out, `${name}.png`), png);
      console.log(
        name,
        r.asset ? `${r.asset.primitives} primitives, bounds ${r.asset.bounds.map((v) => v.toFixed(2))}` : '',
      );
    }
    assert.deepEqual(pageErrors, []);
    console.log('asset stills done');
  } else
    for (const view of views) {
      await page.goto(
        `http://127.0.0.1:${port}/packages/scenes/test/dune-coast-still.html?view=${view}&w=${w}&h=${h}${extra ? '&' + extra : ''}`,
      );
      await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
      const r = await page.evaluate(() => window.check.run());
      assert.deepEqual(r.errors, [], view);
      const png = await page.locator('canvas').screenshot(),
        img = await decodePNG(png),
        ground = mean(img, 0.85, 0.98, 0.2, 0.8),
        sky = mean(img, 0.02, 0.1, 0, 1);
      if (out) await writeFile(join(out, `${view}.png`), png);
      console.log(view, 'ground sRGB', ground.map(Math.round), 'sky sRGB', sky.map(Math.round));
      // The near ground is sand (or surf in the surf view): warm, not grey-blue, and not black.
      if (view !== 'surf')
        assert.ok(
          ground[0] > ground[2] * 1.05 && ground[0] > 60,
          `${view}: the sand reads as sand ${ground.map(Math.round)}`,
        );
      assert.ok(sky[0] + sky[1] + sky[2] > 150, `${view}: a daylight sky ${sky.map(Math.round)}`);
      // KB-SCENES-SEAFOGDEPTH1: the sea reaches the horizon. Between the horizon (0.474 of the height) and where the
      // view's rays pass over the seabed's far edge (0.499), the fog read a depth with no sea in it and filled the rows
      // with one flat colour, the fog at infinity (spread 0); hazed by the water's own depth the far sea's waves show.
      if (view === 'surf') {
        const spread = lumaSpread(img, 0.477, 0.497, 0, 1);
        console.log('surf far sea luma spread', spread.toFixed(2));
        assert.ok(spread > 2, `surf: the far sea shows waves up to the horizon, not a flat fill (spread ${spread})`);
      }
    }
  if (!shots) {
    // KB-SCENES-BLOWNSAND-STATIC1: the sand loads on demand and still runs on the scene's clock. Time moved on before it
    // arrived (advanceTime and three frames) is replayed, so its clock equals every delta summed in order, and it draws.
    await page.goto(
      `http://127.0.0.1:${port}/packages/scenes/test/dune-coast-still.html?view=crest&w=${w}&h=${h}&blownSand=1&wind=14&early=1&frames=20`,
    );
    await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
    const blown = await page.evaluate(() => window.check.run());
    assert.deepEqual(blown.errors, []);
    console.log(
      'blown sand clock',
      blown.sand?.time,
      'expected',
      blown.sand?.expected,
      'particles',
      blown.sand?.particles,
    );
    assert.ok(blown.sand, 'the blown sand is in the scene once ready settles');
    assert.equal(blown.sand.time, blown.sand.expected, 'the sand clock counts the time before it loaded');
    assert.ok(blown.sand.particles > 0, `the sand draws: ${blown.sand.particles} particles`);
    await page.goto(
      `http://127.0.0.1:${port}/packages/scenes/test/dune-coast-still.html?view=crest&w=${w}&h=${h}&frames=2`,
    );
    await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
    assert.equal((await page.evaluate(() => window.check.run())).sand, null, 'no sand by default');
    // KB-SCENES-GRASS1: the grass shows. The camp view with grass and with grass=0 differs on the near ground where the
    // clumps stand (the old rules drew no blade in any view).
    const still = async (query) => {
      await page.goto(
        `http://127.0.0.1:${port}/packages/scenes/test/dune-coast-still.html?view=camp-buildings&w=${w}&h=${h}&${query}`,
      );
      await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
      assert.deepEqual((await page.evaluate(() => window.check.run())).errors, []);
      return decodePNG(await page.locator('canvas').screenshot());
    };
    const bare = await still('grass=0'),
      grassy = await still('grass=0.5');
    let changed = 0,
      total = 0;
    for (let y = Math.floor(h * 0.55); y < h; y++)
      for (let x = 0; x < w; x++, total++) {
        const i = (y * w + x) * 4;
        if (Math.abs(bare.data[i] - grassy.data[i]) + Math.abs(bare.data[i + 2] - grassy.data[i + 2]) > 24) changed++;
      }
    console.log('grass covers', ((100 * changed) / total).toFixed(1), 'percent of the near ground');
    assert.ok(changed / total > 0.03, `the grass shows: ${changed} of ${total} near-ground pixels`);
    // The sky light is shut out where it cannot reach: with the default occlusion the camp view (the sheds' eaves and
    // ends, the grass where it meets the sand) is darker than with occlusion=0, which lit a shed's inside and a model's
    // foot as fully as the open sand (the camp stills of 2026-11-17).
    await page.goto(
      `http://127.0.0.1:${port}/packages/scenes/test/dune-coast-still.html?view=camp-buildings&w=${w}&h=${h}&grass=0.5`,
    );
    await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
    assert.equal((await page.evaluate(() => window.check.run())).post[0], 'gtao', 'the occlusion pass runs first');
    const open = await still('occlusion=0'),
      luminance = (img) => {
        let sum = 0;
        for (let i = 0; i < img.data.length; i += 4) sum += img.data[i] + img.data[i + 1] + img.data[i + 2];
        return sum / (img.data.length / 4) / 3;
      },
      shut = luminance(grassy),
      lit = luminance(open);
    let darker = 0;
    for (let i = 0; i < open.data.length; i += 4)
      if (
        open.data[i] + open.data[i + 1] + open.data[i + 2] - grassy.data[i] - grassy.data[i + 1] - grassy.data[i + 2] >
        24
      )
        darker++;
    console.log(
      'occlusion: mean',
      shut.toFixed(1),
      'against',
      lit.toFixed(1),
      'open;',
      ((100 * darker * 4) / open.data.length).toFixed(1),
      'percent of pixels darker',
    );
    assert.ok(lit - shut > 2, `the occluded camp view is darker: mean ${shut.toFixed(1)} against ${lit.toFixed(1)}`);
    assert.ok(darker / (open.data.length / 4) > 0.05, `occlusion darkens the eaves and grass feet: ${darker} pixels`);
    assert.deepEqual(pageErrors, []);
    console.log('dune coast still check passed');
  }
} finally {
  await context.close();
}
