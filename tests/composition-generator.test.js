import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { C2, coveringArray, missingTuples, pairCoverage } from '../scripts/support/composition-contracts.mjs';

test('all 276 C2 pairs cover all four binary states with sparse deterministic rows', () => {
  const rows = coveringArray(C2);
  assert.equal(C2.length, 24);
  assert.ok(!C2.includes('sciviz'));
  assert.deepEqual(missingTuples(C2, rows), []);
  assert.deepEqual(pairCoverage(C2, rows), { covered: 276, total: 276 });
  assert.ok(rows.every((row) => row.length <= 5 && new Set(row).size === row.length));
  assert.deepEqual(coveringArray(C2), rows);
  assert.ok(missingTuples(C2, rows.slice(1)).length > 0, 'removing the first row must expose lost coverage');
});

test('small arrays, separator names and bad inputs', () => {
  for (let n = 2; n <= 8; n++)
    for (const width of [2, 3, 5]) {
      const members = Array.from({ length: n }, (_, i) => `member+${i}`);
      assert.deepEqual(missingTuples(members, coveringArray(members, width)), []);
    }
  for (const members of [[], ['one'], ['same', 'same'], ['a', '']])
    assert.throws(() => coveringArray(members), RangeError);
  for (const width of [0, 1, 2.5, NaN]) assert.throws(() => coveringArray(['a', 'b'], width), RangeError);
});

test('committed pages and manifest match the generator exactly', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-composition.mjs', '--check'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const matrix = JSON.parse(readFileSync(new URL('./composition/generated.json', import.meta.url)));
  for (const { id, members } of matrix.rows) {
    const source = readFileSync(new URL(`./composition/${id}.ts`, import.meta.url), 'utf8');
    for (const member of members) assert.ok(source.includes(`'@margoengine/${member}'`));
  }
});
