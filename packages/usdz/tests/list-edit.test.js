// Relationship target list edits over a weaker sublayer, composed as OpenUSD 26.11 composes them. The 300 stages and
// their targets come from tests/oracle/list-edit-truth.py (usd-core, black-box): random add, prepend, append, delete
// and reorder edits on top of an explicit list. Before the fix 122 of them differed: reorder
// moved each listed item into another listed item's slot instead of carrying the unlisted items that follow it, and an
// added item also prepended or appended was listed twice.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeUSDFiles } from '../dist/compose.js';

const truth = JSON.parse(readFileSync(new URL('./fixtures/list-edit.json', import.meta.url), 'utf8'));

test('relationship target list edits compose to the targets OpenUSD gives', async () => {
  const files = { 'root.usda': truth.root, 'weak.usda': truth.weak };
  const { specs } = await composeUSDFiles('root.usda', (id) =>
    id in files ? new TextEncoder().encode(files[id]) : undefined,
  );
  const differ = [];
  truth.targets.forEach((expected, n) => {
    const got = (specs[`/Rel/C${n}.r`]?.fields.targetPaths ?? []).map((path) => path.slice(1));
    if (JSON.stringify(got) !== JSON.stringify(expected)) differ.push(`C${n}: ${got} != ${expected}`);
  });
  assert.deepEqual(differ, []);
});
