// Real-GPU check for MomentOIT against sorted blending worked out by hand and against weighted blending on the same
// scene. Takes a GPU slot itself. From the repository root, after building packages:
// node packages/oit/test/gpu/moments-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const release = await acquire({ owner: 'oit-moments' });
const context = await openBrowser({ startPath: '/packages/oit/test/gpu/exact.html', port: 5286 }),
  { page } = context;
const biggest = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const over = (under, layers) =>
  layers.reduce((c, [color, alpha]) => c.map((v, i) => color[i] * 255 * alpha + v * (1 - alpha)), under);
try {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 }).catch((error) => {
    throw new Error(`the page did not start: ${pageErrors.join('; ') || error.message}`);
  });
  const build = async (o) => {
    await page.evaluate((options) => window.check.build(options), o);
    const url = await page.evaluate(() => window.check.shot());
    return decodePNG(Buffer.from(url.split(',')[1], 'base64'));
  };
  const at = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
  const centre = (image) => at(image, image.width / 2, image.height / 2);
  // Far to near, as exact.js places them.
  const four = [
    [[1, 1, 0], 0.5],
    [[0, 0, 1], 0.6],
    [[0, 1, 0], 0.4],
    [[1, 0, 0], 0.5],
  ];
  const dense = [
    [[0, 1, 0], 0.9],
    [[1, 0, 0], 0.9],
  ];
  const report = {};
  for (const samples of [1, 4]) {
    const moment = await build({ samples, mode: 'moment' }),
      weighted = await build({ samples, mode: 'weighted' }),
      wall = at(moment, 4, 4),
      wanted = over(wall, four);
    const [m, w] = [biggest(centre(moment), wanted), biggest(centre(weighted), wanted)];
    report['four' + samples] = { moment: centre(moment), weighted: centre(weighted), wanted: wanted.map(Math.round), m, w };
    assert.ok(m < w / 2, `${samples}x: four layers land nearer the sorted result than weighted, ${m} against ${w}`);
    const other = await build({ samples, mode: 'moment', order: [3, 1, 0, 2] });
    let moved = 0;
    for (let k = 0; k < other.data.length; k++) moved = Math.max(moved, Math.abs(other.data[k] - moment.data[k]));
    report['moved' + samples] = moved;
    // Half-float sums round in the order they arrive: at most one step of the last bit, a few counts after the bound.
    assert.ok(moved <= 3, `${samples}x: the order of adding moves a pixel by ${moved}`);
    // Near a solid layer the far one should be all but gone; weighted blending cannot hide it.
    const hidden = await build({ samples, mode: 'moment', dense: true }),
      mixed = await build({ samples, mode: 'weighted', dense: true }),
      near = over(wall, dense);
    const [a, b] = [biggest(centre(hidden), near), biggest(centre(mixed), near)];
    report['dense' + samples] = { moment: centre(hidden), weighted: centre(mixed), wanted: near.map(Math.round), a, b };
    assert.ok(a < b / 2, `${samples}x: a dense near layer hides a far one, ${a} against ${b}`);
    const one = await build({ samples, mode: 'moment', order: [2] }),
      single = over(wall, [four[1]]);
    report['one' + samples] = { got: centre(one), wanted: single.map(Math.round) };
    // One layer has no neighbour to confuse: the only loss is halves and the bias.
    assert.ok(biggest(centre(one), single) <= 1.5, `${samples}x: one layer is exact, got ${centre(one)}`);
    const blocked = await build({ samples, mode: 'moment', blocker: true }),
      white = over([255, 255, 255], four.slice(2));
    report['blocked' + samples] = { got: centre(blocked), wanted: white.map(Math.round) };
    assert.ok(biggest(centre(blocked), white) <= 20, `${samples}x: layers behind an opaque plane stay out`);
  }
  // A range around the planes is at least as good as the default around the camera target.
  {
    const tight = await build({ samples: 1, mode: 'moment', depthRange: [3, 6] }),
      wanted = over(at(tight, 4, 4), four);
    report.tight = biggest(centre(tight), wanted);
    assert.ok(report.tight <= report.four1.m + 1, `depthRange holds its accuracy, ${report.tight}`);
  }
  // Models moved far from where they were measured lose depth order until `fit` measures them again.
  {
    const image = await build({ samples: 1, mode: 'moment' }),
      wanted = over(at(image, 4, 4), four),
      shot = async () =>
        decodePNG(Buffer.from((await page.evaluate(() => window.check.shot())).split(',')[1], 'base64'));
    await page.evaluate(() => window.check.shift(2.5));
    const stale = biggest(centre(await shot()), wanted);
    await page.evaluate(() => window.check.fit());
    const fitted = biggest(centre(await shot()), wanted);
    report.moved = { stale, fitted };
    assert.ok(fitted < stale / 2, `fit brings the order back, ${fitted} against ${stale}`);
  }
  // Inside a PostStack the targets follow the captured HDR frame and one layer stays exact.
  {
    const sorted = await build({ samples: 1, mode: 'sorted', post: true, order: [2] }),
      moment = await build({ samples: 1, mode: 'moment', post: true, order: [2] });
    report.post = { sorted: centre(sorted), moment: centre(moment) };
    assert.ok(biggest(centre(sorted), centre(moment)) <= 1.5, `a PostStack changes nothing, ${report.post}`);
  }
  // A transparent canvas keeps valid alpha: coverage comes from the optical depth.
  {
    const image = await build({ samples: 1, mode: 'moment', transparent: true }),
      size = image.width,
      alpha = image.data[((size / 2) * size + size / 2) * 4 + 3] / 255,
      wanted = 1 - 0.5 * 0.6 * 0.4 * 0.5;
    report.alpha = alpha;
    assert.ok(Math.abs(alpha - wanted) <= 2 / 255, `recovered alpha ${alpha}, wanted ${wanted}`);
  }
  const errors = await page.evaluate(() => window.check.errors);
  console.log(JSON.stringify(report));
  assert.deepEqual(errors.concat(pageErrors), [], 'no GPU or shader errors');
  console.log('oit moments check passed');
} finally {
  await context.close();
  release();
}
