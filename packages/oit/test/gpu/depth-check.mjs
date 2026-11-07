// Real-GPU check for TransparentDepth: glass reaches the depth that TAA, depth of field and picking read. Takes a GPU slot
// itself. From the repository root, after building packages: node packages/oit/test/gpu/depth-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const release = await acquire({ owner: 'oit-depth' });
const context = await openBrowser({ startPath: '/packages/oit/test/gpu/depth.html', port: 5288 }),
  { page } = context;
try {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 }).catch((error) => {
    throw new Error(`the page did not start: ${pageErrors.join('; ') || error.message}`);
  });
  const build = (o) => page.evaluate((options) => window.check.build(options), o),
    depth = () => page.evaluate(() => window.check.depth());
  const report = {};
  for (const samples of [1, 4]) {
    await build({ samples, solid: true });
    const solid = await depth();
    await build({ samples });
    const without = await depth();
    await build({ samples, write: true });
    const written = await depth();
    await build({ samples, write: true, oit: true });
    const withOIT = await depth();
    await build({ samples, write: true, opacity: 0.05 });
    const faint = await depth();
    await build({ samples, write: true, opacity: 0.3, threshold: 0.5 });
    const below = await depth();
    report['depth' + samples] = { solid, without, written, withOIT, faint, below };
    assert.ok(solid > without, `${samples}x: the plane is nearer than the wall, ${solid} and ${without}`);
    assert.equal(written, solid, `${samples}x: glass writes the depth an opaque plane there would`);
    assert.equal(withOIT, solid, `${samples}x: the same under OIT`);
    assert.equal(faint, without, `${samples}x: below the default threshold it stays out`);
    assert.equal(below, without, `${samples}x: the threshold is honoured`);
  }
  // TAA: moving glass carries its motion only as a velocity source on written depth.
  {
    await build({ samples: 1, motion: true, oit: true });
    const plain = await page.evaluate(() => window.check.move(0.1));
    await build({ samples: 1, motion: true, oit: true, write: true });
    const moving = await page.evaluate(() => window.check.move(0.1));
    report.velocity = { plain, moving };
    assert.equal(Math.hypot(...plain), 0, `the wall behind glass does not move, got ${plain}`);
    // 0.1 m at 3 m from the eye, 2 tan(fov/2) of view height per metre of distance: well above a half-float step.
    assert.ok(Math.abs(moving[0]) > 0.005, `glass has its own motion, got ${moving}`);
    assert.ok(Math.abs(moving[1]) < Math.abs(moving[0]) / 50, `along x alone, got ${moving}`);
  }
  // Depth of field focused on the wall: the glass edge is out of focus only once the depth shows it.
  {
    const soft = async () => {
      const url = await page.evaluate(() => window.check.shot()),
        image = await decodePNG(Buffer.from(url.split(',')[1], 'base64')),
        row = image.height / 2,
        values = [];
      for (let x = 0; x < image.width; x++) values.push(image.data[(row * image.width + x) * 4]);
      const [lo, hi] = [Math.min(...values), Math.max(...values)];
      return values.filter((v) => v > lo + 0.1 * (hi - lo) && v < hi - 0.1 * (hi - lo)).length;
    };
    await build({ samples: 1, oit: true, dof: 0.2 });
    const sharp = await soft();
    await build({ samples: 1, oit: true, dof: 0.2, write: true });
    const blurred = await soft();
    report.dof = { sharp, blurred };
    assert.ok(blurred > sharp + 4, `the edge blurs once DOF sees it, ${blurred} against ${sharp} soft pixels`);
  }
  // Picking takes transparent primitives already, and still does.
  {
    await build({ samples: 1, oit: true, picking: true });
    assert.equal(await page.evaluate(() => window.check.pick()), true, 'a click lands on the glass');
  }
  const errors = await page.evaluate(() => window.check.errors);
  console.log(JSON.stringify(report));
  assert.deepEqual(errors.concat(pageErrors), [], 'no GPU or shader errors');
  console.log('oit depth check passed');
} finally {
  await context.close();
  release();
}
