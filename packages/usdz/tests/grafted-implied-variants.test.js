// KB1942c part 34: the ancestral variants of an implied specializes arc carried down inside a grafted index (an arc
// to a prim below a root prim, composed alone). Each stage in `fixtures/grafted-implied-variants.json` is ours.
// `reading` is what OpenUSD 26.11 (usd-core from PyPI, run where it lives, its source never read) gave for the stage:
// prims, values and relationship targets. `prims` is the order of each prim's specs it gave for the stage marked by
// `prim-stack-marks.js`. What the stages pin, by name:
// - stage8 (stage 8 of seed 1942, reduced with a black-box reducer to four files): `/P{vs=x}c` references
//   `l2.usda</M/a>`; `l2.usda /M` inherits `/C`, which selects `vs = "x"`, and references `l0.usda</M/a>`, whose `/M`
//   specializes `/C`. In the index of `/M` the specializes arc implied into `l2.usda` at `/C/a` goes into `/C/a{vs=x}`
//   through the inherit's selection, but at `/P/c` that arc's `/C/a/a` keeps only what its site selects alone, none, so
//   `l2.usda /C/a{vs=x}a` is not there (Margo carried the variant down from the index of `/M`).
// - stage8-resolved: the same with `l0.usda /M/a` defined, so the reference resolves.
// - stage8-whole-index: the same with `/T` referencing `l2.usda</M>`: `/T` has `/C/a{vs=x}` and `/T/a` has
//   `/C/a{vs=x}a`, which a graft of `/M/a` leaves out.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { differences } from './openusd-differences.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/grafted-implied-variants.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();
const compose = (files) =>
  composeUSDFiles('root.usda', (id) => {
    const text = files[id.replace(/^\.\//, '')];
    return text === undefined ? undefined : encoder.encode(text);
  });

for (const [name, { files, prims, reading }] of Object.entries(stages)) {
  test(`an implied specializes arc inside a graft takes its ancestral variants from its site alone, ${name}: values and targets`, async () => {
    assert.deepEqual(differences((await compose(files)).specs, { prims: reading }), [], name);
  });
  test(`an implied specializes arc inside a graft takes its ancestral variants from its site alone, ${name}: every prim's specs in order`, async () => {
    const { specs } = await compose(markStage(files));
    for (const [path, order] of Object.entries(prims)) {
      const values = {};
      for (const key in specs)
        if (key.startsWith(path + '.o') && !key.slice(path.length + 1).includes('.'))
          values[key.slice(path.length + 1)] = specs[key].fields.default;
      assert.deepEqual(stackOrder(values), order, `${name} ${path}`);
    }
  });
}
