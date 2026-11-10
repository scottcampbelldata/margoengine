import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as G from '../dist/primitives.js';

// Recorded from the parent implementation before caching angular columns. Covers every output byte and group.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/primitive-workcount.json', import.meta.url)));
for (const { name, args, sha256 } of fixtures) {
  test(`${name} retains parent geometry bytes for ${JSON.stringify(args)}`, () => {
    const g = G[name](...args), hash = createHash('sha256');
    for (const key of ['positions', 'normals', 'uvs', 'indices'])
      hash.update(new Uint8Array(g[key].buffer, g[key].byteOffset, g[key].byteLength));
    hash.update(JSON.stringify(g.groups ?? []));
    assert.equal(hash.digest('hex'), sha256);
  });
}

test('angular work scales with columns plus profile rows, not their product', () => {
  const sin = Math.sin, cos = Math.cos;
  let calls = 0;
  Math.sin = (...args) => { calls++; return sin(...args); };
  Math.cos = (...args) => { calls++; return cos(...args); };
  try {
    const check = (build, expected) => {
      calls = 0;
      build();
      assert.equal(calls, expected);
    };
    check(() => G.sphereGeometry(1, 64, 32), 2 * (65 + 33));
    check(() => G.cylinderGeometry(1, 1, 1, 64, 8), 2 * 65);
    check(() => G.capsuleGeometry(0.5, 1, 16, 32), 2 * (33 + 33));
    check(() => G.torusGeometry(1, 0.4, 32, 64), 2 * (65 + 33));
  } finally {
    Math.sin = sin;
    Math.cos = cos;
  }
});
