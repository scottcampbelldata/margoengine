// KB1942c: how a prim index is built, pinned on small stages where reaching one site twice settles which arc keeps it.
// Each stage in `fixtures/prim-index-queue.json` is ours, written for this from black-box probes; its specs are marked by
// `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core from PyPI, run where
// it lives, its source never read) gave for the marked stage. What the stages pin, by name:
// - d1, d2, d4, d5, v1, v2, two-refs: an arc to a root prim is a bare node whose own arcs this index follows; one to a
//   deeper prim is that prim's index composed alone; the first live node made for a site holds it, so a later inherit to
//   it makes no node and a grafted index leaves out its class nodes on a held site.
// - g-flat-swap, t6, t7, t8, r37: references and payloads run before inherits, a higher kind of arc always first, and
//   nodes in the order they were queued; the nodes carried down from the parent prim keep the order they were made in.
// - e3, s1, s3, s5, s6, s1k, r57, mx-e0: a specializes arc below the index root leaves an inert placeholder where it was
//   authored and its node goes under the root, unless the site is held; the placeholder still implies its arc upward,
//   after every inherit.
// - r43, r7-29: a specializes node moved under the root ranks in its family from the placeholder it left, carried down
//   or grafted.
// - spec-chain: the class arcs of a moved specializes node are implied in the stack above, as the placeholder's.
// - q1942-8, q1942-26, q1942-132, q7-5, q7-20, q7-143: stress stages 8, 26 and 132 of seed 1942 and 5, 20 and 143 of
//   seed 7, reduced with a black-box reducer while Margo still differed before this change.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/prim-index-queue.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`prim index ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
