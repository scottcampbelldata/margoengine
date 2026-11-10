import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';
console.log('area-shapes: opening browser');
const browser = await openBrowser({ startPath: '/tests/clustered-shadow.html', port: 'free' });
try {
  const page = browser.page;
  await page.waitForFunction(() => window.clusteredShadowFixture);
  console.log('area-shapes: fixture ready');
  const call = (name, ...args) => page.evaluate(({ name, args }) => window.clusteredShadowFixture[name](...args), { name, args });
  const points = [[0, 0, 0, 0, 1, 0], [3, 0, 0, 0, 1, 0]];
  const results = [];
  for (const shape of ['disc', 'sphere']) {
    console.log(`area-shapes: ${shape} unshadowed`);
    const light = { shape, position: [0, 3, 0], direction: [0, -1, 0], radius: 0.25, intensity: 5 };
    await call('scene', { meshes: ['floor', 'block'], shapes: [light] });
    await call('render', 2);
    console.log(`area-shapes: ${shape} unshadowed render complete`);
    const off = await call('probe', points);
    console.log(`area-shapes: ${shape} shadowed`);
    await call('scene', { meshes: ['floor', 'block'], shapes: [{ ...light, castShadow: true }] });
    await call('render', 2);
    const on = await call('probe', points), compiled = await call('compile');
    assert.deepEqual(compiled, { core: [], probe: [] });
    assert.ok(off[0][0] > 0 && on[0][0] < off[0][0] * 0.05, `${shape}: blocked centre`);
    assert.ok(Math.abs(on[1][0] / off[1][0] - 1) < 0.02, `${shape}: clear receiver`);
    results.push({ shape, visibility: on.map((v, i) => v[0] / off[i][0]) });
  }
  assert.deepEqual(await page.evaluate(() => window.clusteredShadowFixture.errors), []);
  console.log(JSON.stringify(results));
} finally { await browser.close(); }
