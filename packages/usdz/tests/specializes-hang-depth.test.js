// KB1942c part 21: the order of a specializes family's implied arcs on one side of the arc implied into the root
// stack. Each stage in `fixtures/specializes-hang-depth.json` is ours, reduced from a stress stage; its specs are marked
// by `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core from PyPI, run
// where it lives, its source never read) gave for the marked stage. What the stages pin, by name:
// - chain: `l0.usda /M/c/a` specializes `/C/a` and is reached through `l1.usda` (a node of namespace depth 3) and then
//   `l2.usda` (depth 4) below a variant of the root stack. The arc implied into `l1.usda` hangs from the shallower
//   node, so at `/P/a/a/b/c/c/c/a` `l1.usda /C/a` comes before `l2.usda /C/a`, though `l2.usda` is the stronger stack.
// - tie: the nodes the implied arcs hang from have one depth, so the stronger stack's arc comes first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/specializes-hang-depth.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`a specializes family's implied arcs order by the depth of the node each hangs from ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
