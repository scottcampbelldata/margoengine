// Real-GPU check for ExactOIT against sorted blending worked out by hand. Takes a GPU slot itself. From the repository
// root, after building packages: node packages/oit/test/gpu/exact-check.mjs
// Under MARGO_COMPAT=1 ExactOIT refuses by design (README "Exact (ExactOIT)": it needs storage buffers in fragment
// shaders, `setup` throws 'unsupported'; use OIT). The check then asserts that coded refusal at 1x and 4x, that core's
// sorted blending of the same four parallel layers still matches the hand-worked answer, and that the documented
// fallback, weighted OIT, draws the layers; the ExactOIT picture assertions are skipped with a printed note.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { compatRun } from '../../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../../tests/support/png.js';

const compat = compatRun(),
  release = await acquire({ owner: 'oit-exact' });
const context = await openBrowser({ startPath: '/packages/oit/test/gpu/exact.html', port: 5285 }),
  { page } = context;
const biggest = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
/** Each layer over `under`, far to near, in the value space the canvas holds. */
const over = (under, layers) =>
  layers.reduce((c, [color, alpha]) => c.map((v, i) => color[i] * alpha + v * (1 - alpha)), under);
try {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  await page
    .waitForFunction(() => window.ready, null, { timeout: 30000 })
    .catch((error) => {
      throw new Error(`the page did not start: ${pageErrors.join('; ') || error.message}`);
    });
  const shot = async () => {
    const url = await page.evaluate(() => window.check.shot());
    return decodePNG(Buffer.from(url.split(',')[1], 'base64'));
  };
  const at = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
  const build = async (o) => {
    await page.evaluate((options) => window.check.build(options), o);
    return shot();
  };
  const far = [
    [[1, 1, 0], 0.5],
    [[0, 0, 1], 0.6],
    [[0, 1, 0], 0.4],
    [[1, 0, 0], 0.5],
  ];
  const report = {};
  if (compat) {
    for (const samples of [1, 4]) {
      const error = await page.evaluate(
        (o) =>
          window.check.build(o).then(
            () => null,
            (e) => ({ code: e.code, message: e.message }),
          ),
        { samples },
      );
      report['refused' + samples] = error;
      assert.equal(
        error?.code,
        'unsupported',
        `compat ${samples}x: ExactOIT must refuse, got ${JSON.stringify(error)}`,
      );
      assert.match(error.message, /^ExactOIT needs storage buffers in fragment shaders; use OIT on this device/);
      // Core's own sorted blending: these planes do not cut each other, so it is the hand-worked answer.
      const image = await build({ samples, mode: 'sorted' }),
        size = image.width,
        wanted = over(
          at(image, 4, 4),
          far.map(([color, alpha]) => [color.map((v) => v * 255), alpha]),
        ),
        got = at(image, size / 2, size / 2);
      report['sorted' + samples] = { got, wanted: wanted.map(Math.round) };
      assert.ok(biggest(got, wanted) <= 2.5, `compat ${samples}x: core's sorted blend, got ${got}, wanted ${wanted}`);
      // The documented fallback draws the layers (an approximation, so only that it covers the wall is asserted).
      const weighted = await build({ samples, mode: 'weighted' });
      report['weighted' + samples] = at(weighted, size / 2, size / 2);
      assert.ok(
        biggest(at(weighted, size / 2, size / 2), at(weighted, 4, 4)) > 40,
        `compat ${samples}x: weighted OIT draws the layers, ${at(weighted, size / 2, size / 2)}`,
      );
    }
    console.log('compat: ExactOIT refuses with the coded unsupported; the ExactOIT picture assertions skipped');
  } else
    for (const samples of [1, 4]) {
      const image = await build({ samples }),
        size = image.width,
        wall = at(image, 4, 4);
      const wanted = over(
          wall,
          far.map(([color, alpha]) => [color.map((v) => v * 255), alpha]),
        ),
        got = at(image, size / 2, size / 2);
      // One 8-bit rounding per layer in the target, a half of one count each, four layers, plus the half-float colour.
      report['layers' + samples] = { got, wanted: wanted.map(Math.round), error: biggest(got, wanted) };
      assert.ok(biggest(got, wanted) <= 2.5, `${samples}x: four layers blend as sorted, got ${got}, wanted ${wanted}`);
      const other = await build({ samples, order: [3, 1, 0, 2] });
      let moved = 0;
      for (let k = 0; k < other.data.length; k++) moved = Math.max(moved, Math.abs(other.data[k] - image.data[k]));
      assert.equal(moved, 0, `${samples}x: the order of adding changes nothing`);
      const two = await build({ samples, layers: 2 }),
        nearest = over(
          wall,
          far.slice(2).map(([color, alpha]) => [color.map((v) => v * 255), alpha]),
        );
      assert.ok(biggest(at(two, size / 2, size / 2), nearest) <= 1.5, `${samples}x: layers: 2 keeps the nearest two`);
      const blocked = await build({ samples, blocker: true }),
        white = [255, 255, 255];
      const front = over(
        white,
        far.slice(2).map(([color, alpha]) => [color.map((v) => v * 255), alpha]),
      );
      report['blocked' + samples] = { got: at(blocked, size / 2, size / 2), wanted: front.map(Math.round) };
      assert.ok(
        biggest(at(blocked, size / 2, size / 2), front) <= 1.5,
        `${samples}x: layers behind an opaque plane stay hidden, got ${at(blocked, size / 2, size / 2)}, wanted ${front}`,
      );
      const crossed = await build({ samples, tilted: true }),
        left = at(crossed, size / 2 - 24, size / 2),
        right = at(crossed, size / 2 + 24, size / 2);
      report['crossed' + samples] = { left, right };
      // Red turns its left side forward, blue its right: each is the nearer on that half.
      const halves = [
        over(wall, [
          [[0, 0, 255], 0.5],
          [[255, 0, 0], 0.5],
        ]),
        over(wall, [
          [[255, 0, 0], 0.5],
          [[0, 0, 255], 0.5],
        ]),
      ];
      assert.ok(
        biggest(left, halves[0]) <= 1.5 && biggest(right, halves[1]) <= 1.5,
        `${samples}x: crossing sheets swap at the line, got ${left} and ${right}, wanted ${halves}`,
      );
    }
  // Weighted blending on the same four layers is why this entry exists: its error is the approximation.
  if (!compat) {
    const image = await build({ samples: 1, mode: 'weighted' }),
      wanted = over(
        at(image, 4, 4),
        far.map(([color, alpha]) => [color.map((v) => v * 255), alpha]),
      );
    report.weightedError = biggest(at(image, image.width / 2, image.width / 2), wanted);
    assert.ok(
      report.weightedError > report.layers1.error * 3,
      `weighted is the rougher of the two, ${report.weightedError}`,
    );
  }
  // Inside a PostStack the pass draws into the captured HDR target and its depth. The planes do not cut each other, so
  // sorted blending is right here and the two must agree.
  if (!compat) {
    const sorted = await build({ samples: 1, mode: 'sorted', post: true }),
      exact = await build({ samples: 1, post: true }),
      size = sorted.width,
      [a, b] = [at(sorted, size / 2, size / 2), at(exact, size / 2, size / 2)];
    report.post = { sorted: a, exact: b };
    assert.ok(biggest(a, b) <= 1, `a PostStack changes nothing, got ${b} against ${a}`);
  }
  // MSAA: a sloped edge against the wall holds in-between values, not just the two sides.
  if (!compat) {
    const edge = await build({ samples: 4, tilted: true }),
      seen = new Set();
    const y = edge.height / 2;
    for (let x = 0; x < edge.width; x++) seen.add(at(edge, x, y).join());
    report.edgeValues = seen.size;
    const hard = await build({ samples: 1, tilted: true }),
      flat = new Set();
    for (let x = 0; x < hard.width; x++) flat.add(at(hard, x, y).join());
    report.edgeValuesFlat = flat.size;
    assert.ok(seen.size > flat.size, `MSAA keeps partly covered edge pixels, ${seen.size} against ${flat.size}`);
  }
  // A list too short for the scene grows, and the picture then equals one that started big enough.
  if (!compat) {
    const wide = await build({ samples: 1, pool: 8 });
    await page.evaluate(() => window.check.build({ samples: 1, pool: 0.01 }));
    const before = await page.evaluate(() => window.check.settle().then(() => window.check.stats()));
    report.grown = before;
    const grown = await shot();
    let moved = 0;
    for (let k = 0; k < grown.data.length; k++) moved = Math.max(moved, Math.abs(grown.data[k] - wide.data[k]));
    assert.ok(before.capacity > before.fragments, `the list grew past the scene, got ${JSON.stringify(before)}`);
    assert.equal(before.dropped, 0, 'nothing is dropped once grown');
    assert.equal(moved, 0, 'a grown list draws what a big one draws');
    // Four 1.6 m planes at most, seen from 4 m: the count is the pixels they cover, at least one full plane.
    assert.ok(before.fragments > 256 * 256 * 0.1, `fragments counted, got ${before.fragments}`);
  }
  // A transparent canvas keeps valid premultiplied alpha.
  if (!compat) {
    const image = await build({ samples: 1, transparent: true }),
      size = image.width,
      alpha = image.data[((size / 2) * size + size / 2) * 4 + 3] / 255,
      wanted = 1 - 0.5 * 0.6 * 0.4 * 0.5;
    report.alpha = alpha;
    assert.ok(Math.abs(alpha - wanted) <= 2 / 255, `recovered alpha ${alpha}, wanted ${wanted}`);
  }
  const errors = await page.evaluate(() => window.check.errors);
  console.log(JSON.stringify(report));
  assert.deepEqual(errors.concat(pageErrors), [], 'no GPU or shader errors');
  console.log('oit exact check passed');
} finally {
  await context.close();
  release();
}
