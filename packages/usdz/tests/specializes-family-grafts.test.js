// KB1942c (e): where each implied arc of one specializes family ranks against its authored arc: by the outermost
// reference or payload around the authored arc's node, counted up to the node the implied arc hangs from (that node,
// when it is the reference, counts from the prim that authored it). Each stage in
// `fixtures/specializes-family-grafts.json` is ours, written for this from black-box probes; its specs are marked by
// `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core from PyPI, run where
// it lives, its source never read) gave for the marked stage. What the stages pin, by name:
// - r86, r86-flat: stress stage 86 of seed 1942, reduced with a black-box reducer, and the same without its variant:
//   `l1.usda</M/a>` is grafted under a payload to `l2.usda</M>`, and `/M/a` there has an ancestral payload whose
//   `/M/a` specializes `/C/a`. The implied `l1.usda /C/a`, inside the graft, comes before the authored arc, as it
//   would in `l1.usda</M/a>` composed alone; the implied `l2.usda /C/a`, outside it, comes after.
// - g-payload, g-variant: stress stage 94, reduced, with the reference to `l2.usda</M/a>` moved under a payload to a
//   root prim (and that payload into a variant): the graft's own reference was authored on a prim no deeper than the
//   arc, so the implied arc inside it comes first.
// - g-root, g-depth1, r101: the guards. The graft's reference is authored deeper than the arc (stress stage 94 and 101,
//   reduced), or the whole stage is the graft: the implied arcs then keep the order the rule for the whole tree gives.
// - r16, r106: stress stages 16 and 106 of seed 1942, reduced. No graft at all: `l2.usda /C`, implied under a variant
//   of a payload whose own payload was authored in that variant, comes before the authored arc; `root.usda /C` after.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/specializes-family-grafts.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`specializes family in a graft ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
