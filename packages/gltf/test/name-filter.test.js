import test from 'node:test';
import assert from 'node:assert/strict';
import { nameFilter, selectChecks } from '../scripts/name-filter.mjs';

test('the extensions driver takes --compat as a flag, not as a check-name filter', () => {
  const checks = { 'KHR_texture_transform': 0, 'EXT_meshopt_compression': 0 };
  // `--compat` was argv[2] and matched no name, so the compat run passed having run no check.
  assert.equal(nameFilter(['--compat']), undefined);
  assert.deepEqual(selectChecks(checks, nameFilter(['--compat'])), Object.keys(checks));
  assert.deepEqual(selectChecks(checks, nameFilter(['--compat', 'meshopt'])), ['EXT_meshopt_compression']);
  assert.deepEqual(selectChecks(checks, nameFilter(['KHR'])), ['KHR_texture_transform']);
  assert.throws(() => selectChecks(checks, 'missing'), /No check name holds "missing"/);
});
