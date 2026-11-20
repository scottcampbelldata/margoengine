// KB1942c part 24: at a child prim, the implied class arcs carried down from the parent prim are implied again,
// strongest authored arc first. Each stage in `fixtures/carried-implied-again.json` is ours, reduced from a stress
// stage; its specs are marked by `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11
// (usd-core from PyPI, run where it lives, its source never read) gave for the marked stage. What the stages pin, by
// name:
// - again: `/R` references `l1.usda</M/a>`, whose payload `l0.usda</M>` has `/M/a` inheriting `/C`, so `/R/a/a`
//   carries implied inherits of `/C/a/a` into `l1.usda` and the root stack. `/R/a` also references `l2.usda</M/a>`,
//   which reaches `l0.usda /M`, which specializes `/C/a`. At `/R/a/a` the specializes arc implies first, as it is the
//   stronger, and takes `/C/a/a` in `l1.usda`, `l2.usda` and the root stack: the carried inherits are gone.
// - held: a specializes placeholder that made no family at the parent prim, as inherits the parent prim made held its
//   sites, takes none of their sites at the child either.
// - gated: a carried specializes placeholder that implies nothing at the child (an inherit of its stack reaches its
//   site) leaves the arcs carried for it in place, and a weaker inherit does not take their sites.
// - later: a class arc placed for the child prim itself does not take a site from an implied arc carried down.
// - nested: a carried placeholder whose node authors a specializes arc of its own at the child takes no site.
// - kind: an implied specializes arc carried down keeps its site against a carried inherit implied after it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/carried-implied-again.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`implied class arcs carried to a child prim are implied again, strongest first ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
