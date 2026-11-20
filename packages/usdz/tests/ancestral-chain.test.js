// KB1942c part 14: the ancestral variants of an implied inherit that stands for another implied arc, the chain ending in
// an arc carried down from an ancestor. Each stage in `fixtures/ancestral-chain.json` is ours, written for this from
// black-box probes; its specs are marked by `prim-stack-marks.js`, and the order of each prim's specs there is what
// OpenUSD 26.11 (usd-core from PyPI, run where it lives, its source never read) gave for the marked stage. What the
// stages pin, by name:
// - chain: `l0.usda /M` inherits `/C`; `l1.usda /M` references `l0.usda</M>` and payloads `l0.usda</M/a>` inside a
//   variant of `/M/b/c`; `l2.usda /M/b` references `l1.usda` and `/Q/b/a` payloads `l2.usda`. `l2.usda /C` selects
//   `vs = "y"`, so `/Q/b/a/b/b/c/b` gets `root.usda /C{vs=y}a` on its implied inherit of `root.usda /C/a`.
// - chain-l1-selects, chain-l0-selects: the selection on `/C` in `l1.usda` or in `l0.usda` instead does the same.
// - no-selection: with none, no variant.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/ancestral-chain.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`ancestral variants of a chain of implied inherits ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
