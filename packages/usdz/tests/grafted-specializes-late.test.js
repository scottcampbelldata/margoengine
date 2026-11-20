// KB1942c part 17: a specializes arc that a graft carries in moves under the index root after the index's own
// specializes arcs. Each stage in `fixtures/grafted-specializes-late.json` is ours, reduced from a stress stage; its
// specs are marked by `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core
// from PyPI, run where it lives, its source never read) gave for the marked stage. What the stages pin, by name:
// - ancestral-payload: `/Q/c` payloads `l2.usda</M>` and `/Q/c/a` references `l2.usda</M/a>`, so two nodes stand for
//   `l2.usda /M/a`: the reference (stronger, a graft of that prim's own index) and the payload carried down from `/Q/c`.
//   Each has a payload to `l0.usda /M`, which specializes `/C`. The payload's specializes arc holds the site under the
//   root, so the implied arcs come from it: root `/C`, then `l2.usda /C`, then `l0.usda /C`.
// - reference-only: the same stage without the payload on `/Q/c`; the reference's arc holds the site.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/grafted-specializes-late.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`a grafted specializes arc moves under the root after the index's own ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
