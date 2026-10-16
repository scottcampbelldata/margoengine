import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializerNumberSources,
  importSerializerNumberSource,
} from '../scripts/support/serializer-number-candidate.js';

const sources = await serializerNumberSources(),
  original = await importSerializerNumberSource(sources.original),
  candidate = await importSerializerNumberSource(sources.candidate);

test('private decimal conversion preserves exact strings and Float32 round trips across exponent ranges', () => {
  const values = [
    0,
    -0,
    Infinity,
    -Infinity,
    NaN,
    0.1,
    1 / 3,
    Math.PI,
    Math.E,
    1e-45,
    -1e-45,
    3.4028234663852886e38,
    -3.4028234663852886e38,
    16777217,
  ];
  const bits = new Uint32Array(2048);
  let seed = 81733;
  for (let i = 0; i < bits.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    bits[i] = seed >>> 0;
  }
  values.push(...new Float32Array(bits.buffer));
  for (const value of values) {
    const expected = original.num(value),
      actual = candidate.num(value);
    assert.equal(actual, expected);
    const rounded = Math.fround(value);
    if (Number.isFinite(rounded)) assert.equal(Math.fround(Number(actual)), rounded === 0 ? 0 : rounded);
  }
});
