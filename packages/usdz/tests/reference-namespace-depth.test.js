// KB1942c part 16: how a reference or payload ranks by namespace depth when it is authored inside a referenced prim.
// Each stage in `fixtures/reference-namespace-depth.json` is ours, written for this from black-box probes; its specs are
// marked by `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core from PyPI,
// run where it lives, its source never read) gave for the marked stage. A reference ranks by the depth of its prim in
// the stack that authors it, not by the depth of the stage prim it composes. What the stages pin, by name:
// - deeper-reference: `/Q` payloads `l2.usda</M/a>`; `l2.usda /M/a` references `l0.usda` and `l2.usda /M/a/a`
//   references `l1.usda</M/a>`. At `/Q/a/a` the reference authored on `/M/a/a` (depth 3 in `l2.usda`) beats the one
//   authored on `/M/a` (depth 2), so `l1.usda /C/a`, implied from the inherit of `l0.usda /M/a/a`, comes in.
// - same-prim: both references authored on `l2.usda /M/a/a` keep their list order.
// - stage-root: the same references authored on stage prims.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/reference-namespace-depth.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`a reference ranks by the depth of its prim in its own stack ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
