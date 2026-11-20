// KB1942c part 23: the namespace depth sibling class arcs below the index root rank by. Each stage in
// `fixtures/implied-reference-depth.json` is ours, reduced from a stress stage; its specs are marked by
// `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core from PyPI, run where
// it lives, its source never read) gave for the marked stage. What the stages pin, by name:
// - deeper: `/P` payloads `l1.usda</M/a>`, whose `/M/a` inherits `/C` and whose `/M/a/a` payloads `l0.usda</M>`,
//   which inherits `/C`. At `/P/a` the inherit implied into `l1.usda` counts from that payload's depth, 3, and comes
//   before the ancestral `l1.usda /C/a` (depth 2): `l1.usda /C` first.
// - authored: an inherit authored in a variant at `l1.usda /M/a/c{vs=y}b` counts from that prim's depth in its own
//   stack, so it keeps its place before the inherit implied there from under the variant's reference.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/implied-reference-depth.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`class arcs below the index root rank by the namespace depth they count from ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
