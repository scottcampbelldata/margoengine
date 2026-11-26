// KB1942c part 36: the order of the tasks of a site composed alone for an arc. Each stage in
// `fixtures/grafted-variant-arcs-late.json` is ours. `reading` is what OpenUSD 26.11 (usd-core from PyPI, run where it
// lives, its source never read) gave for the stage: prims, values and relationship targets. `prims` is the order of
// each prim's specs it gave for the stage marked by `prim-stack-marks.js`. What the stages pin, by name:
// - stage18 (stage 18 of seed 7, reduced with a black-box reducer to four files): `/R/b/c` payloads `l1.usda</M/a>`;
//   `l0.usda /M/a` (a sublayer of `l1.usda`) specializes `/C/a` and `l1.usda /M` selects `vs = "y"`, whose `a`
//   inherits `/C/a`. In `/M/a` composed alone for the payload the variant is chosen again and its arcs come after the
//   specializes arc, which holds `/C/a`, so `l1.usda /C{vs=x}a` goes under the index root, weakest, after the
//   `l0.usda /M/b/c` that `/R`'s payload carries down (Margo followed the variant's inherit first and put the class
//   under the payload). On the stage itself `/M/a` keeps the inherit, as its public prim index dump shows.
// - stage18-reference: the same with a reference for the payload.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { differences } from './openusd-differences.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/grafted-variant-arcs-late.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();
const compose = (files) =>
  composeUSDFiles('root.usda', (id) => {
    const text = files[id.replace(/^\.\//, '')];
    return text === undefined ? undefined : encoder.encode(text);
  });

for (const [name, { files, prims, reading }] of Object.entries(stages)) {
  test(`a site composed alone follows its carried variants' arcs last, ${name}: values and targets`, async () => {
    assert.deepEqual(differences((await compose(files)).specs, { prims: reading }), [], name);
  });
  test(`a site composed alone follows its carried variants' arcs last, ${name}: every prim's specs in order`, async () => {
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
