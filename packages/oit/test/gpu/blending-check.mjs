// Real-GPU check for OIT's `blending` option: additive, multiply and transmissive surfaces against the formula, against
// the sorted path, and in any order. Takes a GPU slot itself. From the repository root, after building packages:
// node packages/oit/test/gpu/blending-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const release = await acquire({ owner: 'oit-blending' });
const context = await openBrowser({ startPath: '/packages/oit/test/gpu/blending.html', port: 5287 }),
  { page } = context;
const biggest = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
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
    const counts = await page.evaluate((options) => window.check.build(options), o);
    const url = await page.evaluate(() => window.check.shot());
    return Object.assign(await decodePNG(Buffer.from(url.split(',')[1], 'base64')), { counts });
  };
  const at = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
  const centre = (image) => at(image, image.width / 2, image.height / 2);
  const report = {};
  for (const samples of [1, 4]) {
    // Alone, each kind must match what the sorted path draws.
    for (const name of ['additive', 'multiply', 'glass', 'tinted-glass', 'mapped-glass']) {
      const sorted = await build({ samples, layers: [name], mode: 'sorted' }),
        oit = await build({ samples, layers: [name] });
      report[name + samples] = { sorted: centre(sorted), oit: centre(oit) };
      assert.ok(oit.counts.taken > 0, `${name} went through the pass`);
      assert.ok(
        biggest(centre(sorted), at(sorted, 4, 4)) > 8,
        `${samples}x ${name}: the surface shows, got ${centre(sorted)} over ${at(sorted, 4, 4)}`,
      );
      // Sums and products in half floats: one rounding of the target on top of the 8-bit one.
      assert.ok(
        biggest(centre(sorted), centre(oit)) <= 2,
        `${samples}x ${name}: as the sorted path, ${centre(oit)} against ${centre(sorted)}`,
      );
    }
    // Together: the order of adding them changes nothing.
    const stack = ['additive', 'multiply', 'glass', 'normal'],
      one = await build({ samples, layers: stack });
    report['stack' + samples] = centre(one);
    const swapped = await build({ samples, layers: stack, addOrder: [3, 1, 0, 2] });
    let added = 0;
    for (let k = 0; k < one.data.length; k++) added = Math.max(added, Math.abs(one.data[k] - swapped.data[k]));
    report['added' + samples] = added;
    assert.equal(added, 0, `${samples}x: the order of adding changes nothing`);
    // Additive and multiply commute with each other: which of the two is nearer cannot matter.
    const a = await build({ samples, layers: ['additive', 'multiply'] }),
      b = await build({ samples, layers: ['multiply', 'additive'] }),
      wall = at(a, 4, 4),
      // The canvas holds encoded light and the blend works on it, as on the sorted path: colours count encoded.
      encoded = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055),
      formula = wall.map((v, i) => v * encoded([0.5, 0.8, 0.5][i]) + encoded([0.5, 0, 0][i]) * 0.5 * 255);
    report['commute' + samples] = { a: centre(a), b: centre(b), formula: formula.map(Math.round) };
    assert.ok(biggest(centre(a), centre(b)) <= 1, `${samples}x: depth order of light and dimming does not matter`);
    assert.ok(biggest(centre(a), formula) <= 2.5, `${samples}x: wall times dim plus light, ${centre(a)}, ${formula}`);
  }
  // Without the option every one of them stays on the sorted path.
  {
    const off = await build({ samples: 1, layers: ['additive', 'multiply', 'glass'], off: true });
    assert.equal(off.counts.taken, 0, 'the default takes none of them');
  }
  // A transparent canvas stays valid: dimming keeps alpha, light and normal layers add it.
  {
    const image = await build({ samples: 1, layers: ['normal', 'additive'], transparent: true }),
      alpha = image.data[((image.height / 2) * image.width + image.width / 2) * 4 + 3] / 255;
    report.alpha = alpha;
    // 0.5 from the normal layer and 0.5 from the additive one.
    assert.ok(Math.abs(alpha - 1) <= 2 / 255, `alpha covers both layers, got ${alpha}`);
  }
  const errors = await page.evaluate(() => window.check.errors);
  console.log(JSON.stringify(report));
  assert.deepEqual(errors.concat(pageErrors), [], 'no GPU or shader errors');
  console.log('oit blending check passed');
} finally {
  await context.close();
  release();
}
