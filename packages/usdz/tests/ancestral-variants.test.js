// KB1942c: which ancestral variants a class site keeps when it comes into a prim index from an ancestor's arc. Each stage
// in `fixtures/ancestral-variants.json` is ours, written for this from black-box probes; its specs are marked by
// `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core from PyPI, run where
// it lives, its source never read) gave for the marked stage. What the stages pin, by name:
// - r4, x4-res, x4-unres, b-anc-selM, spec-anc-selM: a specializes node carried down from an ancestor inside a
//   grafted index moves under the index root as its site composed alone, so a variant the referencing prim selected on
//   the class's ancestor is left out; only a selection on the class's own sites keeps it.
// - 139-base, 139-selM, 139-selC, 139-selB, 139-selQ, 139-spec-only, 139-nosub, nosub-selC: an implied class arc that
//   stands for an arc carried down from prim A takes its ancestral variants from A's index in the stack it joins (a
//   selection on that A, or on a class A inherits, counts; one on the prim being composed does not), and from the
//   class composed alone when that stack has no A.
// - r7-9, r7-38, r7-9b, r9: stress stages 9 and 38 of seed 7 and 9 of seed 1942, reduced with a black-box reducer while
//   an earlier form of these rules still differed: the node that stands for the same arc in A's index does not count,
//   and A taken as authored at the index root counts only when that stack holds the layer that authored the arc.
// - r5, r5-sel-x, r5-flat-y, r5-flat-x, sel-above, sel-below, sel-two-up, sel-between, r7-142, r48: below the index
//   root, A's selections are read at the site that authored the arc into the stack the implied arc joins, at the path A
//   maps to there (a selection on that prim's parent, child or the prim being composed does not count), then from the
//   nodes of other stacks in the index of the stage prim A maps to; r5, r7-142 and r48 are stress stages 5 and 48 of
//   seed 1942 and 142 of seed 7, reduced the same way.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/ancestral-variants.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`ancestral variants ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
