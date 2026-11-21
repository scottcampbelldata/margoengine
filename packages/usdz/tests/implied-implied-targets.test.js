// KB1942c part 25: relationship targets through a class arc implied from another implied class arc. Each stage in
// `fixtures/implied-implied-targets.json` is ours, reduced from stress stage 114 of seed 1942 with a black-box reducer,
// and the expected targets are the ones OpenUSD 26.11 (usd-core from PyPI, run where it lives, its source never read)
// printed. `l1.usda /M` specializes (or inherits) `/C`; `l2.usda /M` payloads (or references) `l1.usda</M>`, so the
// arc is implied into `l2.usda` as `/C` to `/M`; `root.usda /P/c` references `l2.usda</M/a>`, which carries that implied
// arc down to `/M/a` and implies it again into the root stack. The arc implied into the root stack keeps the implied
// arc's own pair, `/C` to `/M`, as KB1942b keeps an authored arc's: `/C/z` maps to `/M/z` and an authored `/M/...`
// target, which would not map back to itself, drops. With the reference on `/M` itself (`at-referenced-prim`) the
// implied arc is authored on the prim, there is no ancestor's pair to keep, and every target stays.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';

const encoder = new TextEncoder();
const stages = JSON.parse(await readFile(new URL('./fixtures/implied-implied-targets.json', import.meta.url), 'utf8'));

for (const [name, { files, want }] of Object.entries(stages))
  test(`targets through a class arc implied from an implied arc map as OpenUSD maps them: ${name}`, async () => {
    const { specs } = await composeUSDFiles('root.usda', (id) => {
      const text = files[id.replace(/^\.\//, '')];
      return text === undefined ? undefined : encoder.encode(text);
    });
    for (const [path, targets] of Object.entries(want))
      assert.deepEqual(specs[path]?.fields.targetPaths ?? [], targets, `${name} ${path}`);
  });
