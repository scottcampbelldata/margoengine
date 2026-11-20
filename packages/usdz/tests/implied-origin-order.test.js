// KB1942c part 22: two implied class arcs on one node, of one kind and namespace depth, rank as the arcs they were
// implied from do. Each stage in `fixtures/implied-origin-order.json` is ours, reduced from a stress stage; its specs are
// marked by `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core from PyPI,
// run where it lives, its source never read) gave for the marked stage. What the stages pin, by name:
// - origin: `/P/b/c` payloads `l2.usda</M/a>`; `l2.usda /M` inherits `/C` and payloads `l1.usda`, whose `/M/a`
//   inherits `/C`. Root `/C` is implied from `l2.usda /C`, which ranks before the ancestral `l2.usda /C/a` that root
//   `/C/a` is implied from, so root `/C` comes first though it was made later.
// - through: root `/C/a` is implied from an inherit below a variant of the same stack as the payload it passes, where
//   it ranks as the placeholder it leaves there would: before the payload's own reference, so root `/C/a` comes first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/implied-origin-order.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`implied class arcs on one node rank as the arcs they were implied from ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
