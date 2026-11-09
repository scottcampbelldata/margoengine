import assert from 'node:assert/strict';
const signed = [-0x6001037c3c56641cn, -0x6a5b8acf20e7ffefn, -0x6d2497b83b16e62cn];
const unsigned = [0x9ffefc83c3a99be4n, 0x95a47530df180011n, 0x92db6847c4e919d4n];
const expected = ['9ffefc83c3a99be4', '95a47530df180011', '92db6847c4e919d4'];
for (let i = 0; i < expected.length; ++i) {
  assert.equal(BigInt.asUintN(64, signed[i]).toString(16).padStart(16, '0'), expected[i]);
  assert.equal(BigInt.asUintN(64, unsigned[i]).toString(16).padStart(16, '0'), expected[i]);
  assert.equal(BigInt.asIntN(64, unsigned[i]), signed[i]);
}
console.log('All three signed/unsigned u64 representation regressions pass.');
