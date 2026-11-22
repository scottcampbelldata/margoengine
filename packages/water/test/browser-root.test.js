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

test('the GPU gate runs every water browser check in a bounded group', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const runs = Object.entries(scripts)
    .filter(([name]) => /^test:gpu(?::|$)/.test(name))
    .flatMap(([name, script]) => {
      const commands = script.split(' && ').filter((command) => command !== 'npm run build');
      assert.ok(commands.length <= 17, `${name} has ${commands.length} checks in one ten-minute step`);
      return commands;
    });
  const expected = readdirSync(new URL('./', import.meta.url))
    .filter((name) => name.endsWith('.browser.mjs'))
    .map((name) => `node test/${name}`);
  expected.push('node test/underwater.browser.mjs --single');
  assert.deepEqual(runs.sort(), expected.sort());
});
