// KB1942c: a specializes arc authored on the root of a grafted index (a reference to a deeper prim, composed alone)
// whose site the index already holds through an inherit of the same stack. Each stage in
// `fixtures/held-specializes-grafts.json` is ours, written for this from black-box probes; its specs are marked by
// `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core from PyPI, run where
// it lives, its source never read) gave for the marked stage. What the stages pin, by name:
// - s7, s5k, s10, s11, s12: `/Q` references `l0.usda</X/S>`, which specializes `/K`, and an `l0.usda` prim that
//   inherits `/K` (directly, under `/X`, or through another layer's prim, in either order). The specializes arc leaves
//   an inert placeholder that still implies its arc upward, so `root.usda /K` comes last, as a specializes; the
//   inherit implies nothing there.
// - r7-29: stress stage 29 of seed 7, reduced with a black-box reducer: the specializes arc is authored in a variant
//   inside the graft, not on its root, so its placeholder there carries the arc and the inherit's implied arc stands.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/held-specializes-grafts.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`held specializes in a graft ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
