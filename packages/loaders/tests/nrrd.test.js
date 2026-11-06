// parseNRRD: every encoding, both byte orders, skips, detached data, axis layout, limits and refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { parseNRRD } from '../dist/nrrd.js';
import { LoaderError } from '../dist/common.js';

const text = (value) => new TextEncoder().encode(value);
const join = (...parts) => Buffer.concat(parts.map((part) => (typeof part === 'string' ? text(part) : part)));
const head = (fields) => `NRRD0005\n${fields.join('\n')}\n\n`;
const refuses = (promise, code) =>
  assert.rejects(promise, (error) => error instanceof LoaderError && error.format === 'NRRD' && error.code === code);

test('raw samples read in either byte order', async () => {
  const fields = ['type: short', 'dimension: 1', 'sizes: 2', 'encoding: raw'];
  const little = await parseNRRD(join(head([...fields, 'endian: little']), Buffer.from([1, 0, 0xff, 0xff])));
  const big = await parseNRRD(join(head([...fields, 'endian: big']), Buffer.from([0, 1, 0xff, 0xff])));
  assert.ok(little.data instanceof Int16Array);
  assert.deepEqual([...little.data], [1, -1]);
  assert.deepEqual([...big.data], [1, -1]);
  assert.equal(little.type, 'int16');
});

test('raw data at an odd offset in the file still reads', async () => {
  const header = head(['type: float', 'dimension: 1', 'sizes: 1', 'encoding: raw', 'endian: little', '# odd']);
  const body = Buffer.alloc(4);
  body.writeFloatLE(1.5);
  const { data } = await parseNRRD(join(header, 'x'.repeat(0), body));
  assert.deepEqual([...data], [1.5]);
  const shifted = new Uint8Array(join('.', header, body)).subarray(1);
  assert.deepEqual([...(await parseNRRD(shifted)).data], [1.5]);
});

test('ascii, hex and gzip give the same samples', async () => {
  const fields = ['type: uint16', 'dimension: 1', 'sizes: 3', 'endian: little'];
  const raw = Buffer.from([1, 0, 2, 0, 0, 1]);
  const ascii = await parseNRRD(text(`${head([...fields, 'encoding: ascii'])}1, 2\n256\n`));
  const hex = await parseNRRD(text(`${head([...fields, 'encoding: hex'])}01 00 0200\n0001\n`));
  const gzip = await parseNRRD(join(head([...fields, 'encoding: gzip']), gzipSync(raw)));
  for (const { data } of [ascii, hex, gzip]) assert.deepEqual([...data], [1, 2, 256]);
});

test('ascii floats keep nan and inf; an ascii integer must be one', async () => {
  const floats = await parseNRRD(text(`${head(['type: double', 'dimension: 1', 'sizes: 3', 'encoding: text'])}nan inf -inf`));
  assert.ok(Number.isNaN(floats.data[0]));
  assert.deepEqual([...floats.data.subarray(1)], [Infinity, -Infinity]);
  await refuses(parseNRRD(text(`${head(['type: int', 'dimension: 1', 'sizes: 1', 'encoding: ascii'])}1.5`)), 'syntax');
  await refuses(parseNRRD(text(`${head(['type: float', 'dimension: 1', 'sizes: 1', 'encoding: ascii'])}abc`)), 'syntax');
});

test('64-bit integers arrive as doubles', async () => {
  const body = Buffer.alloc(16);
  body.writeBigInt64LE(-5n, 0);
  body.writeBigUInt64LE(2n ** 40n, 8);
  const fields = ['dimension: 1', 'sizes: 1', 'encoding: raw', 'endian: little'];
  const signed = await parseNRRD(join(head(['type: int64', ...fields]), body.subarray(0, 8)));
  const unsigned = await parseNRRD(join(head(['type: unsigned long long', ...fields]), body.subarray(8)));
  assert.ok(signed.data instanceof Float64Array);
  assert.deepEqual([...signed.data], [-5]);
  assert.deepEqual([...unsigned.data], [2 ** 40]);
});

test('line skip, byte skip and byte skip -1 find the samples', async () => {
  const fields = ['type: uchar', 'dimension: 1', 'sizes: 2', 'encoding: raw'];
  const lines = await parseNRRD(join(head([...fields, 'line skip: 2']), 'a\nb\n', Buffer.from([7, 8])));
  const bytes = await parseNRRD(join(head([...fields, 'byte skip: 3']), 'abc', Buffer.from([7, 8])));
  const end = await parseNRRD(join(head([...fields, 'byte skip: -1']), 'junk', Buffer.from([7, 8])));
  for (const { data } of [lines, bytes, end]) assert.deepEqual([...data], [7, 8]);
  const gz = ['type: uchar', 'dimension: 1', 'sizes: 2', 'encoding: gz', 'byte skip: 1'];
  assert.deepEqual([...(await parseNRRD(join(head(gz), gzipSync(Buffer.from([0, 7, 8]))))).data], [7, 8]);
  await refuses(parseNRRD(text(`${head(['type: uchar', 'dimension: 1', 'sizes: 1', 'encoding: hex', 'byte skip: -1'])}00`)), 'range');
});

test('a detached header reads its data through resolve', async () => {
  const fields = ['type: uchar', 'dimension: 2', 'sizes: 2 2', 'encoding: raw'];
  const one = text(head([...fields, 'data file: ./body.raw']).slice(0, -1));
  const asked = [];
  const { data } = await parseNRRD(one, {
    resolve: async (path) => (asked.push(path), new Uint8Array([1, 2, 3, 4])),
  });
  assert.deepEqual([...data], [1, 2, 3, 4]);
  assert.deepEqual(asked, ['body.raw']);
  await refuses(parseNRRD(one), 'unsupported');
});

test('a pattern and a LIST split the samples over many files', async () => {
  const fields = ['type: uchar', 'dimension: 2', 'sizes: 2 2', 'encoding: raw'];
  const files = { 'slice001.raw': [1, 2], 'slice003.raw': [3, 4], 'a.raw': [1, 2], 'b.raw': [3, 4] };
  const resolve = async (path) => new Uint8Array(files[path]);
  const pattern = text(head([...fields, 'data file: slice%03d.raw 1 3 2']));
  const list = text(`NRRD0005\n${[...fields, 'data file: LIST'].join('\n')}\na.raw\nb.raw\n`);
  assert.deepEqual([...(await parseNRRD(pattern, { resolve })).data], [1, 2, 3, 4]);
  assert.deepEqual([...(await parseNRRD(list, { resolve })).data], [1, 2, 3, 4]);
  await refuses(parseNRRD(text(head([...fields, 'data file: s%d.raw 1 3 1'])), { resolve }), 'range');
  await refuses(parseNRRD(text(head([...fields, 'data file: s%d.raw 3 1 1'])), { resolve }), 'range');
});

test('space directions set spacing, bounds and the voxel to space matrix', async () => {
  const volume = await parseNRRD(
    join(
      head([
        'type: uchar',
        'dimension: 3',
        'sizes: 2 3 4',
        'encoding: raw',
        'space: LPS',
        'space directions: (-2,0,0) (0,0.5,0) (0,0,3)',
        'space origin: (10,20,30)',
      ]),
      Buffer.alloc(24),
    ),
  );
  assert.deepEqual(volume.dims, [2, 3, 4]);
  assert.deepEqual(volume.spacing, [2, 0.5, 3]);
  assert.deepEqual(volume.bounds, [0, 2, 0, 1, 0, 9]);
  assert.equal(volume.space, 'left-posterior-superior');
  assert.deepEqual([...volume.matrix], [-2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 3, 0, 10, 20, 30, 1]);
});

test('spacings without a space scale the box, and a 2D file pads to three axes', async () => {
  const flat = await parseNRRD(
    join(head(['type: uchar', 'dimension: 2', 'sizes: 3 2', 'spacings: 2 NaN', 'encoding: raw']), Buffer.alloc(6)),
  );
  assert.deepEqual(flat.dims, [3, 2, 1]);
  assert.deepEqual(flat.spacing, [2, 1, 1]);
  assert.deepEqual(flat.bounds, [0, 4, 0, 1, 0, 0]);
  assert.deepEqual([...flat.matrix], [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
});

test('a leading RGB axis is components and a trailing time axis is frames', async () => {
  const byKinds = await parseNRRD(
    join(
      head(['type: uchar', 'dimension: 5', 'sizes: 3 2 2 2 4', 'kinds: RGB-color domain domain domain time', 'encoding: raw']),
      Buffer.alloc(96),
    ),
  );
  assert.equal(byKinds.components, 3);
  assert.equal(byKinds.frames, 4);
  assert.deepEqual(byKinds.dims, [2, 2, 2]);
  const byDirections = await parseNRRD(
    join(
      head([
        'type: uchar',
        'dimension: 3',
        'sizes: 3 2 2',
        'encoding: raw',
        'space dimension: 2',
        'space directions: none (2,0) (0,2)',
      ]),
      Buffer.alloc(12),
    ),
  );
  assert.equal(byDirections.components, 3);
  assert.deepEqual(byDirections.dims, [2, 2, 1]);
  assert.deepEqual(byDirections.spacing, [2, 2, 1]);
});

test('key value pairs and fields stay plain data, whatever the file calls them', async () => {
  const { meta, fields } = await parseNRRD(
    text(`${head(['type: uchar', 'dimension: 1', 'sizes: 1', 'encoding: ascii', 'content: a: b', '__proto__:=x', 'note:=one\\ntwo\\\\', 'constructor: y'])}1`),
  );
  assert.equal(Object.getPrototypeOf(meta), null);
  assert.equal(meta.__proto__, 'x');
  assert.equal(meta.note, 'one\ntwo\\');
  assert.equal(fields.content, 'a: b');
  assert.equal(fields.constructor, 'y');
  assert.equal({}.x, undefined);
});

test('bad files are named errors', async () => {
  const ok = ['type: uchar', 'dimension: 1', 'sizes: 2', 'encoding: raw'];
  await refuses(parseNRRD(text('PLY\n')), 'header');
  await refuses(parseNRRD(text('NRRD0004')), 'truncated');
  await refuses(parseNRRD(text(head(ok.slice(1)))), 'header');
  await refuses(parseNRRD(text(head(['type: quaternion', ...ok.slice(1)]))), 'header');
  await refuses(parseNRRD(text(head(['type: block', ...ok.slice(1)]))), 'unsupported');
  await refuses(parseNRRD(text(head(['type: short', ...ok.slice(1)]))), 'header');
  await refuses(parseNRRD(text(head([...ok.slice(0, 3), 'encoding: bzip2']))), 'unsupported');
  await refuses(parseNRRD(text(head([...ok.slice(0, 3), 'encoding: zstd']))), 'header');
  await refuses(parseNRRD(text(head(['type: uchar', 'dimension: 17', 'sizes: 1', 'encoding: raw']))), 'range');
  await refuses(parseNRRD(text(head(['type: uchar', 'dimension: 2', 'sizes: 2', 'encoding: raw']))), 'syntax');
  await refuses(parseNRRD(text(head(['type: uchar', 'dimension: 1', 'sizes: 0', 'encoding: raw']))), 'range');
  await refuses(parseNRRD(text(head([...ok, 'type: uchar']))), 'syntax');
  await refuses(parseNRRD(text(head([...ok, 'no separator here']))), 'syntax');
  await refuses(parseNRRD(text(head(ok))), 'truncated');
  await refuses(parseNRRD(text(head([...ok, 'line skip: 3']))), 'truncated');
  await refuses(parseNRRD(text(head([...ok, 'space: RAS', 'space dimension: 3']))), 'syntax');
  await refuses(parseNRRD(text(head([...ok, 'space directions: (1,0,0)']))), 'syntax');
  await refuses(parseNRRD(text(head([...ok, 'space: RAS', 'space directions: (1,0)']))), 'syntax');
  await refuses(parseNRRD(text(head([...ok, 'space: RAS', 'space directions: (0,0,0)']))), 'range');
  await refuses(parseNRRD(text(`${head([...ok.slice(0, 3), 'encoding: hex'])}zz zz`)), 'syntax');
  await refuses(parseNRRD(text(`${head([...ok.slice(0, 3), 'encoding: hex'])}00`)), 'truncated');
  await refuses(parseNRRD(text(`${head([...ok.slice(0, 3), 'encoding: ascii'])}1`)), 'truncated');
});

test('a huge declared size stops before any allocation, and gzip cannot grow past the header', async () => {
  const big = ['type: double', 'dimension: 3', 'sizes: 100000 100000 100000', 'encoding: raw', 'endian: little'];
  await refuses(parseNRRD(text(head(big))), 'limit');
  await refuses(parseNRRD(text(head(['type: uchar', 'dimension: 1', 'sizes: 9', 'encoding: raw'])), { maxSamples: 8 }), 'limit');
  await refuses(parseNRRD(new Uint8Array(0), { maxSamples: 1.5 }), 'range');
  const bomb = join(head(['type: uchar', 'dimension: 1', 'sizes: 2', 'encoding: gz']), gzipSync(Buffer.alloc(1 << 20)));
  await refuses(parseNRRD(bomb), 'zip');
});

test('a header past the limit stops, and an abort stops the read', async () => {
  await refuses(parseNRRD(text(`NRRD0004\n${'# comment line\n'.repeat(80_000)}`)), 'limit');
  const controller = new AbortController();
  controller.abort();
  await refuses(parseNRRD(text('NRRD0004\n'), { signal: controller.signal }), 'aborted');
});
