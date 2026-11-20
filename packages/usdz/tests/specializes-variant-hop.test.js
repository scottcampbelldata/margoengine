// KB1942c part 15: the order of one specializes family when the authored arc sits in a variant. Each stage in
// `fixtures/specializes-variant-hop.json` is ours, written for this from black-box probes; its specs are marked by
// `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core from PyPI, run where
// it lives, its source never read) gave for the marked stage. OpenUSD first implies a placeholder for the arc on the
// node that holds the variant, in the same layer stack, and the arcs implied further up rank against that placeholder
// within their side of the authored arc. What the stages pin, by name:
// - in-variant: `l0.usda /M/a/a{vs=x}b` specializes `/C`; `l1.usda /M/c` references `l0.usda</M/a>`, `l2.usda /M/c`
//   payloads `l1.usda` and `root.usda /P/c/b` references `l2.usda</M>`. `/P/c/b/c/c/a/b` takes `l1.usda /C`, then
//   `l2.usda /C`, then `l0.usda /C`.
// - prim-variant: the arc in a variant of the prim itself, `l0.usda /M/a/a/b{vs=x}`, does the same.
// - no-variant: the arc on `l0.usda /M/a/a/b` with no variant keeps `l1.usda /C`, `l0.usda /C`, `l2.usda /C`.
// - one-hop: a variant inside a reference straight under the root.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/specializes-variant-hop.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`a specializes family whose authored arc is in a variant ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
