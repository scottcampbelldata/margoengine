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

// Known bug it guards (docs/known-bugs.md, fixed 2026-11-11): query.browser.mjs named its WebGL2-layer result
// "webgpu" under MARGO_COMPAT=1, as it read the --compat argument instead of the browser's hardware record.
test('water browser checks name a result by the backend the browser ran, not by an argument', async () => {
  const dir = new URL('./', import.meta.url);
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.browser.mjs'))) {
    const source = await readFile(new URL(name, dir), 'utf8');
    assert.doesNotMatch(source, /test-results\/[^`'"]*\$\{process\.argv/, `${name} names a result from argv`);
    assert.doesNotMatch(source, /=\s*process\.argv\.includes\('--compat'\)\s*\?\s*'compat'/, `${name} names a backend from argv`);
  }
});
