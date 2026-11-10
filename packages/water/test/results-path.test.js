import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// Regression: query.browser.mjs rewrote the tracked docs/whitepaper/results record on every GPU run, so each landing's
// tree came out dirty. Browser checks write their runs under test-results/; recorded evidence is committed by hand.
test('water browser checks never write into tracked docs', async () => {
  const dir = new URL('./', import.meta.url);
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.browser.mjs'))) {
    const source = await readFile(new URL(name, dir), 'utf8');
    assert.doesNotMatch(source, /(writeFile|mkdir)\(\s*[`'"]docs\//, `${name} writes into docs/`);
  }
});
