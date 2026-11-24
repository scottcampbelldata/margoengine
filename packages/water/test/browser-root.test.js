// Regression: test:gpu runs from packages/water, but every browser check opens /tests/modern-game.html and writes
// results under the repository root. fft.browser.mjs and query.browser.mjs did not change directory, so the dev server
// rooted at packages/water answered their page with 404 and the GPU checks failed before any GPU work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

test('every water browser check serves the page from the repository root', () => {
  const here = new URL('./', import.meta.url),
    missing = readdirSync(here)
      .filter((name) => name.endsWith('.browser.mjs'))
      .filter(
        (name) =>
          !readFileSync(new URL(name, here), 'utf8').includes(
            "process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));",
          ),
      );
  assert.deepEqual(missing, []);
});
