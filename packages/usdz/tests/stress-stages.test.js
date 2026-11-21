// KB1942c guard: the generated stress stages (`oracle/generate-stages.py`, built here by `stress-stages.js`, the same
// files byte for byte) composed by Margo against OpenUSD's reading of them. The expected readings in
// `fixtures/stress/openusd-<seed>.json.gz` are outputs of OpenUSD 26.11 (usd-core from PyPI, run as a black box, its
// source never read) on these stages, which are our own: `generate-stages.py out 150 <seed>`, then `truth.py list
// truth.json prims` under plain Python, then `oracle/stress-fixture.mjs truth.json openusd-<seed>.json.gz`.
// The stages listed below still differ (docs/known-bugs.md, KB1942c). The lists may only shrink: a stage that matches
// OpenUSD today and differs after a change fails here, and so does a listed stage that now matches, until it leaves the
// list.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { composeUSDFiles } from '../dist/compose.js';
import { differences } from './openusd-differences.js';
import { stressStages } from './stress-stages.js';

/** Stages known to differ from OpenUSD, by seed; 142 of seed 1942 does not open in OpenUSD, so it has no answer. */
const known = {
  1942: [9, 25, 48],
  7: [51, 68],
};
const refused = { 1942: [142], 7: [] };

const encoder = new TextEncoder();
for (const seed of [1942, 7]) {
  test(`stress stages of seed ${seed} compose as OpenUSD does, but for the known list`, async () => {
    const truth = JSON.parse(
      gunzipSync(readFileSync(new URL(`./fixtures/stress/openusd-${seed}.json.gz`, import.meta.url))).toString('utf8'),
    );
    const stages = stressStages(150, seed);
    const differ = [];
    const errors = [];
    const detail = {};
    for (const [index, files] of stages.entries()) {
      const want = truth[index];
      if (want.error) {
        errors.push(index);
        continue;
      }
      const reader = (id) =>
        files[id.replace(/^\.\//, '')] === undefined ? undefined : encoder.encode(files[id.replace(/^\.\//, '')]);
      let found;
      try {
        found = differences((await composeUSDFiles('root.usda', reader)).specs, want);
      } catch (error) {
        found = [`threw ${error.message}`];
      }
      if (found.length) {
        differ.push(index);
        detail[index] = found.slice(0, 3);
      }
    }
    assert.deepEqual(errors, refused[seed], 'the stages OpenUSD could not open');
    const fresh = differ.filter((index) => !known[seed].includes(index));
    assert.deepEqual(
      fresh,
      [],
      `stages that matched OpenUSD now differ: ${JSON.stringify(Object.fromEntries(fresh.map((i) => [i, detail[i]])))}`,
    );
    const fixed = known[seed].filter((index) => !differ.includes(index));
    assert.deepEqual(fixed, [], 'stages on the known list now match OpenUSD: take them off the list');
  });
}
