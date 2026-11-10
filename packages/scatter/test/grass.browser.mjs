// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
//   node packages/scatter/test/grass.browser.mjs
// @margoengine/scatter/grass builds every blade in the vertex stage from a mesh of (side, along, blade number):
// 1. Both shaders (diffuse and PBR) compile and draw with no validation error, and blades cover the meadow.
// 2. The blades come from the GPU: 16 blades a clump cover far more pixels than 1, on the very same instances (the
//    distribute pass and its ring counts are unchanged by the shape).
// 3. Height is the shader's: blades twice as tall cover more of the frame.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/scatter/test/grass.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const make = async (grass, lit = false) => {
  const { commands, errors } = await page.evaluate(([g, l]) => window.check.make(g, l), [grass, lit]);
  assert.deepEqual(errors, [], JSON.stringify({ grass, lit }));
  const png = await page.locator('canvas').screenshot();
  return { commands, png, image: await decodePNG(png) };
};
// Pixels that differ from the empty frame in any channel.
const covered = (image, empty) => {
  let n = 0;
  for (let p = 0; p < image.data.length; p += 4)
    if ([0, 1, 2].some((k) => image.data[p + k] !== empty.data[p + k])) n++;
  return n;
};
// Instance counts are word 1 of each ring's five-word indexed command.
const rings = (c) => [c[1], c[6], c[11]];

await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const empty = (await make(null)).image;
    const results = {};
    for (const lit of [false, true]) {
      const meadow = await make({}, lit);
      if (lit) await writeFile('test-results/batch64-grass.png', meadow.png);
      const one = await make({ blades: 1 }, lit),
        many = await make({ blades: 16 }, lit),
        tall = await make({ blades: 1, height: 1.2 }, lit);
      assert.deepEqual(rings(one.commands), rings(many.commands), 'the shape leaves the instances as they were');
      assert.ok(rings(one.commands).reduce((a, b) => a + b) > 500, `${rings(one.commands)} instances drawn`);
      const c = {
        meadow: covered(meadow.image, empty),
        one: covered(one.image, empty),
        many: covered(many.image, empty),
        tall: covered(tall.image, empty),
      };
      assert.ok(c.meadow > 5000, `default meadow covers ${c.meadow} pixels`);
      assert.ok(c.many > 3 * c.one, `16 blades a clump (${c.many}) cover over 3 times 1 blade (${c.one})`);
      assert.ok(c.tall > 1.3 * c.one, `blades twice as tall (${c.tall}) cover more than ${c.one}`);
      results[lit ? 'pbr' : 'diffuse'] = c;
    }
    assert.deepEqual(pageErrors, []);
    console.log('ok scatter grass', JSON.stringify(results));
  },
  () => context.close(),
);
watchExit();
