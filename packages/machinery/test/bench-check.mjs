// Real-adapter check for CadBench on WebGPU and the WebGL2 layer (from the repository root, packages built):
// node packages/machinery/test/bench-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/machinery/test/bench-check.html', port: 'free' }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const magenta = ([r, g, b]) => r > 170 && g < 110 && b > 170;
try {
  const base = page.url().split('?')[0];
  for (const backend of ['webgpu', 'webgl2']) {
    await page.goto(backend === 'webgl2' ? `${base}?backend=webgl2` : base);
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    const result = await page.evaluate(() => window.result),
      image = await decodePNG(await page.locator('canvas').screenshot());
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
    assert.deepEqual(result.errors, [], backend);
    assert.equal(result.compat, backend === 'webgl2', `${backend}: ran on the asked backend`);
    const edges = result.edges.map(at),
      faces = result.faces.map(at),
      deck = at(result.deck);
    assert.ok(edges.every(magenta), `${backend}: edges ${JSON.stringify(edges)}`);
    for (const face of faces) assert.ok(!magenta(face), `${backend}: face ${face} is edge-coloured`);
    // The deck is drawn (not the #203040 clear colour) and the anodised part is a metal.
    const clear = Math.abs(deck[0] - 0x20) + Math.abs(deck[1] - 0x30) + Math.abs(deck[2] - 0x40);
    assert.ok(clear > 6, `${backend}: deck ${deck}`);
    assert.equal(result.material[5], 1, 'metalness 1');
    console.log('ok', backend, JSON.stringify({ edges, faces, deck }));
  }
  assert.deepEqual(pageErrors, []);
  console.log('CAD bench browser check passed');
} finally {
  await context.close();
}
