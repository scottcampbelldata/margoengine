import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ port: 'free' });
try {
  const result = await browser.page.evaluate(async () => {
    const { paintChecks } = await import('/packages/creative/tests/paint-browser.js');
    return paintChecks();
  });
  assert.ok(result.comparisons > 1000);
  assert.ok(result.shaders > 0);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
