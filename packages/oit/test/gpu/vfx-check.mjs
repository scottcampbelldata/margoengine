// Real-GPU check for addEffect: particles, splats, points and sprites blend with glass in true depth order, whichever of
// them draws first. Takes a GPU slot itself. From the repository root, after building packages:
// node packages/oit/test/gpu/vfx-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const release = await acquire({ owner: 'oit-vfx' });
const context = await openBrowser({ startPath: '/packages/oit/test/gpu/vfx.html', port: 5289 }),
  { page } = context;
const biggest = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const kinds = ['vfx', 'splats', 'cloud', 'sprite'];
try {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 }).catch((error) => {
    throw new Error(`the page did not start: ${pageErrors.join('; ') || error.message}`);
  });
  const shot = async () => {
    const url = await page.evaluate(() => window.check.shot()),
      image = await decodePNG(Buffer.from(url.split(',')[1], 'base64')),
      at = (image.height / 2) * image.width * 4 + image.width * 2;
    return [...image.data.subarray(at, at + 3)];
  };
  const build = async (o) => {
    await page.evaluate((options) => window.check.build(options), o);
    return shot();
  };
  const report = {};
  // The view depth each route hands the pass, where weighted blending and moments use it: exact in float, up to rounding
  // of the camera maths at this distance.
  for (const kind of kinds)
    for (const orthographic of [false, true]) {
      await build({ samples: 1, kind, z: 0.5, probe: true, orthographic });
      const depth = await page.evaluate(() => window.check.depth());
      report[`depth ${kind}${orthographic ? ' orthographic' : ''}`] = depth;
      assert.ok(Math.abs(depth - 3.5) < 1e-3, `${kind}, orthographic ${orthographic}: view depth 3.5, got ${depth}`);
    }
  for (const samples of [1, 4]) {
    const wall = await build({ samples }),
      glass = await build({ samples, glass: true });
    for (const kind of kinds) {
      // What each layer leaves: glass of opacity 0.5 over the wall, and the effect alone.
      const alone = await build({ samples, kind }),
        front = await build({ samples, kind, z: 0.5, glass: true, mode: 'exact' }),
        behind = await build({ samples, kind, z: -0.5, glass: true, mode: 'exact' }),
        // The effect's coverage from its red channel, 1 in its colour.
        a = (alone[0] - wall[0]) / (255 - wall[0]),
        expectFront = glass.map((g, i) => [255, 0, 0][i] * a + g * (1 - a)),
        expectBehind = glass.map((g, i) => g + (alone[i] - wall[i]) * 0.5);
      report[`${kind} ${samples}x`] = { alone, front, behind };
      assert.ok(a > 0.5, `${samples}x ${kind} shows, coverage ${a}`);
      // Two 8-bit blends, each input read back in 8 bits and colours held in halves in the lists.
      assert.ok(biggest(front, expectFront) <= 2, `${samples}x ${kind} in front: ${front} against ${expectFront}`);
      assert.ok(biggest(behind, expectBehind) <= 2, `${samples}x ${kind} behind: ${behind} against ${expectBehind}`);
      // Their own draws cannot do it: behind the glass the effect still lands on top of it, or the glass on top of it.
      const plain = await build({ samples, kind, z: -0.5, glass: true }),
        planeFirst = await build({ samples, kind, z: 0.5, glass: true });
      report[`${kind} ${samples}x own`] = { behind: plain, front: planeFirst };
      assert.ok(
        biggest(plain, expectBehind) > 8 || biggest(planeFirst, expectFront) > 8,
        `${samples}x ${kind}: its own draw should miss one of the two orders, ${plain} and ${planeFirst}`,
      );
      // Taken away, or with the effect or pass gone, it draws as before, bit for bit.
      await build({ samples, kind, mode: 'exact' });
      await page.evaluate(() => window.check.remove());
      assert.deepEqual(await shot(), alone, `${samples}x ${kind}: the remover restores its own draw`);
      await build({ samples, kind, mode: 'oit' });
      await page.evaluate(() => window.check.disposePass());
      assert.deepEqual(await shot(), alone, `${samples}x ${kind}: disposing the pass restores its own draw`);
      await build({ samples, kind, z: 0.5, glass: true, mode: 'oit' });
      assert.equal(await page.evaluate(() => window.check.disposeEffect()), 0, `${kind}: a disposed effect leaves the pass`);
      assert.deepEqual(await shot(), await build({ samples, glass: true, mode: 'oit' }), `${samples}x ${kind}: only glass is left`);
      // Weighted blending and moments are approximations: coverage holds, and the nearer layer counts for more.
      for (const mode of ['oit', 'moments', 'ranged', 'blending']) {
        const near = await build({ samples, kind, z: 0.5, glass: true, mode }),
          far = await build({ samples, kind, z: -0.5, glass: true, mode });
        report[`${kind} ${samples}x ${mode}`] = { near, far };
        assert.ok(near[0] > far[0] && near[2] < far[2], `${samples}x ${kind} ${mode}: nearer counts for more, ${near}, ${far}`);
      }
    }
    // Alone in a pass an effect looks as it does on its own, whatever it brings: one layer, so one blend either way.
    for (const o of [
      { kind: 'vfx', fog: true },
      { kind: 'vfx', texture: true },
      { kind: 'vfx', soft: true },
      { kind: 'splats', fog: true },
      { kind: 'cloud', fog: true },
      { kind: 'cloud', sphere: true },
      { kind: 'sprite', fog: true },
    ]) {
      const own = await build({ samples, ...o });
      for (const mode of ['exact', 'oit', 'moments', 'ranged', 'blending']) {
        const taken = await build({ samples, ...o, mode });
        report[`${JSON.stringify(o)} ${samples}x ${mode}`] = { own, taken };
        // Exact keeps the colour in halves; the others also divide by the weights they summed in halves.
        assert.ok(biggest(own, taken) <= 2, `${samples}x ${JSON.stringify(o)} ${mode}: ${taken} against ${own}`);
      }
    }
    // Additive: `blending` takes it and adds; a pass without it leaves it to the plugin's own draw.
    for (const kind of ['cloud', 'sprite']) {
      const own = await build({ samples, kind, additive: true }),
        added = await build({ samples, kind, additive: true, mode: 'blending' }),
        left = await build({ samples, kind, additive: true, mode: 'exact' });
      report[`additive ${kind} ${samples}x`] = { own, added, left };
      assert.ok(biggest(own, wall) > 8, `${samples}x additive ${kind} shows`);
      assert.ok(biggest(own, added) <= 2, `${samples}x additive ${kind} in blending OIT: ${added} against ${own}`);
      assert.deepEqual(left, own, `${samples}x additive ${kind} stays out of a pass that takes no additive`);
    }
    // The draw order is the data order once the sort is off: it must not matter. Sums of two in halves commute.
    for (const mode of ['exact', 'oit', 'moments']) {
      const one = await build({ samples, kind: 'splats', pair: true, mode }),
        other = await build({ samples, kind: 'splats', pair: true, swapped: true, mode });
      report[`splat order ${samples}x ${mode}`] = { one, other };
      assert.deepEqual(one, other, `${samples}x ${mode}: the order of the data changes nothing`);
    }
    const sorted = await build({ samples, kind: 'splats', pair: true }),
      exact = await build({ samples, kind: 'splats', pair: true, mode: 'exact' });
    assert.ok(biggest(sorted, exact) <= 2, `${samples}x: exact equals the sorted splats, ${exact} against ${sorted}`);
  }
  const errors = await page.evaluate(() => window.check.errors);
  console.log(JSON.stringify(report));
  assert.deepEqual(errors.concat(pageErrors), [], 'no GPU or shader errors');
  console.log('oit vfx GPU check passed');
} finally {
  await context.close();
  release();
}
