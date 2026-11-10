import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/voxel-edit/tests/generate-browser.html', port: 'free' });
try {
  await context.page.waitForFunction(() => typeof window.run === 'function', null, { timeout: 30000 });
  const result = await context.page.evaluate(() => window.run());
  assert.ok(result.filled > 0 && result.filled < result.total);
  for (const key of ['equal', 'contextEqual', 'budget', 'invalid', 'multiline', 'nonempty'])
    assert.equal(result[key], true, key);
  assert.equal(result.blank, 0);
  console.log('font-mask voxel generation passed', result);
} finally {
  await context.close();
}
