import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
// openBrowser serves process.cwd(); npm workspace scripts start in packages/creative.
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ port: 'free' });
try {
  const result = await browser.page.evaluate(async () => {
    const { targetChecks } = await import('/packages/creative/tests/targets-browser.js');
    return targetChecks();
  });
  assert.equal(result.subresources, 78);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
