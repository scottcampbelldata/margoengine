// KB1942c part 12: a grafted index (a reference to a deeper prim, composed alone) leaves out a class node whose site the
// index it joins already holds; the class arcs implied from that node go with it. Each stage in
// `fixtures/held-class-implied.json` is ours, written for this from black-box probes; its specs are marked by
// `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core from PyPI, run where
// it lives, its source never read) gave for the marked stage. What the stages pin, by name:
// - held: `/P` references `l0.usda`, whose `/M` inherits `/C`, so `/P/a` holds `l0.usda /C/a`; `/P/a` also references
//   `l1.usda</M/a>`, where `/M` references `l0.usda` and the inherit implies `l1.usda /C`. The graft leaves out its
//   `l0.usda /C/a` and with it the implied `l1.usda /C/a`: `/P/a` has no spec of `l1.usda`.
// - other-layer: the same with `l1.usda` referencing a copy of `l0.usda`: nothing is held, `l1.usda /C/a` stays.
// - r1942-21: stress stage 21 of seed 1942, reduced with a black-box reducer: the held site comes in through a variant
//   and two layers of references.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/held-class-implied.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`implied class arc of a held site in a graft ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
