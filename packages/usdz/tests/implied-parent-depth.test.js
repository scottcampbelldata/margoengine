// KB1942c part 29: the namespace depth of a class arc implied below the index root. Each stage in
// `fixtures/implied-parent-depth.json` is ours; its specs are marked by `prim-stack-marks.js`, and the order of each
// prim's specs there is what OpenUSD 26.11 (usd-core from PyPI, run where it lives, its source never read) gave for the
// marked stage. What the stages pin, by name:
// - stage51 (stage 51 of seed 7, reduced with a black-box reducer): `root.usda /R/a` selects `vs = "x"`, whose `c`
//   selects `vs = "x"`, whose `b` payloads `l2.usda</M/a>`; `l2.usda /M/a` inherits `/C` and references `l0.usda`,
//   whose `/M` inherits `/C/a`. The inherit implied into `l2.usda` hangs from the payload's `/M/a` and counts its depth,
//   2, not the stage prim's, 4, so it ties with the authored `l2.usda /C` and comes after it: at `/R/a/c/b` `l2.usda /C`
//   comes before `l2.usda /C/a`, and at `/R/a/c/b/c` `l2.usda /C/c` (754) beats `l2.usda /C/a/c` (512). Margo gave the
//   reverse.
// - no-variant: the payload on `/R/a/c/b` with no variants on the way; payload-in-l2: `l2.usda /M/a` payloads
//   `l0.usda` instead; shallow: the payload on `/R` (depth 1), where both counts agree.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/implied-parent-depth.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`a class arc implied below the index root counts its parent node's depth, ${name}: every prim's specs come in OpenUSD's order`, async () => {
    const marked = markStage(files);
    const { specs } = await composeUSDFiles('root.usda', (id) => {
      const text = marked[id.replace(/^\.\//, '')];
      return text === undefined ? undefined : encoder.encode(text);
    });
    for (const [path, order] of Object.entries(prims)) {
      const values = {};
      for (const key in specs)
        if (key.startsWith(path + '.o') && !key.slice(path.length + 1).includes('.'))
          values[key.slice(path.length + 1)] = specs[key].fields.default;
      assert.deepEqual(stackOrder(values), order, `${name} ${path}`);
    }
  });
}
