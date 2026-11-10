// Regression (R5): test:browser:global runs from packages/lightmap, but its page imports /packages/core/dist and
// /tests/modern-extension.html from the repository root. global-browser.mjs did not change directory, so the dev
// server rooted at packages/lightmap failed every module fetch before any GPU work, on both backends.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('every lightmap browser check that opens the shared dev server serves it from the repository root', () => {
  const here = new URL('./', import.meta.url),
    missing = readdirSync(here)
      .filter((name) => name.endsWith('.mjs'))
      .filter((name) => {
        const code = readFileSync(new URL(name, here), 'utf8');
        return (
          code.includes('openBrowser(') &&
          !code.includes("process.chdir(fileURLToPath(new URL('../../../', import.meta.url)))")
        );
      });
  assert.deepEqual(missing, []);
});
