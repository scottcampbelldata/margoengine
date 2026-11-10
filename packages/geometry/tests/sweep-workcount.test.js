import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { latheGeometry, tubeGeometry, LineCurve3, CatmullRomCurve3 } from '../dist/index.js';

const profile = [[0, -1], [0.4, -0.8], [1, 0], [0.4, 1], [0, 1.3]];
// Parent byte digests, captured before angular reuse. Include seams, collapsed profiles and closed curved tubes.
const cases = [
  [() => latheGeometry(profile, 128), '5624a2acccc8ed718eaab906cfa959b5f31dae486b210819930f7fdc876ba204'],
  [() => latheGeometry(profile, 9, -0.3, 2.1), '7079db525795dc170b4d6f403895858e25e63f469c9914be4b669dc358977282'],
  [() => latheGeometry(profile, 1, -0, 0), '26b74d7b47efc5885adf8101bd9ff3c35fb1f648aaf5083666b054083aede078'],
  [() => latheGeometry([[1, 0], [1, 0], [0, 0]], 7, 0, -1), '3b5fad6439ed5191e276e17fee6d2b80e72e7f332a58504d40d017fac37a7c5e'],
  [() => tubeGeometry(new LineCurve3([0, 0, 0], [2, 1, -3]), 17, 0.2, 9), 'fbb9b896f52eb7ecff194c0f3fef46dd64227face77c43e5d0c46383ee570e08'],
  [() => tubeGeometry(new CatmullRomCurve3([[0, 0, 0], [1, 2, 0], [3, 1, 1], [4, 4, 2]]), 32, 0.1, 12), 'cce0fc531c5a6cf6d7bb862ccfb62bcd8eb3353db886799b6d0ee6226239a2d7'],
  [() => tubeGeometry(new CatmullRomCurve3([[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]], true), 16, 0.2, 7, true), '6505a70dcc508ce641b4709c3d67f6a3fc497b9200de7bb1761a0dd0b5e9cbab'],
];
for (const [i, [build, expected]] of cases.entries())
  test(`lathe/tube parent geometry bytes ${i}`, () => {
    const g = build(), hash = createHash('sha256');
    for (const key of ['positions', 'normals', 'uvs', 'indices'])
      hash.update(new Uint8Array(g[key].buffer, g[key].byteOffset, g[key].byteLength));
    assert.equal(hash.digest('hex'), expected);
  });

test('lathe and tube angular work is independent of profile/ring count', () => {
  const sin = Math.sin, cos = Math.cos;
  let calls = 0;
  Math.sin = (...args) => { calls++; return sin(...args); };
  Math.cos = (...args) => { calls++; return cos(...args); };
  try {
    const points = Array.from({ length: 64 }, (_, i) => [0.3 + i / 100, i / 32]);
    latheGeometry(points, 128);
    assert.equal(calls, 2 * 129);
    calls = 0;
    tubeGeometry(new LineCurve3([0, 0, 0], [0, 1, 0]), 512, 0.1, 16);
    assert.equal(calls, 2 * 17);
  } finally {
    Math.sin = sin;
    Math.cos = cos;
  }
});
