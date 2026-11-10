import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKsplat, parseCompressedPly, encodePly } from '../dist/formats.js';
import { parsePly, splatsFromAttributes, validateSplats } from '../dist/data.js';

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url));
const linear = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const slope = (x) => (x <= 0.04045 ? 1 / 12.92 : (2.4 / 1.055) * ((x + 0.055) / 1.055) ** 1.4);
for (let level = 0; level < 3; level++)
  test(`KSplat ${level}: real capture against independent black-box getters`, () => {
    const data = parseKsplat(fixture(`raccoon-${level}.ksplat`)),
      samples = JSON.parse(fixture(`ksplat-${level}-oracle.json`));
    assert.equal(validateSplats(data), 8385);
    assert.equal(data.sphericalHarmonics.length, 8385 * 27);
    for (const sample of samples) {
      const { i } = sample;
      assert.deepEqual(
        [...data.positions.subarray(i * 3, i * 3 + 3)],
        sample.positions,
        'bucket centre reconstruction',
      );
      for (let c = 0; c < 3; c++)
        assert.ok(
          Math.abs(data.colors[i * 4 + c] - linear(sample.colors[c] / 255)) < 1e-6,
          'display bytes become linear',
        );
      assert.equal(data.colors[i * 4 + 3], Math.fround(sample.colors[3] / 255));
      const scale = Math.max(sample.covariances[0], sample.covariances[3], sample.covariances[5]);
      // Half quaternion normalization and the existing Float32 covariance floor can move the raw rival covariance.
      for (let k = 0; k < 6; k++)
        assert.ok(
          Math.abs(data.covariances[i * 6 + k] - sample.covariances[k]) <= scale * 0.005 + 1e-29,
          'normalised half rotation covariance',
        );
      for (let j = 0; j < 8; j++)
        for (let c = 0; c < 3; c++)
          assert.ok(
            Math.abs(
              data.sphericalHarmonics[(i * 9 + j + 1) * 3 + c] - sample.sh[j * 3 + c] * slope(sample.colors[c] / 255),
            ) < 1e-6,
            'all SH bands and channels',
          );
    }
  });

test('KSplat section capacities, multiple sections, SH promotion and bounds rejection', () => {
  const original = fixture('raccoon-0.ksplat'),
    a = original.subarray(5120, 5120 + 140 * 2),
    file = Buffer.alloc(4096 + 2 * 1024 + 140 * 4);
  original.copy(file, 0, 0, 4096);
  file.writeUInt32LE(2, 4);
  file.writeUInt32LE(2, 8);
  file.writeUInt32LE(4, 12);
  file.writeUInt32LE(2, 16);
  for (let s = 0; s < 2; s++) {
    original.copy(file, 4096 + s * 1024, 4096, 5120);
    file.writeUInt32LE(1, 4096 + s * 1024);
    file.writeUInt32LE(2, 4100 + s * 1024);
    file.writeUInt32LE(280, 4124 + s * 1024);
    a.copy(file, 6144 + s * 280);
  }
  const data = parseKsplat(file);
  assert.equal(data.positions.length, 6);
  assert.deepEqual([...data.positions.subarray(0, 3)], [...data.positions.subarray(3)]);
  for (const [offset, value] of [
    [4, 100000],
    [16, 3],
    [20, 3],
    [4124, 1],
    [4136, 3],
  ]) {
    const broken = Buffer.from(file);
    broken.writeUInt32LE(value, offset);
    assert.throws(() => parseKsplat(broken), RangeError);
  }
  assert.throws(() => parseKsplat(original.subarray(0, -1)), /outside|complete/);
  const partial = Buffer.from(fixture('raccoon-1.ksplat'));
  partial.writeUInt32LE(0, 5120);
  assert.throws(() => parseKsplat(partial), /bucket/);
});

test('KSplat mixed SH sections preserve base colour and zero missing bands', () => {
  const original = fixture('raccoon-0.ksplat'),
    file = Buffer.alloc(6144 + 280 + 88);
  original.copy(file, 0, 0, 4096);
  file.writeUInt32LE(2, 4);
  file.writeUInt32LE(2, 8);
  file.writeUInt32LE(4, 12);
  file.writeUInt32LE(2, 16);
  for (let s = 0; s < 2; s++) {
    const h = 4096 + s * 1024;
    original.copy(file, h, 4096, 5120);
    file.writeUInt32LE(1, h);
    file.writeUInt32LE(2, h + 4);
    file.writeUInt32LE(s ? 88 : 280, h + 28);
    file.writeUInt16LE(s ? 0 : 2, h + 40);
  }
  original.copy(file, 6144, 5120, 5120 + 280);
  original.copy(file, 6144 + 280, 5120, 5120 + 44);
  const data = parseKsplat(file);
  assert.equal(validateSplats(data), 2);
  assert.equal(data.sphericalHarmonics.length, 54);
  assert.deepEqual([...data.sphericalHarmonics.subarray(30)], Array(24).fill(0));
  assert.deepEqual([...data.colors.subarray(0, 4)], [...data.colors.subarray(4)]);
});

function compressed({ degree = 3, ranges = true, count = 257 } = {}) {
  const bounds = [
    'min_x',
    'min_y',
    'min_z',
    'max_x',
    'max_y',
    'max_z',
    'min_scale_x',
    'min_scale_y',
    'min_scale_z',
    'max_scale_x',
    'max_scale_y',
    'max_scale_z',
    ...(ranges ? ['min_r', 'min_g', 'min_b', 'max_r', 'max_g', 'max_b'] : []),
  ];
  const rest = (degree + 1) ** 2 - 1,
    chunkCount = Math.ceil(count / 256);
  const header = Buffer.from(
    `ply\nformat binary_little_endian 1.0\nelement chunk ${chunkCount}\n${bounds.map((n) => `property float ${n}\n`).join('')}element vertex ${count}\nproperty uint packed_color\nproperty uint packed_scale\nproperty uint packed_rotation\nproperty uint packed_position\n${rest ? `element sh ${count}\n${Array.from({ length: rest * 3 }, (_, i) => `property uchar f_rest_${i}\n`).join('')}` : ''}end_header\n`,
  );
  const body = Buffer.alloc(chunkCount * bounds.length * 4 + count * 16 + count * rest * 3);
  for (let chunk = 0; chunk < chunkCount; chunk++)
    bounds.forEach((name, k) => {
      const value = name.includes('scale')
        ? -(['x', 'y', 'z'].indexOf(name.at(-1)) + 1)
        : /_[rgb]$/.test(name)
          ? name.startsWith('min_')
            ? 0.2
            : 0.8
          : chunk * 10 + (name.startsWith('min_') ? 0 : 2);
      body.writeFloatLE(value, (chunk * bounds.length + k) * 4);
    });
  const vertex = chunkCount * bounds.length * 4;
  for (let i = 0; i < count; i++) {
    body.writeUInt32LE(0xff8040cc, vertex + i * 16);
    body.writeUInt32LE(0, vertex + i * 16 + 4);
    body.writeUInt32LE((2 * 2 ** 30 + 600 * 2 ** 20 + 200 * 2 ** 10 + 800) >>> 0, vertex + i * 16 + 8);
    body.writeUInt32LE(i % 2 ? 0xffffffff : 0, vertex + i * 16 + 12);
  }
  for (let i = 0; i < count * rest * 3; i++) body[vertex + count * 16 + i] = i % 256;
  return Buffer.concat([header, body]);
}
for (const degree of [0, 1, 2, 3])
  for (const ranges of [false, true])
    test(`compressed PLY ${degree} SH, colour bounds ${ranges}`, () => {
      const data = parseCompressedPly(compressed({ degree, ranges }));
      assert.equal(validateSplats(data), 257);
      assert.deepEqual([...data.positions.subarray(0, 6)], [0, 0, 0, 2, 2, 2]);
      assert.deepEqual([...data.positions.subarray(256 * 3)], [10, 10, 10]);
      assert.equal(data.colors[3], Math.fround(0.8));
      const r = ranges ? 0.8 : 1;
      assert.ok(Math.abs(data.colors[0] - linear(r)) < 1e-6);
      if (degree) {
        assert.equal(data.sphericalHarmonics.length, 257 * (degree + 1) ** 2 * 3);
        assert.ok(data.sphericalHarmonics[3] < 0);
      } else assert.equal(data.sphericalHarmonics, undefined);
      const rest = (degree + 1) ** 2 - 1,
        w = (600 / 1023 - 0.5) * Math.SQRT2,
        x = (200 / 1023 - 0.5) * Math.SQRT2,
        z = (800 / 1023 - 0.5) * Math.SQRT2;
      const raw = {
        count: 257,
        positions: data.positions.slice(),
        logScales: Float32Array.from({ length: 257 * 3 }, (_, i) => -((i % 3) + 1)),
        rotations: Float32Array.from(
          { length: 257 * 4 },
          (_, i) => [w, x, Math.sqrt(1 - w * w - x * x - z * z), z][i % 4],
        ),
        dc: Float32Array.from({ length: 257 * 3 }, (_, i) => {
          const byte = [255, 128, 64][i % 3],
            a = ranges ? Math.fround(0.2) : 0,
            b = ranges ? Math.fround(0.8) : 1;
          return (a + ((b - a) * byte) / 255 - 0.5) / 0.2820947918;
        }),
        alphas: new Float32Array(257).fill(0.8),
        ...(rest
          ? {
              rest: Float32Array.from({ length: 257 * rest * 3 }, (_, i) => {
                const row = Math.floor(i / (rest * 3)),
                  j = Math.floor(i / 3) % rest,
                  c = i % 3,
                  code = (row * rest * 3 + c * rest + j) % 256;
                return code === 0 ? -4 : code === 255 ? 4 : ((code + 0.5) / 256 - 0.5) * 8;
              }),
            }
          : {}),
      };
      const expected = splatsFromAttributes(raw);
      for (const key of ['covariances', 'colors', 'sphericalHarmonics'])
        assert.deepEqual(data[key], expected[key], `${key} independent packed-word oracle`);
    });
test('compressed PLY malformed schemas, lengths, ranges and SH are rejected', () => {
  const file = compressed();
  assert.throws(() => parseCompressedPly(file.subarray(0, -1)), /length/);
  assert.throws(
    () =>
      parseCompressedPly(Buffer.from(file.toString('latin1').replace('packed_position', 'packed_posxxxxx'), 'latin1')),
    /missing/,
  );
  assert.throws(() => parseCompressedPly(new Uint8Array(10)), /header/);
});

test('compressed PLY byte offsets retain UTF-8 comment bytes and typed-array offsets', () => {
  const file = compressed({ degree: 2 }),
    commented = Buffer.concat([file.subarray(0, 4), Buffer.from('comment caf\u00e9\n'), file.subarray(4)]);
  const padded = Buffer.concat([Buffer.alloc(7), commented, Buffer.alloc(3)]);
  assert.deepEqual(parseCompressedPly(padded.subarray(7, padded.length - 3)), parseCompressedPly(file));
});

for (const format of ['binary_little_endian', 'ascii'])
  test(`PLY ${format} full SH and opacity endpoints round trip`, () => {
    const source = parsePly(fixture('raccoon-v2.ply')),
      out = parsePly(encodePly(source, { format }));
    assert.deepEqual(out.positions, source.positions);
    for (const key of ['colors', 'sphericalHarmonics'])
      for (let i = 0; i < source[key].length; i++)
        assert.ok(Math.abs(source[key][i] - out[key][i]) < 2e-6, `${key} float32 conversion`);
    for (let i = 0; i < source.covariances.length; i++)
      assert.ok(
        Math.abs(source.covariances[i] - out.covariances[i]) <
          Math.max(...source.covariances.subarray(Math.floor(i / 6) * 6, Math.floor(i / 6) * 6 + 6)) * 2e-6 + 1e-29,
        'covariance eigen round trip',
      );
    const raw = {
      count: 2,
      positions: new Float32Array(6),
      logScales: new Float32Array(6),
      rotations: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]),
      dc: new Float32Array(6),
      alphas: new Float32Array([0, 1]),
    };
    const endpoints = parsePly(encodePly(splatsFromAttributes(raw), { format }));
    assert.equal(endpoints.colors[3], 0);
    assert.equal(endpoints.colors[7], 1);
  });
