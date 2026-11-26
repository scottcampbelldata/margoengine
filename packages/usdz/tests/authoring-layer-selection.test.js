// KB1942c part 33: which stack's index of the authoring prim gives an implied class arc on the index root its
// ancestral variant selections. Each stage in `fixtures/authoring-layer-selection.json` is ours. `reading` is what
// OpenUSD 26.11 (usd-core from PyPI, run where it lives, its source never read) gave for the stage: prims, values and
// relationship targets. `prims` is the order of each prim's specs it gave for the stage marked by
// `prim-stack-marks.js`. What the stages pin, by name:
// - stage38 (stage 38 of seed 7, reduced with a black-box reducer to four files): `root.usda` sublayers `l1.usda` and
//   `l0.usda`; `/R` references `l2.usda</M/a>`, and `l2.usda` sublayers `l1.usda`, whose `/M` specializes `/C` and
//   selects `vs = "y"`, while `l1.usda /C` selects `x` and holds `a` only in `x`. The specializes arc implied into the
//   root stack at `/C/a` reads `/M` in the root stack, which holds `l1.usda`, the layer that authored the arc, and takes
//   `y`: no `/C{vs=y}a` exists, so `/R` gets no class spec (Margo took the root stack's own `x` and gave
//   `l1.usda /C{vs=x}a`, as it read `/M` only when the stack held the arc stack's root layer, `l2.usda`).
// - stage38-root-variant: `root.usda /C` also holds `a` in `y`; `/R` gets `root.usda /C{vs=y}a`.
// - stage38-class-unselected: stage38-root-variant without `l2.usda /C`'s `y`: the `l2.usda` node gives
//   `l1.usda /C{vs=x}a` and the root stack's arc still takes `y` from `/M`, so `/R` has both.
// - stage38-authoring-unselected: stage38-root-variant with no selection on `/M`: the root stack's arc reads its own
//   `x` (passes before the change too; it pins that only the authoring prim's selection moved).
// - stage31 (stage 31 of seed 7, reduced): the arc is authored in `l0.usda`, which both stacks sublayer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { differences } from './openusd-differences.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/authoring-layer-selection.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();
const compose = (files) =>
  composeUSDFiles('root.usda', (id) => {
    const text = files[id.replace(/^\.\//, '')];
    return text === undefined ? undefined : encoder.encode(text);
  });

for (const [name, { files, prims, reading }] of Object.entries(stages)) {
  test(`an implied class arc reads its authoring prim's selections where the layer that authored it is, ${name}: values and targets`, async () => {
    assert.deepEqual(differences((await compose(files)).specs, { prims: reading }), [], name);
  });
  test(`an implied class arc reads its authoring prim's selections where the layer that authored it is, ${name}: every prim's specs in order`, async () => {
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
