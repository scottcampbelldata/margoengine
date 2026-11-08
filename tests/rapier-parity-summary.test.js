// Regression: docs/rapier-parity.md carried a summary typed by hand (61 DONE, 21 BUILDING) while its rows had moved on
// (84 DONE, 3 BUILDING); nothing recounted it. The summary must equal the rows' own count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkParity, countParity } from '../scripts/check-rapier-parity.mjs';

const doc = (summary) => `# Part 1: Rapier parity

## Shapes

| Row | Rapier | Root today | Own solver | Status | WebGPU | WebGL2 |
| --- | --- | --- | --- | --- | --- | --- |
| S-01 | ball | yes | yes | DONE: a test | Wasm | Wasm |
| S-02 | cuboid | yes | yes | PARTIAL: rest in 139.1 | Wasm | Wasm |
| S-03 | polyline | no | none | MISSING, 139.1 | Wasm | Wasm |

## Where Margo already does more than Rapier

| Row | What | Proof |
| --- | --- | --- |
| M-01 | more | a test |

# Part 2: Beyond Rapier

## Extras

| Row | Feature | Who has it | Paper | WebGPU | WebGL2 | Batch |
| --- | --- | --- | --- | --- | --- | --- |
| X-01 | buoyancy | Jolt | a paper | Wasm | Wasm | PLANNED 131 (buoyancy), extended in 149.1 |
| X-02 | fracture | Jolt | a paper | Wasm | Wasm | 150.1 |

## Summary

| Part | Rows | DONE | PARTIAL | BUILDING 126 | PLANNED 127 to 131 | MISSING, now owned | N/A |
| --- | --- | --- | --- | --- | --- | --- | --- |
${summary}
`;

test('the parity file summary equals the count of its rows', () => {
  const text = readFileSync(new URL('../docs/rapier-parity.md', import.meta.url), 'utf8');
  assert.deepEqual(checkParity(text), []);
  assert.ok(countParity(text)[1].DONE > 0);
});

test('rows count by their Status, Part 2 by a status in its Batch cell, and tables with neither are left out', () => {
  const good = '| 1, Rapier parity | 3 | 1 | 1 | 0 | 0 | 1 | 0 |\n| 2, beyond Rapier | 2 | 0 | 0 | 0 | 1 (extended later) | 1 | 0 |';
  assert.deepEqual(checkParity(doc(good)), []);
  const stale = good.replace('| 3 | 1 | 1 |', '| 3 | 2 | 0 |');
  assert.deepEqual(checkParity(doc(stale)), [
    'Part 1 DONE: the summary says 2, the rows count 1',
    'Part 1 PARTIAL: the summary says 0, the rows count 1',
  ]);
  assert.throws(() => countParity(doc(good).replace('DONE: a test', 'done soon')), /S-01/);
});
