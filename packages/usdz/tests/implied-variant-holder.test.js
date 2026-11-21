// KB1942c part 28: class arcs implied up from a node under a variant whose holder is in the same stack. Each stage in
// `fixtures/implied-variant-holder.json` is ours; its specs are marked by `prim-stack-marks.js`, and the order of each
// prim's specs there is what OpenUSD 26.11 (usd-core from PyPI, run where it lives, its source never read) gave for the
// marked stage. What the stages pin, by name:
// - stage25 (stage 25 of seed 1942, reduced with a black-box reducer): `/Q` references `l2.usda</M/a>`, whose `/M/a/b`
//   references `l1.usda</M/a>`; `l1.usda /M` inherits `/C` and selects `vs = "y"`, whose `a` payloads `l0.usda`, where
//   `/M` inherits `/C`. The inherit implied into `l1.usda` hangs from the variant, and OpenUSD ranks it, and the arcs
//   implied from it, from the variant's holder (the reference to `l1.usda</M/a>`, namespace depth 3, before the
//   ancestral `l1.usda /C/a` at depth 1): at `/Q/b` root `/C` comes before root `/C/a` and `l2.usda /C` before
//   `l2.usda /C/a` (Margo gave the reverse, so `/Q/b.v0` was `l0.usda /C/a`'s 103, not root `/C`'s 391).
// - no-variant: `a` outside the variant; specializes: `l0.usda /M` specializes `/C` instead.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/implied-variant-holder.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`class arcs implied from under a variant rank from the variant's holder, ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
