import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/headless/tests/tiles-gpu.html', port: 5279 });
try {
  await context.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const result = await context.page.evaluate(() => window.capture('webgpu'));
  assert.deepEqual(result.errors, []);
  assert.equal(result.largest, 0, 'one-sample tiling matches a whole frame exactly');
  assert.equal(result.mean, 0);
  assert.ok(result.changed > 0, 'four samples change edge coverage');
  assert.equal(result.pixels, result.width * 3);
  assert.ok(result.maxTile <= 512);
  assert.deepEqual(result.restored, [131, 97]);
  assert.deepEqual(await context.page.evaluate(() => window.capture('webgl2')), { code: 'unsupported' });
  console.log('ok tiles: exact full-frame match, supersampling, real device limit exceeded, WebGL2 refusal', result);
  const compatibility = await context.page.evaluate(() => window.compatCapture());
  assert.deepEqual(compatibility.errors, []);
  assert.equal(compatibility.largest, 0);
  assert.equal(compatibility.mean, 0);
  assert.ok(compatibility.changed > 0);
  assert.equal(compatibility.pixels, compatibility.width * 3);
  assert.deepEqual(compatibility.restored, [131, 97]);
  console.log('ok tiles on full WebGL2 compatibility layer', compatibility);
} finally {
  await context.close();
}
