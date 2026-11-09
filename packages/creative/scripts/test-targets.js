import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
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
