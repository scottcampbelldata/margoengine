// KB1942c part 26: an implied specializes arc that reaches a placeholder whose site an inherit of the same stack holds.
// Each stage in `fixtures/implied-through-held.json` is ours, reduced from a stress stage with a black-box reducer; its
// specs are marked by `prim-stack-marks.js`, and the order of each prim's specs there is what OpenUSD 26.11 (usd-core
// from PyPI, run where it lives, its source never read) gave for the marked stage. What the stages pin, by name:
// - stage68 (stage 68 of seed 7): `/P/a` references `l2.usda</M>`, whose stack (it sublayers `l0.usda`) specializes
//   `/C/a` and payloads `l0.usda</M>`, which specializes `/C/a` too; `/P` references `l2.usda</M>`, whose `/M/a`
//   inherits `/C/a`. The inherit holds `l2.usda /C/a`, so the specializes arc there is a placeholder that implies
//   nothing, and the arc implied up from `l0.usda` stops on it: root `/C/a` comes in through the inherit, second
//   strongest (Margo went on through the placeholder and gave root `/C/a` as a specializes arc, weak).
// - stage9 (stage 9 of seed 1942): the same at `/P/a/a`, the inherit authored on `l2.usda /M/a/a` and reached through
//   the reference `/P` carries down, the specializes arc on `l2.usda /M/a` and its payload's `l0.usda /M` inheriting.
// - own-class-arc: `l2.usda /M` inherits `/C/b` too, a class arc of the placeholder's own node.
// - no-sublayer: `l2.usda` does not sublayer `l0.usda`, so no specializes arc of its own reaches `/C/a`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/implied-through-held.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`an implied specializes arc stops on a placeholder an inherit holds, ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
