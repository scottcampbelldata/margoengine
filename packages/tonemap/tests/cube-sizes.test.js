import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCube, Tonemap } from '../dist/index.js';

const rows = '0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
const cube = (size, row = '0 0 0\n') => `LUT_3D_SIZE ${size}\n${row.repeat(size ** 3)}`;
const lut = (size = 2) => ({
  size,
  data: new Float32Array(size ** 3 * 4),
  domainMin: new Float32Array(3),
  domainMax: new Float32Array([1, 1, 1]),
});
const accepts = (value) => {
  const effect = new Tonemap();
  try {
    effect.setLUT(value);
  } finally {
    effect.dispose();
  }
};

test('.cube parsing accepts every common LUT size through 65 with explicit dimensions and exact RGBA counts', () => {
  for (const size of [2, 16, 17, 32, 33, 64, 65]) {
    const parsed = parseCube(cube(size));
    assert.equal(parsed.size, size);
    assert.equal(parsed.data.length, size ** 3 * 4);
    assert.equal(parsed.data[3], 1);
    assert.equal(parsed.data.at(-1), 1);
    assert.doesNotThrow(() => accepts(parsed));
  }
});

test('2-cube parsing preserves red-fastest order, pre-size domains, titles, comments and numeric syntax', () => {
  const parsed = parseCube(
    '\uFEFFTITLE "Small # LUT" # comment\r\nDOMAIN_MIN -1e0 +0.0 .0\r\nDOMAIN_MAX 1 2 3\r\n' +
      'LUT_3D_SIZE 2\r\n' +
      rows,
  );
  assert.deepEqual([...parsed.domainMin], [-1, 0, 0]);
  assert.deepEqual([...parsed.domainMax], [1, 2, 3]);
  assert.deepEqual(
    [...parsed.data],
    [0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1],
  );
});

test('.cube parsing accepts high-precision 65-cube text above the former limit and rejects text above 32 Mi characters', () => {
  const text = cube(65, '0.123456789 0.987654321 0.333333333\n');
  assert.ok(text.length > 8 * 1024 * 1024);
  const parsed = parseCube(text);
  assert.equal(parsed.size, 65);
  assert.equal(parsed.data[0], Math.fround(0.123456789));
  assert.throws(() => parseCube(' '.repeat(32 * 1024 * 1024 + 1)), RangeError);
  assert.throws(() => parseCube(null), TypeError);
});

test('.cube parsing rejects malformed, duplicate, late or out-of-range headers and wrong sample counts', () => {
  for (const text of [
    'LUT_3D_SIZE 0\n',
    'LUT_3D_SIZE 1\n',
    'LUT_3D_SIZE -1\n',
    'LUT_3D_SIZE 66\n',
    'LUT_3D_SIZE 999999999999999999999999999999\n',
  ])
    assert.throws(() => parseCube(text), RangeError);
  const valid = 'LUT_3D_SIZE 2\n' + rows;
  for (const text of [
    'LUT_3D_SIZE 2.5\n',
    'LUT_3D_SIZE 2 2\n',
    'LUT_1D_SIZE 2\n' + rows,
    rows,
    valid + '0 0 0\n',
    valid.slice(0, valid.lastIndexOf('1 1 1\n')),
    valid.replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 2\nLUT_3D_SIZE 2'),
    valid.replace('LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0\nDOMAIN_MIN 0 0 0\nLUT_3D_SIZE 2'),
    valid + 'DOMAIN_MAX 1 1 1\n',
    valid + 'LUT_3D_SIZE 2\n',
    'TITLE "First"\nTITLE "Second"\n' + valid,
    valid + 'TITLE "Late"\n',
    valid.replace('0 0 0', '0x10 0 0'),
    valid.replace('0 0 0', '1 0'),
    valid.replace('0 0 0', '1 0 0 0'),
    'TITLE unquoted\n' + valid,
  ])
    assert.throws(() => parseCube(text), TypeError);
  for (const text of [
    valid.replace('0 0 0', '1e50 0 0'),
    valid.replace('0 0 0', 'NaN 0 0'),
    valid.replace('0 0 0', 'Infinity 0 0'),
    'DOMAIN_MAX 1e50 1 1\n' + valid,
    'DOMAIN_MIN 1 0 0\n' + valid,
  ])
    assert.throws(() => parseCube(text), RangeError);
});

test('.cube parsing rejects an invalid size before allocating its sample array', () => {
  const NativeFloat32Array = globalThis.Float32Array,
    allocations = [];
  globalThis.Float32Array = new Proxy(NativeFloat32Array, {
    construct(target, args) {
      if (typeof args[0] === 'number' && args[0] > 3) allocations.push(args[0]);
      return Reflect.construct(target, args);
    },
  });
  try {
    assert.throws(() => parseCube('LUT_3D_SIZE 66\n'));
    assert.deepEqual(allocations, []);
  } finally {
    globalThis.Float32Array = NativeFloat32Array;
  }
});

test('manually constructed LUTs retain legacy 33-cube compatibility and require dimensions for other data sizes', () => {
  const legacy = lut(33);
  delete legacy.size;
  assert.doesNotThrow(() => accepts(legacy));
  assert.doesNotThrow(() => accepts({ ...legacy, size: undefined }));
  for (const size of [2, 17, 32, 33, 65]) assert.doesNotThrow(() => accepts(lut(size)));
  const small = lut();
  delete small.size;
  assert.throws(() => accepts(small), TypeError);
  assert.throws(() => accepts({ ...lut(), size: 3 }), TypeError);
  for (const size of [null, '2', true, {}]) assert.throws(() => accepts({ ...lut(), size }), TypeError);
  for (const size of [0, 1, 66, 2.5, NaN, Infinity, -Infinity])
    assert.throws(() => accepts({ ...lut(), size }), RangeError);
});

test('manual LUT validation checks Float32 shapes, finite RGB/alpha and finite increasing domain ranges', () => {
  for (const value of [
    { ...lut(), data: new Float64Array(32) },
    { ...lut(), data: new Float32Array(31) },
    { ...lut(), domainMin: [0, 0, 0] },
    { ...lut(), domainMax: new Float32Array(4) },
  ])
    assert.throws(() => accepts(value), TypeError);
  for (const mutate of [
    (value) => {
      value.data[0] = NaN;
    },
    (value) => {
      value.data[3] = Infinity;
    },
    (value) => {
      value.domainMin[0] = NaN;
    },
    (value) => {
      value.domainMax[0] = Infinity;
    },
    (value) => {
      value.domainMax[0] = 0;
    },
    (value) => {
      value.domainMin[0] = -3e38;
      value.domainMax[0] = 3e38;
    },
  ]) {
    const value = lut();
    mutate(value);
    assert.throws(() => accepts(value), RangeError);
  }
  const value = lut();
  value.data[3] = -2;
  assert.doesNotThrow(() => accepts(value), 'finite alpha remains unconstrained, as in legacy manual LUTs');
});
