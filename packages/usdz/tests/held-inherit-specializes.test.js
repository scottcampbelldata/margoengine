// KB1942c part 20: a grafted index whose inherit is left out, as the index it joins already holds the inherit's site,
// keeps the specializes arc to that same site that the inherit had shadowed, as an inert placeholder. Each stage in
// `fixtures/held-inherit-specializes.json` is ours, reduced from a stress stage; its specs are marked by
// `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core from PyPI, run where
// it lives, its source never read) gave for the marked stage. What the stages pin, by name:
// - held: `l0.usda /M` inherits and specializes `/C`. `/R/c` payloads `l1.usda</M>`, whose `/M/c` references
//   `l0.usda</M/a>`, so `l0.usda /C/a` is held by that reference's inherit when `/R/c/c`'s own payload of
//   `l0.usda</M/a>` is grafted. The graft's inherit is left out and its specializes placeholder implies root `/C/a` as a
//   specializes arc, the weakest: `l1.usda /M/c` and its variant `vs=x` come first, and root `/C/a` gives no `vs=y`.
// - free: the same stage without the reference: nothing is held, and the inherit keeps the site as before.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/held-inherit-specializes.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`a graft's held inherit leaves its prim's specializes placeholder ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
