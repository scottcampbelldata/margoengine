// Real-GPU regression test: a materials mesh with a base colour map or alphaMap and `alphaTest` casts the cut-out shape,
// not its whole quad, into every shadow pass (`Shadows`, `LocalShadows` spot and point, Clustered's integrated local
// maps). Without the fix each of those passes shaded the floor under the cut-out half.
// Run from the repository root after `npm run build:packages`: node packages/shadows/test/cutout-casters-browser.mjs
// `--cost` measures frame cost instead (exclusive GPU lock) and asserts nothing about it.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

// A point's light against the same floor with no caster: at or under SHADED counts as in shadow, at or over LIT as clear.
const SHADED = 0.6,
  LIT = 0.93;
const measuringCost = process.argv.includes('--cost');
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'shadows-cutout-casters', ...(measuringCost ? { mode: 'exclusive' } : {}) });
const context = await openBrowser({ startPath: '/packages/shadows/test/cutout-casters.html', port: 5268 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const linear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const shot = async (pass, caster, instanced) => {
  assert.deepEqual(await page.evaluate(([p, c, i]) => window.check.show(p, c, i), [pass, caster, instanced]), []);
  return decodePNG(await page.locator('canvas').screenshot());
};
// Mean linear luminance of a 9 x 9 patch around world point p.
const patch = async (image, p) => {
  const [cx, cy] = await page.evaluate((w) => window.check.pixel(w), p);
  let sum = 0;
  for (let y = cy - 4; y <= cy + 4; y++)
    for (let x = cx - 4; x <= cx + 4; x++) {
      const o = (y * image.width + x) * 4;
      sum += 0.2126 * linear(image.data[o]) + 0.7152 * linear(image.data[o + 1]) + 0.0722 * linear(image.data[o + 2]);
    }
  return sum / 81;
};
// Where each half of the quad (x -3 to -2 solid, -2 to -1 cut) lands on the floor, through its middle.
const directional = { solid: [-0.5, 0, 0], cut: [0.5, 0, 0] },
  local = { solid: [-0.75, 0, 0], cut: [0.75, 0, 0] },
  passes = { directional, virtual: directional, spot: local, point: local, integratedSpot: local, integratedPoint: local };
// Whether each half's floor point is in shadow, per caster.
const expected = {
  map: { solid: true, cut: false },
  opaque: { solid: true, cut: true },
  threshold: { solid: true, cut: false },
  above: { solid: false, cut: false },
  opacity: { solid: true, cut: false },
  transform: { solid: false, cut: true },
  alphaMap: { solid: true, cut: false },
  alphaOnly: { solid: true, cut: false },
  vertexOff: { solid: true, cut: true },
  vertexOn: { solid: false, cut: false },
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  if (measuringCost) {
    const result = [];
    for (const n of [50, 200])
      for (const kind of ['opaque', 'cutout', 'opaque', 'cutout']) {
        const row = await page.evaluate(([k, c]) => window.check.cost(k, c, 120), [kind, n]);
        assert.deepEqual(row.errors, []);
        result.push(row);
        console.log(JSON.stringify(row));
      }
    await writeFile('test-results/shadows-cutout-cost.json', JSON.stringify(result, null, 2));
  } else {
    const rows = [],
      failures = [];
    const run = async (pass, caster, instanced) => {
      const points = passes[pass],
        open = await shot(pass),
        lit = { solid: await patch(open, points.solid), cut: await patch(open, points.cut) },
        image = await shot(pass, caster, instanced),
        row = { pass, caster, instanced: !!instanced };
      for (const half of ['solid', 'cut']) {
        assert.ok(lit[half] > 0.02, `${pass}: the floor is unlit at ${half} (${lit[half]}), so nothing is measured`);
        const ratio = (row[half] = +((await patch(image, points[half])) / lit[half]).toFixed(3));
        if (expected[caster][half] ? ratio > SHADED : ratio < LIT)
          failures.push(`${pass} ${caster}${instanced ? ' instanced' : ''} ${half}: ${ratio} of its open light`);
      }
      rows.push(row);
      console.log(JSON.stringify(row));
    };
    for (const pass of Object.keys(passes)) for (const caster of Object.keys(expected)) await run(pass, caster);
    await run('directional', 'map', true);
    await run('directional', 'alphaMap', true);
    await run('directional', 'vertexOff', true);
    await run('spot', 'alphaMap', true);
    await run('integratedPoint', 'alphaMap', true);
    // Live edits redraw the cached map: no test casts the whole quad, the test again cuts it, a new map moves the cut.
    {
      const points = passes.directional,
        open = await shot('directional'),
        lit = { solid: await patch(open, points.solid), cut: await patch(open, points.cut) };
      await shot('directional', 'map');
      for (const [name, solid, cut] of [
        ['noTest', true, true],
        ['test', true, false],
        ['swap', false, true],
      ]) {
        assert.deepEqual(await page.evaluate((n) => window.check.edit(n), name), []);
        const image = await decodePNG(await page.locator('canvas').screenshot()),
          row = { pass: 'directional', caster: 'live', edit: name };
        for (const [half, shaded] of [
          ['solid', solid],
          ['cut', cut],
        ]) {
          const ratio = (row[half] = +((await patch(image, points[half])) / lit[half]).toFixed(3));
          if (shaded ? ratio > SHADED : ratio < LIT) failures.push(`live ${name} ${half}: ${ratio} of its open light`);
        }
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
    await writeFile('test-results/shadows-cutout-casters.json', JSON.stringify(rows, null, 2));
    assert.deepEqual(failures, []);
  }
  assert.deepEqual(pageErrors, []);
  console.log('shadows cut-out casters: ok');
} finally {
  await context.close?.();
  await release?.();
}
