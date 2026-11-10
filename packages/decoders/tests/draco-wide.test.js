import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeNativePoints } from '../dist/draco-native-codec.js';

const { instance: { exports: wasm } } = await WebAssembly.instantiate(
  readFileSync(new URL('../dist/draco-native.wasm', import.meta.url)),
);
const widths = [1, 16, 17, 31, 64, 127, 255];
const uint32 = (value) => [...new Uint8Array(Uint32Array.of(value).buffer)];
const float32 = (value) => [...new Uint8Array(Float32Array.of(value).buffer)];

// Authored sequential point streams: one generic attribute, three points,
// difference prediction, raw zigzag corrections, and optional quantization.
function sequential(width, quantized) {
  const bytes = [68, 82, 65, 67, 79, 2, 2, 0, 0, 0, 0, ...uint32(3),
    1, 1, 4, quantized ? 9 : 1, width, 0, 0, quantized ? 2 : 1, 0, 1, 0, 1];
  const expected = [];
  for (let point = 0; point < 3; point++) for (let component = 0; component < width; component++) {
    const value = component % 11 + 2 * point;
    bytes.push(2 * (point === 0 ? value : 2));
    expected.push(quantized ? value + component * 0.25 : value);
  }
  bytes.push(...uint32(0), ...uint32(255));
  if (quantized) {
    for (let component = 0; component < width; component++) bytes.push(...float32(component * 0.25));
    bytes.push(...float32(255), 8);
  }
  return { bytes: Uint8Array.from(bytes), expected };
}

function rawBlock(bytes, values) {
  const packed = [];
  for (let i = 0; i < values.length; i += 4) {
    let word = 0;
    for (let j = 0; j < 4; j++) word = (word << 8) | (values[i + j] ?? 0);
    packed.push(...uint32(word >>> 0));
  }
  if (packed.length === 0) packed.push(0, 0, 0, 0);
  bytes.push(...uint32(packed.length), ...packed);
}

// A two-point KD leaf exercises signed/float minima without partitioning.
function kd(width, quantized) {
  const bytes = [68, 82, 65, 67, 79, 2, 3, 0, 1, 0, 0, ...uint32(2),
    1, 1, 4, quantized ? 9 : 5, width, 0, 0, 0, ...uint32(8), ...uint32(2)];
  rawBlock(bytes, []);
  const packed = [], expected = [];
  for (let point = 0; point < 2; point++) {
    for (let index = 0; index < width; index++) packed.push((point * 7 + (index + 1) % width) % 101);
    for (let component = 0; component < width; component++)
      expected.push((point * 7 + component) % 101 + component * (quantized ? 0.25 : -3));
  }
  rawBlock(bytes, packed);
  rawBlock(bytes, []);
  rawBlock(bytes, []);
  if (quantized) {
    for (let component = 0; component < width; component++) bytes.push(...float32(component * 0.25));
    bytes.push(...float32(255), 8);
  } else {
    for (let component = 0; component < width; component++) {
      let symbol = component === 0 ? 0 : component * 6 - 1;
      while (symbol >= 128) { bytes.push((symbol & 127) | 128); symbol >>>= 7; }
      bytes.push(symbol);
    }
  }
  return { bytes: Uint8Array.from(bytes), expected };
}

for (const [name, build, points] of [['sequential', sequential, 3], ['KD', kd, 2]])
  test(`optional Draco Wasm preserves ${name} generic attributes through 255 components`, () => {
    for (const width of widths) for (const quantized of [false, true]) {
      const { bytes, expected } = build(width, quantized);
      const cloud = decodeNativePoints(wasm, bytes);
      assert.equal(cloud.pointCount, points);
      assert.equal(cloud.attributes[0].itemSize, width);
      assert.equal(cloud.attributes[0].array.constructor, quantized ? Float32Array : name === 'KD' ? Int32Array : Int8Array);
      assert.deepEqual([...cloud.attributes[0].array], expected, `${width}/${quantized}`);
      assert.deepEqual([...cloud.indices], Array.from({ length: points }, (_, i) => i));
    }
  });
