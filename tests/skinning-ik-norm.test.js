import test from 'node:test';
import assert from 'node:assert/strict';
import { hypot3Into, hypot4Into } from '../examples/skinning-ik/norm.ts';

test('private length kernels match native hypot bits for numeric extremes and deterministic random binary64 inputs', () => {
  const encoded = new Float64Array(2),
    bits = new Uint32Array(encoded.buffer);
  const sameBits = (a, b) => {
    encoded[0] = a;
    encoded[1] = b;
    return bits[0] === bits[2] && bits[1] === bits[3];
  };
  const out = new Float64Array(2),
    edges = [
      0,
      -0,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      1e-308,
      1e308,
      NaN,
      Infinity,
      -Infinity,
    ];
  for (const x of edges)
    for (const y of edges)
      for (const z of edges) {
        hypot3Into([x, y, z], out);
        assert.ok(sameBits(out[0], Math.hypot(x, y, z)), `3D edge ${x}, ${y}, ${z}`);
        for (const w of edges) {
          hypot4Into([x, y, z, w], out, 1);
          assert.ok(sameBits(out[1], Math.hypot(x, y, z, w)), `4D edge ${x}, ${y}, ${z}, ${w}`);
        }
      }
  let seed = 0x9e3779b9;
  const words = new Uint32Array(2),
    number = new Float64Array(words.buffer),
    point = new Float64Array(4);
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let i = 0; i < 250000; i++) {
    for (let j = 0; j < 4; j++) {
      words[0] = random();
      words[1] = random();
      point[j] = number[0];
    }
    hypot3Into(point, out);
    hypot4Into(point, out, 1);
    assert.ok(sameBits(out[0], Math.hypot(point[0], point[1], point[2])), `3D binary64 sample ${i}`);
    assert.ok(sameBits(out[1], Math.hypot(point[0], point[1], point[2], point[3])), `4D binary64 sample ${i}`);
  }
});

test('length outputs preserve aliases, untouched slots, independent calls and guard-before-write on conversion failure', () => {
  const alias = new Float64Array([3, -4, 12, -84, 123]),
    expected3 = Math.hypot(alias[0], alias[1], alias[2]);
  hypot3Into(alias, alias);
  assert.equal(alias[0], expected3);
  assert.deepEqual([...alias.slice(1)], [-4, 12, -84, 123]);
  const expected4 = Math.hypot(alias[0], alias[1], alias[2], alias[3]);
  hypot4Into(alias, alias, 3);
  assert.equal(alias[3], expected4);
  assert.equal(alias[4], 123);
  const out = new Float64Array([9, 8]);
  assert.throws(() => hypot3Into([1, Symbol(), 2], out), TypeError);
  assert.deepEqual([...out], [9, 8]);
  hypot3Into([-0, 0, 0], out, 1);
  assert.ok(Object.is(out[1], 0));
  assert.equal(out[0], 9);
  hypot4Into([Infinity, NaN, 0, -0], out);
  assert.equal(out[0], Infinity);
});
