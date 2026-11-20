// KB1942c part 13: a reference carried down to a child prim that gets a class arc of its own there implies the
// specializes placeholders carried down with it again; on the index root such an arc takes its site from an implied
// inherit carried down for another arc. Each stage in `fixtures/carried-placeholder-reimplied.json` is ours, written for
// this from black-box probes; its specs are marked by `prim-stack-marks.js`, and the order of each prim's specs there is
// what OpenUSD 26.11 (usd-core from PyPI, run where it lives, its source never read) gave for the marked stage. What the
// stages pin, by name:
// - reimplied: `/P` inherits `/C` and references `l2.usda</M>`, `/P/a` references `l2.usda` (its default prim `/M`);
//   `l2.usda /M/a` specializes `/C` and `/M/a/a` inherits `/C`. At `/P/a/a` the inherit holds `root.usda /C`; at
//   `/P/a/a/a` the reference from `/P/a` gets the inherit of its own, its placeholder for `/C/a` implies its arc again
//   and `root.usda /C/a` comes after `l2.usda /M/a/a`, as a specializes.
// - class-specs, class-root-spec: the same with specs in `l2.usda /C/a` or `l2.usda /C`.
// - no-own-arc: the specializes comes from another prim, `/N/a`, whose reference gets no class arc at `/P/a/a/a`: the
//   inherit carried down keeps `root.usda /C/a`.
// - reference-root: the specializes is authored on the referenced prim itself; its placeholder is gone one prim down,
//   so the inherit carried down keeps `root.usda /C/c`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';
import { markStage } from './prim-stack-marks.js';
import { stackOrder } from './prim-stack-order.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/carried-placeholder-reimplied.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

for (const [name, { files, prims }] of Object.entries(stages)) {
  test(`carried placeholder implied again ${name}: every prim's specs come in OpenUSD's order`, async () => {
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
