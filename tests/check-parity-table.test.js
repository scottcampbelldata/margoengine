// Regression: docs/threejs-parity.md carried a summary typed by hand that nothing recounted, and it drifted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { checkParity, checkReferences, pageSource, parseParity } from '../scripts/check-parity-table.mjs';

const doc = (s, extra = '') => `# Parity

## Summary

${s.total} three.js features in 2 areas (${s.dag} of the COVERED rows are marked †):

| Status | Count | Meaning |
| --- | --- | --- |
| COVERED | ${s.covered} | x |
| PARTIAL | ${s.partial} | x |
| MISSING | ${s.missing} | x |

## Matrix

### 1. A

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| a | COVERED | x | y |
| b | COVERED † | x | y |
| c | PARTIAL | x | y |
${extra}
### 2. B

| three.js | Status | Margo | Notes |
| --- | --- | --- | --- |
| d | MISSING |: | |

## What is missing or partial, and what to do

Recounted from the rows (2026-10-24): ${s.partial} PARTIAL, ${s.missing} MISSING. COVERED rows stay.

| Row | What is missing | What to do |
| --- | --- | --- |
| zzz | PARTIAL. not a matrix row | x |
`;
const good = { total: 4, covered: 2, partial: 1, missing: 1, dag: 1 };

test('a consistent table passes and only Matrix rows are counted', () => {
  const text = doc(good);
  assert.deepEqual(parseParity(text).counts, { COVERED: 2, PARTIAL: 1, MISSING: 1, 'NOT PLANNED': 0 });
  assert.deepEqual(checkParity(text), []);
});

test('a summary that disagrees with the rows fails and names the fix', () => {
  const problems = checkParity(doc({ ...good, covered: 3, partial: 0 }));
  assert.ok(problems.some((p) => /Summary says 3 COVERED, rows count 2/.test(p)));
  assert.ok(problems.some((p) => /Summary says 0 PARTIAL/.test(p)));
  assert.ok(problems.some((p) => /Recounted from the rows/.test(p)));
  assert.match(problems.at(-1), /Fix the text to match the rows/);
});

test('a row added without updating the summary fails; a not-planned row is its own class', () => {
  assert.ok(checkParity(doc(good, '| e | COVERED | x | y |\n')).some((p) => /says 4 features, rows count 5/.test(p)));
  const planned = doc({ ...good, total: 5 }, '| e | NOT PLANNED | x | y |\n');
  assert.equal(parseParity(planned).counts['NOT PLANNED'], 1);
  assert.ok(checkParity(planned).some((p) => /Summary table has no NOT PLANNED row/.test(p)));
});

test('an unknown status is rejected', () => {
  assert.ok(checkParity(doc(good, '| e | PARTIALLY | x | y |\n')).some((p) => /unknown status/.test(p)));
});

test('the explainer page must quote the same counts', () => {
  const text = doc(good);
  assert.deepEqual(checkParity(text, '**4 features, 2 COVERED, 1 PARTIAL, 1 MISSING**'), []);
  assert.ok(checkParity(text, '**4 features, 3 COVERED, 0 PARTIAL, 1 MISSING**').length > 0);
});

test('the real docs are consistent', () => {
  const read = (f) => readFileSync(new URL(`../docs/${f}`, import.meta.url), 'utf8');
  assert.deepEqual(checkParity(read('threejs-parity.md'), read('three-parity-matrix.md')), []);
});

test('a stale repository path, package or page in the table fails, and example names stay private', () => {
  const exists = (path) => path === 'packages/real' || path === 'examples/clipping-planes.html';
  assert.deepEqual(
    checkReferences(
      '`packages/real` @margoengine/real [page](https://margoengine.com/demos/clipping-planes.html)',
      exists,
    ),
    [],
  );
  const problems = checkReferences(
    '`packages/gone/a.ts` @margoengine/gone [page](https://margoengine.com/demos/gone.html) [page](https://margoengine.com/nowhere/) webgl_loader_x',
    exists,
  );
  assert.equal(problems.length, 5);
  assert.ok(problems.some((p) => /example name/.test(p)));
  assert.equal(pageSource('/gallery/khronos.html'), 'examples/gallery/khronos.html');
});

test('the real table names only things that exist', () => {
  const root = new URL('..', import.meta.url);
  assert.deepEqual(
    checkReferences(readFileSync(new URL('../docs/threejs-parity.md', import.meta.url), 'utf8'), (path) =>
      existsSync(new URL(path, root)),
    ),
    [],
  );
});
