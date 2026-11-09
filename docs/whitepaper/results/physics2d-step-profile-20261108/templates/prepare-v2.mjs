import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const root = '.lane/p/current-step-profile-v1';
const u64hex = (n) => BigInt.asUintN(64, n).toString(16).padStart(16, '0');
const signed = [-0x6001037c3c56641cn, -0x6a5b8acf20e7ffefn, -0x6d2497b83b16e62cn];
const unsigned = [0x9ffefc83c3a99be4n, 0x95a47530df180011n, 0x92db6847c4e919d4n];
const expected = ['9ffefc83c3a99be4', '95a47530df180011', '92db6847c4e919d4'];
for (let i = 0; i < 3; ++i) {
  assert.equal(u64hex(signed[i]), expected[i]);
  assert.equal(u64hex(unsigned[i]), expected[i]);
  assert.equal(BigInt.asIntN(64, unsigned[i]), signed[i]);
}
assert.ok(!existsSync(root + '/run-v2.mjs'));
let s = readFileSync(root + '/run.mjs', 'utf8');
s = s.replaceAll('results.json', 'results-v2.json')
  .replaceAll('k.bits(i).toString(16)', 'BigInt.asUintN(64, k.bits(i)).toString(16)')
  .replaceAll('k.profile_state().toString(16)', 'BigInt.asUintN(64, k.profile_state()).toString(16)');
assert.equal((s.match(/BigInt\.asUintN\(64, k\.bits\(i\)\)/g) ?? []).length, 2);
assert.equal((s.match(/BigInt\.asUintN\(64, k\.profile_state\(\)\)/g) ?? []).length, 2);
writeFileSync(root + '/run-v2.mjs', s);
writeFileSync(root + '/harness-u64-regression.json', JSON.stringify({ passed: true, expected, signed: signed.map(String), unsigned: unsigned.map(String), originalFailure: root + '/results.json', correction: 'Normalize Wasm i64 bit patterns with BigInt.asUintN(64); all physics artifacts, expected hashes, shipped checks and state/work predicates unchanged.' }, null, 2) + '\n');
console.log('All3 directed signed/unsigned hash representation assertions pass; created corrected unique driver.');
