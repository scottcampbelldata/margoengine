import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralNormalExpectations } from '../examples/package-benchmarks/proofs/normal-fallback.js';
const pair = () => [
  ['texture', 'texture#11', { format: 'rgba8unorm', size: [1, 1], mipLevelCount: 1, usage: 22 }],
  ['writeTexture', { texture: 'texture#11' }, 'Uint8Array:8080ffff', { bytesPerRow: 4 }, [1, 1], undefined],
];
test('historical normal expectation changes exact format, bytes and row size together, leaving the input untouched', () => {
  const original = pair(),
    fixed = neutralNormalExpectations(original);
  assert.deepEqual(original, pair());
  const expected = pair();
  expected[0][2].format = 'rgba16float';
  expected[1][2] = 'Uint16Array:00380038003c003c';
  expected[1][3].bytesPerRow = 8;
  assert.deepEqual(fixed, expected);
});
test('historical correction never accepts a different texel, descriptor or resource', () => {
  for (const modify of [
    (p) => (p[1][2] = 'Uint8Array:7f80ffff'),
    (p) => (p[1][1].texture = 'texture#12'),
    (p) => (p[0][2].size = [2, 1]),
    (p) => (p[0][2].format = 'rgba8unorm-srgb'),
    (p) => (p[1][3].bytesPerRow = 8),
  ]) {
    const input = pair();
    modify(input);
    assert.deepEqual(neutralNormalExpectations(input), input);
  }
});
