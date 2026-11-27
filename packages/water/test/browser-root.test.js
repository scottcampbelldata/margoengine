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

test('the separately bounded Water GPU suites retain all browser cases', () => {
  const here = new URL('./', import.meta.url);
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', here), 'utf8'));
  const batches = Object.entries(scripts)
    .filter(([name]) => name === 'test:gpu' || name.startsWith('test:gpu:'))
    .map(([, script]) => script.split(' && ').filter((step) => step.startsWith('node test/')));
  const files = readdirSync(here)
    .filter((name) => name.endsWith('.browser.mjs'))
    .map((name) => `node test/${name}`);
  files.push(
    'node test/underwater.browser.mjs --single',
    'node test/wake-agreement.browser.mjs --lateral-course',
    'node test/wake-agreement.browser.mjs --panel-hull',
  );
  assert.deepEqual(batches.flat().sort(), files.sort());

  const batchOf = (file) => batches.findIndex((batch) => batch.includes(`node test/${file}.browser.mjs`));
  const longBatches = ['flood-film', 'caustics-scale', 'whitecap-coverage'].map(batchOf);
  assert.equal(new Set(longBatches).size, longBatches.length, 'long checks must have independent runner lifetimes');
});
