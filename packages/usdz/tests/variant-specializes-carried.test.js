// KB1942c part 35: an implied specializes arc on the index root carried down from the parent prim, against one that
// a variant of the prim implies to the same site. Each stage in `fixtures/variant-specializes-carried.json` is ours.
// `reading` is what OpenUSD 26.11 (usd-core from PyPI, run where it lives, its source never read) gave for the stage:
// prims, values and relationship targets. `prims` is the order of each prim's specs it gave for the stage marked by
// `prim-stack-marks.js`. What the stages pin, by name:
// - stage33 (stage 33 of seed 1942, reduced with a black-box reducer to four files): `/P/b/b` payloads `l1.usda</M>`,
//   whose `/M` specializes `/C` and selects `vs = "y"`, so `/P/b/b` has `root.usda /C`; its variant `y` holds `a`, which
//   payloads `l1.usda</M/a>`. At `/P/b/b/a` the specializes arc that variant implies into the root stack at `/C/a` finds
//   the site held by the one carried down from `/P/b/b`: the carried arc goes and the new one stays inert, as the public
//   prim index dump shows, so `root.usda /C/a` gives nothing (Margo kept the carried arc and its spec).
// - stage33-other-stack, stage33-unresolved: the variant's payload goes to another file whose `/M` specializes `/C`, with
//   and without `/M/a` defined; the same.
// - no-variant: the payload on `/P/b/b/a` itself, not in a variant: the carried arc keeps the site and its spec.
// - root-prim-payload: the variant's payload to a root prim implies `/C` there, another site: the carried arc stays.
// - inherit: the other file's `/M` inherits `/C`: an inherit to a held site makes no node and the carried arc stays.
// - no-specializes: the other file has no class arc: the carried arc stays.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { differences } from './openusd-differences.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(
  readFileSync(new URL('./fixtures/variant-specializes-carried.json', import.meta.url), 'utf8'),
);
const encoder = new TextEncoder();
const compose = (files) =>
  composeUSDFiles('root.usda', (id) => {
    const text = files[id.replace(/^\.\//, '')];
    return text === undefined ? undefined : encoder.encode(text);
  });

for (const [name, { files, prims, reading }] of Object.entries(stages)) {
  test(`a variant's implied specializes takes a carried implied site on the index root as OpenUSD does, ${name}: values and targets`, async () => {
    assert.deepEqual(differences((await compose(files)).specs, { prims: reading }), [], name);
  });
  test(`a variant's implied specializes takes a carried implied site on the index root as OpenUSD does, ${name}: every prim's specs in order`, async () => {
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
