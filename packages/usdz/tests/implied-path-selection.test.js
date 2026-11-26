// KB1942c part 32: where an implied class arc that stands for another implied arc reads its class parent's selection.
// Each stage in `fixtures/implied-path-selection.json` is ours. `reading` is what OpenUSD 26.11 (usd-core from PyPI, run
// where it lives, its source never read) gave for the stage: prims, values and relationship targets. `prims` is the
// order of each prim's specs it gave for the stage marked by `prim-stack-marks.js`. What the stages pin, by name:
// - stage139 (stage 139 of seed 7, reduced with a black-box reducer to four files): `root.usda` sublayers `l1.usda` and
//   `l0.usda`, its class `/C` holds `a` only in variant `vs = "y"`, `/Q/c` inherits `/C` and `/Q/c/a` inherits `/C` and
//   references `l2.usda</M/a>`, which reaches `l1.usda /M/a/b` and through it `l0.usda /M/a`, whose `/M` specializes
//   `/C`. At `/Q/c/a/a/b` the specializes arc implied into the root stack at `/C/a` reads the selection for `/C` at
//   `/Q/c/a`, where nothing selects; the inherit of `/Q/c/a` reached `/C{vs=y}` there (`l0.usda /C/a` selects `y`,
//   reached through `/Q/c`), and that node's path gives `vs = "y"`, so `root.usda /C{vs=y}a` and `/C{vs=y}a{vs=y}` come
//   after `l0.usda /C/a` (Margo read selections authored at `/C{vs=y}` only and gave neither).
// - stage139-weaker-reference: stage 139 reduced again, keeping what an authored-selections-first rule got wrong:
//   `/Q/c` also references `/Shared`, whose `l1.usda /Shared/a` selects `vs = "x"` at the path read; the inherit's `y`
//   is stronger and wins, so the variant counts in its place in strength order.
// - stage9-authored-arc (stage 9 of seed 1942, reduced): an inherit implied into `l2.usda` that stands for the authored
//   inherit of `l1.usda /M` takes no selection from the `x` that the inherit of `l2.usda /M/a/a` went into.
// - own-selection-first: the same without the inherit of `/Q/c/a`, with `/Q/c` selecting `x` and `/Q/c/a` selecting
//   `y`: the arc's own reading at `/Q/c/a` gives `y`, before the `x` the inherit of `/Q/c` chose for `/C`.
// - parent-index-not-read: stage139 with `root.usda /M` selecting `x`: the index of `/M`, the prim that authored the
//   specializes arc, gives no selection, and the arc still takes `y`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { differences } from './openusd-differences.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/implied-path-selection.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();
const compose = (files) =>
  composeUSDFiles('root.usda', (id) => {
    const text = files[id.replace(/^\.\//, '')];
    return text === undefined ? undefined : encoder.encode(text);
  });

for (const [name, { files, prims, reading }] of Object.entries(stages)) {
  test(`an implied specializes arc reads its class parent's selection as OpenUSD does, ${name}: values and targets`, async () => {
    assert.deepEqual(differences((await compose(files)).specs, { prims: reading }), [], name);
  });
  test(`an implied specializes arc reads its class parent's selection as OpenUSD does, ${name}: every prim's specs in order`, async () => {
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
