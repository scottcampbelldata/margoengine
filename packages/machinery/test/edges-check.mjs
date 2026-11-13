// Real-adapter check for FeatureEdges (run from the repository root after building packages): node packages/machinery/test/edges-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/machinery/test/edges-check.html', port: 5213 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const magenta = ([r, g, b]) => r > 170 && g < 110 && b > 170;
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  for (const name of ['plain', 'perspective', 'ortho', 'section', 'exploded', 'hidden', 'tiny']) {
    const result = await page.evaluate((n) => window.check.run(n), name),
      image = await decodePNG(await page.locator('canvas').screenshot());
    // Darkest-to-magenta pixel in a 3x3 window around each projected edge midpoint (lines are 3 px wide, MSAA resolved).
    const at = ([x, y]) => {
      let best = null;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const o = ((y + dy) * image.width + x + dx) * 4,
            p = [...image.data.slice(o, o + 3)];
          if (!best || (magenta(p) && !magenta(best))) best = p;
        }
      return best;
    };
    const edges = result.edges.map(at),
      faces = result.faces.map(at);
    assert.deepEqual(result.errors, [], name);
    for (const face of faces) assert.ok(!magenta(face), `${name}: face pixel ${face} is edge-coloured`);
    if (name === 'tiny') {
      let count = 0;
      for (let i = 0; i < image.data.length; i += 4) if (magenta(image.data.subarray(i, i + 3))) count++;
      assert.equal(count, 0, 'parts under minRadius draw no edges');
    } else if (name === 'plain' || name === 'hidden')
      assert.ok(
        edges.every((p) => !magenta(p)),
        `${name}: unexpected edges ${JSON.stringify(edges)}`,
      );
    else if (name === 'section') {
      assert.ok(
        magenta(edges[1]) && magenta(edges[2]) && magenta(edges[4]),
        `${name}: kept edges ${JSON.stringify(edges)}`,
      );
      assert.ok(!magenta(edges[3]), `${name}: clipped edge drawn ${edges[3]}`);
    } else assert.ok(edges.every(magenta), `${name}: edges ${JSON.stringify(edges)}`);
    console.log('ok', name, JSON.stringify(edges));
  }
  assert.deepEqual(pageErrors, []);
  console.log('feature edges browser check passed');
} finally {
  await context.close();
}
