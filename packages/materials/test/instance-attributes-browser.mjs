// Real-GPU checks of per-instance attributes (instance-attributes.html draws, this judges the bytes), on WebGPU and then
// on the WebGL2 compatibility layer. Run from the repository root after `npm run build:packages`:
//   node packages/materials/test/instance-attributes-browser.mjs            (both backends)
//   MARGO_COMPAT=1 node packages/materials/test/instance-attributes-browser.mjs   (the compatibility layer only)
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

const near = (a, b, label, tolerance = 1) =>
  assert.ok(
    a.every((v, k) => Math.abs(v - b[k]) <= tolerance),
    `${label}: ${a} should be ${b}`,
  );
// The default clear colour.
const back = [5, 6, 9],
  red = [255, 0, 0],
  green = [0, 255, 0],
  blue = [0, 0, 255],
  yellow = [255, 255, 0],
  cyan = [0, 255, 255],
  magenta = [255, 0, 255];
const row = (actual, expected, label) => expected.forEach((colour, k) => near(actual[k], colour, `${label} [${k}]`, 3));
for (const compat of compatRun() ? [true] : [false, true]) {
  const browser = await openBrowser({
      startPath: '/packages/materials/test/instance-attributes.html',
      port: 'free',
      compat,
    }),
    { page } = browser,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
  const leg = compat ? 'compat' : 'webgpu';
  const check = async (name, argument) => {
    const out = await page.evaluate(([n, a]) => window.check[n](a), [name, argument]);
    console.log(leg, name, argument ?? '', JSON.stringify(out));
    assert.deepEqual(out.errors, [], name);
    return out;
  };
  try {
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    const c = await check('colours');
    row(c.first, [red, green, blue], 'each instance reads its row; past the capacity the defaults');
    row(c.single, [red, yellow, blue], 'a single set');
    row(c.bulk, [yellow, red, blue], 'a bulk buffer swaps the places');
    row(c.inPlace, [yellow, cyan, blue], 'an in-place edit and update');
    row(c.reset, [yellow, blue, blue], 'a reset');
    row(c.restored, [yellow, blue, blue], 'a restored device draws the same');
    row(c.afterRestore, [magenta, blue, blue], 'and takes edits');
    row(c.two, [[0, 0, 0], blue, blue], 'a second plugin reads its own attributes (instance 1 stands at -1.5)');
    row(c.again, [magenta, blue, blue], 'a plugin taken off and put back');

    const t = await check('types');
    row(
      t.out,
      [
        [0, 0, 0],
        [153, 204, 102],
        [0, 255, 0],
      ],
      'every type reads its floats of its row',
    );

    const p = await check('plain');
    row(p.out, [red, red, red], 'plain meshes read row 0');

    const k = await check('culled');
    row(k.out, [green, back, blue], 'a culler and a sorter keep the rows in place');

    for (const virtual of [false, true]) {
      const { first, moved } = await check('shadow', virtual),
        map = virtual ? 'virtual' : 'cascaded';
      assert.ok(first.open[0] > 60, `${map}: open wall is lit: ${first.open}`);
      assert.ok(first.zero[0] < 20, `${map}: instance 0 shades x = 0: ${first.zero}`);
      assert.ok(first.left[0] < 20, `${map}: instance 1 shades x = -1.5: ${first.left}`);
      assert.ok(first.one[0] > 60, `${map}: x = 1 is lit: ${first.one}`);
      assert.ok(moved.zero[0] > 60, `${map}: instance 0 moved off x = 0: ${moved.zero}`);
      assert.ok(moved.one[0] < 20, `${map}: and shades x = 1: ${moved.one}`);
      assert.ok(moved.left[0] < 20, `${map}: instance 1 stays: ${moved.left}`);
    }

    const l = await check('local');
    assert.ok(l.first.open[0] > 30, `the spot lights the wall: ${l.first.open}`);
    assert.ok(l.first.near[0] < l.first.open[0] / 3, `the moved caster shades x = 0.2: ${l.first.near}`);
    assert.ok(l.first.far[0] > l.first.near[0] + 20, `and not x = 1.9: ${l.first.far}`);
    assert.ok(l.moved.near[0] > l.first.near[0] + 20, `moved again, x = 0.2 is lit: ${l.moved.near}`);
    assert.ok(l.moved.far[0] < l.first.far[0] / 3, `and x = 1.9 is shaded: ${l.moved.far}`);

    const s = await check('picking');
    assert.deepEqual([s.there, s.centre, s.back, s.left], [true, false, true, false], 'picking follows the move');

    const v = await check('velocity');
    assert.ok(v.moved > 0, 'TAA compiled a velocity shader that loads the row');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
}
console.log(
  'Instance attributes: rows, types, bulk and in-place edits, restore, plain meshes, cullers, shadows, picking and velocity passed.',
);
