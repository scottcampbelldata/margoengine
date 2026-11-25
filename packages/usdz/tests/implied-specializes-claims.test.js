// KB1942c part 31: which site an implied specializes chain takes from an implied inherit carried down from the parent
// prim. Each stage in `fixtures/implied-specializes-claims.json` is ours. `reading` is what OpenUSD 26.11 (usd-core from
// PyPI, run where it lives, its source never read) gave for the stage: prims, values and relationship targets. `prims` is
// the order of each prim's specs it gave for the stage marked by `prim-stack-marks.js`. What the stages pin, by name:
// - stage48 (stage 48 of seed 1942, reduced with a black-box reducer to four files): `root.usda` sublayers `l1.usda` and
//   `l0.usda`, `/R` references `l1.usda</M/a>` and `/R/a` references `l2.usda</M/a>`; `l0.usda /M` specializes `/C/a`.
//   At `/R/a/a/c` the specializes arc of `l0.usda /M/c` goes up through `l1.usda`, where an implied inherit carried down
//   from `/R/a/a` waits on `/C/a/c` under another node, leaves a placeholder there, goes on through `l2.usda` and takes
//   `root.usda /C/a/c` from the implied inherit carried down onto the index root, so `l0.usda /M/c` comes before
//   `l1.usda /C/a/c` (Margo stopped the arc at `l1.usda` and kept the carried inherit at the root).
// - stage48-parent: the same at `/R/a/c`, where the specializes arc places `l1.usda /C/a/c` live and the carried
//   inherit to that site under `l1.usda /M/a/a/c` keeps its place (Margo dropped it, losing `l1.usda /C/a/c` there).
// - held-inherit-first-hop: a carried placeholder with no specs that made no family at the parent prim, whose first
//   hop is the index root, takes no site from the carried inherit there (seed 7 stage 84, reduced).
// - root-inherit-against-inherit: an inherit implied at this prim by a stronger arc does not take the site of an implied
//   inherit carried down onto the index root (seed 1942 stage 9, reduced).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { differences } from './openusd-differences.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/implied-specializes-claims.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();
const compose = (files) =>
  composeUSDFiles('root.usda', (id) => {
    const text = files[id.replace(/^\.\//, '')];
    return text === undefined ? undefined : encoder.encode(text);
  });

for (const [name, { files, prims, reading }] of Object.entries(stages)) {
  test(`an implied specializes chain claims carried inherit sites as OpenUSD does, ${name}: values and targets`, async () => {
    assert.deepEqual(differences((await compose(files)).specs, { prims: reading }), [], name);
  });
  test(`an implied specializes chain claims carried inherit sites as OpenUSD does, ${name}: every prim's specs in order`, async () => {
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
