// KB1942c part 30: where an implied class arc that stands for another implied arc reads the selections for its class's
// ancestral variants. Each stage in `fixtures/implied-chain-variants.json` is ours. `reading` is what OpenUSD 26.11
// (usd-core from PyPI, run where it lives, its source never read) gave for the stage: prims, values and relationship
// targets. `prims` is the order of each prim's specs it gave for the stage marked by `prim-stack-marks.js`. What the
// stages pin, by name:
// - stage48 (stage 48 of seed 1942, reduced with a black-box reducer): `root.usda` sublayers `l1.usda` and `l0.usda`
//   and `/Q` payloads `l2.usda</M>`; `l2.usda /M/a` references `l1.usda</M>` and `/M/a/b` payloads `l1.usda`;
//   `l1.usda /M`'s variant `vs = "x"` holds `c`, which payloads `l0.usda</M/a>`, and `l1.usda /M/b` selects
//   `vs = "x"`; `l0.usda /M` specializes `/C/a`. The specializes arc implied into the root stack keeps the pair `/C/a`
//   to `/Q/a/b` and reads `/Q/a/b` across the index, where the reference's `l1.usda /M/b` selects `vs = "x"`: `/Q/a/b/c`
//   gets `root.usda /C/a{vs=x}a`, whose `rel r = [</Shared>]` maps to `/Shared` (Margo gave no target).
// - root-selection: the selection on `root.usda /Q/a/b` instead does the same; no-selection: with none, no variant.
// - inherit: `l0.usda /M` inherits `/C/a` instead, and the implied inherit of the root stack, strongest after the root,
//   gets the variant too (Margo gave it none, so `l1.usda /M{vs=x}c` came first).
// - carried-inherit-unread: `/R` inherits `/C` and `/R/b` too, `root.usda /C/b` selects `vs = "x"` and the payload's
//   `l2.usda /M/b` `vs = "y"`; the inherits carried down are not read, so `/R/b/b/c/b` gets `root.usda /C{vs=y}a`.
// - carried-specializes-unread: `/P/b` specializes `/C`, whose selection `vs = "x"` is not read either, so `/C/a`'s
//   own `vs = "y"` gives no variant at `/P/b/b/a`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { differences } from './openusd-differences.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/implied-chain-variants.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();
const compose = (files) =>
  composeUSDFiles('root.usda', (id) => {
    const text = files[id.replace(/^\.\//, '')];
    return text === undefined ? undefined : encoder.encode(text);
  });

for (const [name, { files, prims, reading }] of Object.entries(stages)) {
  test(`an implied class arc reads its ancestral variant selections across the index, ${name}: values and targets as OpenUSD's`, async () => {
    assert.deepEqual(differences((await compose(files)).specs, { prims: reading }), [], name);
  });
  test(`an implied class arc reads its ancestral variant selections across the index, ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
