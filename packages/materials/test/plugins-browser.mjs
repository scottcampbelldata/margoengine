// Real-GPU checks of material plugins (plugins.html draws, this judges the bytes), on WebGPU and then on the WebGL2
// compatibility layer. Run from the repository root after `npm run build:packages`:
//   node packages/materials/test/plugins-browser.mjs            (both backends)
//   MARGO_COMPAT=1 node packages/materials/test/plugins-browser.mjs   (the compatibility layer only)
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

const near = (a, b, label, tolerance = 1) =>
  assert.ok(
    a.every((v, k) => Math.abs(v - b[k]) <= tolerance),
    `${label}: ${a} should be ${b}`,
  );
for (const compat of compatRun() ? [true] : [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/materials/test/plugins.html', port: 'free', compat }),
    { page } = browser,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
  const check = (name, ...args) => page.evaluate(([n, a]) => window.check[n](...a), [name, args]);
  const leg = compat ? 'compat' : 'webgpu';
  try {
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    const output = await check('output');
    console.log(leg, 'output', JSON.stringify(output));
    assert.deepEqual(output.errors, []);
    near(output.first, [51, 153, 255], 'output writes the plugin colour');
    near(output.live, [255, 0, 0], 'a live uniform reaches the next frame');
    near(output.ordered, [128, 0, 0], 'paint then halve');
    near(output.swapped, [255, 0, 0], 'halve then paint');
    assert.ok(output.removed[1] > 0 && output.removed[2] > 0, 'removing the plugins brings the material back');
    near(output.textured, [0, 255, 0], 'a plugin texture reads at its own binding block');
    near(output.swappedTexture, [0, 0, 255], 'a texture swapped live');

    const surface = await check('surface');
    console.log(leg, 'surface', JSON.stringify(surface));
    assert.deepEqual(surface.errors, []);
    near(surface.plugged, surface.plain, 'a plugin base colour lights as the material colour');
    assert.ok(surface.plugged[0] > 40, `the surface is lit: ${surface.plugged}`);
    assert.ok(
      surface.lifted[0] > surface.plugged[0] + 10,
      `light adds radiance: ${surface.lifted} > ${surface.plugged}`,
    );

    for (const instanced of [false, true]) {
      const vertex = await check('vertex', instanced);
      console.log(leg, 'vertex', instanced ? 'instanced' : 'plain', JSON.stringify(vertex));
      assert.deepEqual(vertex.errors, []);
      near(vertex.moved.centre, [5, 6, 9], 'the moved quad leaves the centre (the default clear colour)', 3);
      near(vertex.moved.there, [255, 255, 255], 'the moved quad draws at x = 1.5');
      near(vertex.back.centre, [255, 255, 255], 'dx = 0 puts it back');
      near(vertex.back.there, [5, 6, 9], 'and leaves x = 1.5', 3);
    }

    const still = await check('shadow', false),
      moved = await check('shadow', true);
    console.log(leg, 'shadow', JSON.stringify({ still, moved }));
    assert.deepEqual([...still.errors, ...moved.errors], []);
    assert.ok(still.open[0] > 60, `open wall is lit: ${still.open}`);
    assert.ok(still.atZero[0] < 10, `the unmoved caster shades x = 0: ${still.atZero}`);
    assert.ok(moved.atZero[0] > 60, `the moved caster no longer shades x = 0: ${moved.atZero}`);
    assert.ok(moved.atOne[0] < 10, `the moved caster shades x = 1: ${moved.atOne}`);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
}
console.log(
  'Material plugins: output, order, live uniforms, textures, surface, light, vertex (plain, instanced) and shadows passed.',
);
