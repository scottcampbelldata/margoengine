// Real-GPU check of the bevel mesh, high texture layers, maps, four simultaneous views, live lightmaps and the bevel's
// post replay, shadows and AO.
// Run from the repository root after `npm run build:packages`, one GPU job at a time:
//   node scripts/gpu-lock.mjs run --owner=voxel-render -- node packages/voxel/tests/bevel-browser-check.mjs
// Source-string tests do not replace this. A machine without navigator.gpu cannot pass it.
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel/tests/bevel-browser-check.html',
  port = 5227,
  context = await openBrowser({ startPath: path, port }),
  { page, hardware } = context,
  pageErrors = [],
  report = { hardware, results: {} };
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const fail = (label, detail) => {
  throw new Error(`${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  if (!hardware.webgpu || hardware.webgpu.fallback) fail('physical WebGPU adapter required', hardware.webgpu);
  for (const samples of [4, 1]) {
    await page.goto(`http://127.0.0.1:${port}${path}${samples === 1 ? '?samples=1' : ''}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
    const result = await page.evaluate(() => window.check.run());
    report.results[`${samples}x`] = result;
    assert.equal(result.samples, samples);
    assert.deepEqual(result.errors, [], `${samples}x WebGPU errors`);
    assert.ok(result.bevel.centerRed, `${samples}x bevel center ${JSON.stringify(result.bevel)}`);
    assert.ok(result.bevel.translatedRed, `${samples}x translated bevel ${JSON.stringify(result.bevel)}`);
    assert.ok(
      result.bevel.lit < result.hard.lit,
      `${samples}x bevel silhouette ${result.bevel.lit} is not inside the hard cube ${result.hard.lit}`,
    );
    assert.ok(result.bevel.lit > result.hard.lit * 0.4, `${samples}x bevel drew too little`);
    assert.ok(result.layers.blue, `${samples}x layer 256 ${JSON.stringify(result.layers)}`);
    assert.ok(result.layers.green, `${samples}x layer 2047 ${JSON.stringify(result.layers)}`);
    assert.ok(result.maps.dimmer, `${samples}x emissive map ${JSON.stringify(result.maps)}`);
    assert.ok(result.metal.bright, `${samples}x metal specular ${JSON.stringify(result.metal)}`);
    assert.ok(
      result.metal.rough[0] + 20 < result.metal.pixel[0],
      `${samples}x high-layer roughness map ${JSON.stringify(result.metal)}`,
    );
    assert.ok(
      result.metal.normal[0] + 20 < result.metal.pixel[0],
      `${samples}x high-layer normal map ${JSON.stringify(result.metal)}`,
    );
    assert.ok(result.glass.single, `${samples}x glass duplicate ${JSON.stringify(result.glass)}`);
    for (const name of ['red', 'green', 'blue', 'white'])
      assert.ok(result.views[name], `${samples}x four-view ${name} ${JSON.stringify(result.views)}`);
    const near = (actual, expected, label) =>
      assert.ok(
        actual.length === expected.length &&
          actual.every((value, i) => Number.isFinite(value) && Math.abs(value - expected[i]) <= 0.003),
        `${samples}x ${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
      );
    for (const [bevel, composite] of Object.entries(result.composites)) {
      near(composite.glass, [0.36, 0, 0.64], `bevel ${bevel} glass over red`);
      near(composite.cutout, [0, 1, 0], `bevel ${bevel} cutout center`);
      near(composite.border, [1, 0, 0], `bevel ${bevel} cutout border`);
      near(composite.invisible, [1, 0, 0], `bevel ${bevel} zero alpha transmits red`);
    }
    for (const [label, order] of [
      ['same chunk', result.order],
      ['separate chunks', result.chunkOrder],
      ['glass and lowered liquid', result.mixedOrder],
    ]) {
      for (let i = 0; i < 3; i++) {
        const back = order.background.map((value) => value * 0.1296);
        near(
          order.pixels[i],
          [back[0], back[1] + (i === 1 ? 0.2304 : 0.64), back[2] + (i === 1 ? 0.64 : 0.2304)],
          `${label} sorted glass view ${i}`,
        );
      }
    }
    for (const [i, liquid] of result.liquid.entries()) {
      near(liquid.center, liquid.background, `liquid mode ${i} lowered top leaves upper ray empty`);
      assert.ok(
        liquid.below[2] > 0.6 && liquid.below[0] < 0.1,
        `${samples}x liquid mode ${i} lower body ${liquid.below}`,
      );
    }
    near(result.liquid[1].below, result.liquid[0].below, 'bevel preserves liquid drop');
    console.log(
      `ok ${samples}x bevel, layers, maps, metal, HDR composites and sorting, cutout, liquid drop, four views`,
    );
    const gaps = await page.evaluate(() => window.check.gaps());
    report.results[`${samples}x gaps`] = gaps;
    assert.deepEqual(gaps.errors, [], `${samples}x WebGPU errors in the lightmap and replay checks`);
    assert.ok(
      gaps.cutout.center[2] > 0.9 && gaps.cutout.above.every((v) => Math.abs(v) < 0.01),
      'cutout post replay alpha-tests the material',
    );
    assert.ok(
      gaps.cutout.shadowPixels > 1000 && gaps.cutout.shadowPixels < gaps.bevel.shadowPixels * 0.5,
      'cutout shadow tests the texture',
    );
    assert.ok(
      gaps.liquid.center[2] > 0.9 && gaps.liquid.above.every((v) => Math.abs(v) < 0.01),
      'post replay keeps the lowered liquid',
    );
    assert.equal(gaps.liquid.shadowPixels, 0, 'translucent liquid casts no shadow');
    assert.equal(gaps.partial.quads, 6, 'two cells merge to one face');
    assert.ok(gaps.partial.mapped[1] > 0.99 && gaps.partial.mapped[0] < 0.001, 'partial greedy face mapped');
    assert.ok(
      gaps.partial.unmapped.every((v) => Math.abs(v) < 0.0001),
      'uncharted part keeps live light',
    );
    assert.equal(gaps.large.charts, 32768);
    assert.ok(gaps.large.red > 1000 && gaps.large.blue > 1000, '32768 visible chart surfaces sampled');
    assert.ok(gaps.large.atlasMs < 250, 'bounded large atlas GPU frame');
    for (const map of gaps.lightmap) {
      assert.ok(map.left[0] > 0.9 && map.left[2] < 0.1, 'red atlas chart sampled');
      assert.ok(map.right[2] > 1.8 && map.right[0] < 0.1, 'blue atlas chart sampled with HDR scale');
      assert.ok(map.swapped[2] > 1.8 && map.swapped[0] < 0.1, 'texture upload changes sampled output');
      assert.ok(
        map.cleared.every((v) => Math.abs(v - (map.hooks ? 0.3 : 0)) < 0.001),
        'clearing restores live lighting',
      );
    }
    assert.ok(
      gaps.bevel.covered < gaps.hard.covered * 0.95 && gaps.bevel.covered > gaps.hard.covered * 0.4,
      'gbuffer follows the chamfer silhouette',
    );
    assert.ok(gaps.bevel.slopes > 100, 'gbuffer holds sloped bevel normals');
    assert.ok(
      gaps.bevel.shadowPixels < gaps.hard.shadowPixels * 0.99 && gaps.bevel.shadowPixels > gaps.hard.shadowPixels * 0.4,
      'shadow follows the chamfer silhouette',
    );
    for (const pixels of [gaps.ao, gaps.seam]) {
      assert.ok(pixels[0][0] < pixels[1][0] * 0.9, 'concave corner AO');
      assert.ok(pixels[2][0] < pixels[3][0] * 0.9, 'AO across the chunk seam');
    }
    for (let i = 0; i < 4; i++)
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(gaps.ao[i][c] - gaps.seam[i][c]) < 0.02, 'chunk seam keeps AO');
    console.log(`ok ${samples}x lightmaps, bevel replay, shadows and AO`);
  }
  assert.deepEqual(pageErrors, []);
} finally {
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/voxel-bevel-browser-check.json', JSON.stringify(report, null, 1));
  await context.close();
}
console.log('voxel bevel browser check passed');
