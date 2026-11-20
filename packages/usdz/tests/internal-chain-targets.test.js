// KB1942c: relationship targets authored on a prim reached through a chain of internal arcs (an internal reference or a
// class arc under another). The specification does not say how such a path maps, so the rule was pinned black-box: each
// stage in the fixture is ours, composed by OpenUSD 26.11 (usd-core from PyPI, run where it lives, its source never
// read), and the expected targets are the ones OpenUSD printed. OpenUSD maps a target once through the chain's composed
// map function, not arc by arc: /M/a authored on /Shared drops on /M (it would map back to /Shared/a) but stays /M/a on
// /Y, which references /M, while /Y/c, which /Y's own pair shadows, drops there.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';

const encoder = new TextEncoder();
const stages = JSON.parse(await readFile(new URL('./fixtures/internal-chain-targets.json', import.meta.url), 'utf8'));

test('targets through a chain of internal arcs map as OpenUSD maps them, on 10 black-box stages', async () => {
  assert.equal(Object.keys(stages).length, 10);
  for (const [name, { files, want }] of Object.entries(stages)) {
    const { specs } = await composeUSDFiles('root.usda', (id) => (id in files ? encoder.encode(files[id]) : undefined));
    for (const [path, targets] of Object.entries(want))
      assert.deepEqual(specs[path]?.fields.targetPaths ?? [], targets, `${name} ${path}`);
  }
});
