// KB1942c part 18: the order of a specializes family with an implied arc that hangs from a variant held in its own
// stack. Each stage in `fixtures/specializes-variant-anchor.json` is ours, reduced from a stress stage; its specs are
// marked by `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core from PyPI,
// run where it lives, its source never read) gave for the marked stage. What the stages pin, by name:
// - implied-in-variant: `/P/a/c` references `l2.usda` (which sublayers `l0.usda`), whose `/M/c` holds `a` in variant
//   `vs=y`, referencing `l0.usda</M>`; `l0.usda /M/c/b` specializes `/C`. The arc implied into `l2.usda` hangs from the
//   variant and OpenUSD implies a placeholder for it on the reference that holds the variant; the root's implied arc
//   ranks after it, so `/P/a/c/c/a/c/b` takes the `l2.usda` stack's `/C`, then root `/C`, then `l0.usda /C`.
// - no-variant: the same stage with `a` outside the variant: root `/C` comes first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/specializes-variant-anchor.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`an implied specializes arc in a variant anchors the arcs implied above it ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
