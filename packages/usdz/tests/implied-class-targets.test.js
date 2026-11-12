// KB1942b: relationship targets reached through a class arc that an ancestor's inherit implies in the stage above. The
// specification does not say how such a path maps, so the rule was pinned black-box: each stage in the fixture is ours,
// composed by OpenUSD 26.11 (usd-core from PyPI, run where it lives, its source never read), and the expected targets
// are the ones OpenUSD printed. The implied arc keeps the ancestor's own pair, so /C/b maps to the ancestor's /M/b, and
// an authored /M/... target, which would not map back to itself, drops.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';

const encoder = new TextEncoder();
const stages = JSON.parse(await readFile(new URL('./fixtures/implied-class-targets.json', import.meta.url), 'utf8'));

test('targets through an implied class arc map as OpenUSD maps them, on 10 black-box stages', async () => {
  assert.equal(Object.keys(stages).length, 10);
  for (const [name, { files, want }] of Object.entries(stages)) {
    const { specs } = await composeUSDFiles('root.usda', (id) => (id in files ? encoder.encode(files[id]) : undefined));
    for (const [path, targets] of Object.entries(want))
      assert.deepEqual(specs[path]?.fields.targetPaths ?? [], targets, `${name} ${path}`);
  }
});
