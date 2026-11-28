// Real-GPU proof (run from the repository root after building packages):
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
const make = async (grass, lit = false, extra = undefined) => {
  const { commands, errors } = await page.evaluate(([g, l, x]) => window.check.make(g, l, x), [grass, lit, extra]);
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
      if (lit) {
        // 4. Cured blades (film look, 2026-11-28): with every blade dry the lit meadow turns from green to straw, red
        //    over green rising toward the measured cured-grass albedo; the shader compiles with a tussock too.
        const green = await make({ dry: 0, tussock: 0.9 }, true),
          straw = await make({ dry: 1, tussock: 0.9 }, true),
          hue = (image) => {
            let r = 0,
              g = 0;
            for (let p = 0; p < image.data.length; p += 4)
              if ([0, 1, 2].some((k) => image.data[p + k] !== empty.data[p + k])) {
                r += image.data[p];
                g += image.data[p + 1];
              }
            return r / g;
          };
        results.dry = { green: hue(green.image), straw: hue(straw.image) };
        assert.ok(covered(green.image, empty) > 5000, 'a tussock meadow draws');
        assert.ok(results.dry.straw > results.dry.green + 0.15, `dry blades redden: ${JSON.stringify(results.dry)}`);
        // 5. Plants round 1: tips that die back and leaves that yellow redden the meadow, each on its own, and a hue
        //    spread compiles and draws (the blades vary leaf to leaf).
        const plain = { dry: 0, yellow: 0, tipBrown: 0, hue: 0 },
          tips = await make({ ...plain, tipBrown: 1 }, true),
          yellowing = await make({ ...plain, yellow: 1 }, true),
          base = await make(plain, true),
          turned = await make({ ...plain, hue: 0.5 }, true);
        results.leaves = {
          base: hue(base.image),
          tips: hue(tips.image),
          yellow: hue(yellowing.image),
          turned: hue(turned.image),
        };
        assert.ok(results.leaves.tips > results.leaves.base + 0.05, `brown tips redden: ${JSON.stringify(results.leaves)}`);
        assert.ok(results.leaves.yellow > results.leaves.base + 0.05, `yellow leaves: ${JSON.stringify(results.leaves)}`);
        assert.ok(Math.abs(results.leaves.turned - results.leaves.base) > 0.02, `hue turns: ${JSON.stringify(results.leaves)}`);
      }
      // 6. Clearings and clumps (plants round 1): instances thin around a boulder to none at its centre and gather in
      //    patches; the counts come from the distribute pass, so they hold on both shaders.
      const total = rings((await make({}, lit)).commands).reduce((a, b) => a + b),
        count = async (extra) => rings((await make({}, lit, extra)).commands).reduce((a, b) => a + b),
        cleared = await count({ clearings: [{ center: [0, 0], radius: 2, falloff: 2 }] }),
        bare = await count({ clearings: [{ center: [0, 0], radius: 20 }] }),
        none = await count({ clumps: { size: 3, cover: 0 } }),
        half = await count({ clumps: { size: 3, cover: 0.5 } }),
        all = await count({ clumps: { size: 3, cover: 1, edge: 0.01 } });
      results[lit ? 'pbrCounts' : 'counts'] = { total, cleared, bare, none, half, all };
      // A 2 m bare circle and a 2 m ring at half density out of a 14 m square hold about 0.064 + 0.096 of it.
      assert.ok(cleared < total && cleared > 0.7 * total, `clearing thins: ${cleared} of ${total}`);
      assert.equal(bare, 0, 'a clearing over the whole meadow keeps nothing');
      assert.equal(none, 0, 'cover 0 keeps nothing');
      assert.equal(all, total, 'cover 1 keeps everything');
      assert.ok(half > 0.2 * total && half < 0.8 * total, `cover 0.5 keeps ${half} of ${total}`);
    }
    assert.deepEqual(pageErrors, []);
    console.log('ok scatter grass', JSON.stringify(results));
  },
  () => context.close(),
);
watchExit();
