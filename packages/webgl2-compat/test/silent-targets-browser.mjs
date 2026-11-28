// KB-COMPAT-SILENTTARGET1 (run by `npm run test:gpu`): a WebGPU pipeline may leave a colour target with write mask 0
// without a fragment output; WebGL2 (ANGLE) refused the draw ("Active draw buffers with missing fragment shader
// outputs", GL_INVALID_OPERATION) whatever the colour mask, so the layer reported an internal error and drew nothing.
// The layer turns such a target's draw buffer off for the pipeline's draws (silent-targets.html).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/silent-targets.html', port: 'free', compat: false });
const { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || /GL_INVALID/.test(m.text())) pageErrors.push(m.text());
});
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.check.run());
  console.log(JSON.stringify(r));
  assert.deepEqual(r.errors, [], 'no uncaptured GPU error');
  assert.equal(r.scoped, null, 'no validation error');
  assert.deepEqual(r.pixels[0], [0.5, 0.25, 1, 1], 'target 0 holds the fragment output');
  assert.deepEqual(r.pixels[1], [0, 0, 0, 0.75], 'a silent target keeps its clear');
  assert.deepEqual(r.pixels[2], [0, 0, 0, 0.75], 'a silent target keeps its clear');
  assert.ok(Math.abs(r.depth - 0.25) < 1e-6, `the draw wrote its depth: ${r.depth}`);
  assert.deepEqual(pageErrors, []);
  console.log('webgl2-compat: colour targets with write mask 0 and no fragment output draw');
} finally {
  await context.close();
}
