// KB1942c part 19: how the implied arcs of a specializes family rank against the arc implied into the root stack. Each
// stage in `fixtures/specializes-root-rank.json` is ours, reduced from a stress stage; its specs are marked by
// `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core from PyPI, run where
// it lives, its source never read) gave for the marked stage. What the stages pin, by name:
// - shallower-implied: `/P/a/c` payloads `l2.usda`, whose `/M/b` payloads `l1.usda`; `l1.usda /M/c/c` inherits `/C`
//   and payloads `l0.usda</M>`, and `l0.usda /M/a` specializes `/C`. The arc implied into `l1.usda` hangs from a node
//   of namespace depth 2, shallower than the `l2.usda` payload (depth 3) that root `/C` is implied from, so at
//   `/P/a/c/b/c/c/a` it ranks first: `l1.usda /C`, root `/C`, then `l2.usda /C` and `l0.usda /C`.
// - no-variant: a family whose implied arc is the one root `/C` is implied from: root `/C` stays first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/specializes-root-rank.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`an implied specializes arc ranks against the root stack's by namespace depth ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
