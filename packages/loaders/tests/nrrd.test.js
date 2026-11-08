// parseNRRD: every encoding, both byte orders, skips, detached data, axis layout, limits and refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
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
  await refuses(parseNRRD(text(head([...ok.slice(0, 3), 'encoding: bzip2']) + 'not bzip2')), 'zip');
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

test('a huge declared size stops before any allocation', async () => {
  const big = ['type: double', 'dimension: 3', 'sizes: 100000 100000 100000', 'encoding: raw', 'endian: little'];
  await refuses(parseNRRD(text(head(big))), 'limit');
  await refuses(parseNRRD(text(head(['type: uchar', 'dimension: 1', 'sizes: 9', 'encoding: raw'])), { maxSamples: 8 }), 'limit');
  await refuses(parseNRRD(new Uint8Array(0), { maxSamples: 1.5 }), 'range');
});

// Counts the bytes every DecompressionStream made gives out while `run` goes.
async function countInflated(run) {
  const Original = globalThis.DecompressionStream;
  let produced = 0;
  globalThis.DecompressionStream = class {
    constructor(format) {
      const inner = new Original(format);
      this.writable = inner.writable;
      this.readable = inner.readable.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            produced += chunk.length;
            controller.enqueue(chunk);
          },
        }),
      );
    }
  };
  try {
    return { result: await run(), produced: () => produced };
  } finally {
    globalThis.DecompressionStream = Original;
  }
}

// Format section 5: "Data file contents remaining after all data has been read should be ignored." A gzip stream longer
// than the header needs is read, not refused, and decoding stops once the samples are out (the zip-bomb bound).
test('gzip data past what the header needs is ignored, and decoding stops at the needed length', async () => {
  const bomb = join(head(['type: uchar', 'dimension: 1', 'sizes: 2', 'encoding: gz']), gzipSync(Buffer.alloc(64 << 20, 5)));
  const { result, produced } = await countInflated(() => parseNRRD(bomb));
  assert.deepEqual([...result.data], [5, 5]);
  assert.ok(produced() < 1 << 20, `inflated ${produced()} bytes of a 64 MiB stream for 2 samples`);
  const skipped = join(head(['type: uchar', 'dimension: 1', 'sizes: 2', 'encoding: gzip', 'byte skip: 1']), gzipSync(Buffer.from([0, 7, 8, 9, 9])));
  assert.deepEqual([...(await parseNRRD(skipped)).data], [7, 8]);
  const junk = join(head(['type: uchar', 'dimension: 1', 'sizes: 2', 'encoding: gzip']), gzipSync(Buffer.from([7, 8])), 'not gzip');
  assert.deepEqual([...(await parseNRRD(junk)).data], [7, 8]);
  await refuses(parseNRRD(join(head(['type: uchar', 'dimension: 1', 'sizes: 3', 'encoding: gzip']), gzipSync(Buffer.from([7, 8])))), 'truncated');
});

test('raw, hex and ascii data past what the header needs is ignored', async () => {
  const fields = ['type: uchar', 'dimension: 1', 'sizes: 2'];
  const raw = await parseNRRD(join(head([...fields, 'encoding: raw']), Buffer.from([7, 8, 9, 10])));
  const hex = await parseNRRD(text(`${head([...fields, 'encoding: hex'])}0708 ff zz trailing`));
  const ascii = await parseNRRD(text(`${head([...fields, 'encoding: ascii'])}7 8 9 junk`));
  for (const { data } of [raw, hex, ascii]) assert.deepEqual([...data], [7, 8]);
});

test('kinds, space and none compare case-insensitively', async () => {
  const volume = await parseNRRD(
    join(
      head(['type: uchar', 'dimension: 4', 'sizes: 3 2 2 2', 'kinds: RGB-COLOR Domain SPACE domain', 'encoding: raw']),
      Buffer.alloc(24),
    ),
  );
  assert.equal(volume.components, 3);
  assert.deepEqual(volume.dims, [2, 2, 2]);
  const directed = await parseNRRD(
    join(
      head(['type: uchar', 'dimension: 3', 'sizes: 3 2 2', 'encoding: raw', 'space: Left-Posterior-Superior', 'space directions: NONE (1,0,0) (0,1,0)']),
      Buffer.alloc(12),
    ),
  );
  assert.equal(directed.components, 3);
  assert.equal(directed.space, 'left-posterior-superior');
});

test('ascii floats follow section 2: nan anywhere, then -inf, then inf', async () => {
  const words = 'nan(0x1) -NaN 1e5nan INF -inf +Infinity -INFINITY xinfx 2.5';
  const { data } = await parseNRRD(text(`${head(['type: double', 'dimension: 1', 'sizes: 9', 'encoding: ascii'])}${words}`));
  assert.ok([...data.subarray(0, 3)].every(Number.isNaN));
  assert.deepEqual([...data.subarray(3)], [Infinity, -Infinity, Infinity, -Infinity, Infinity, 2.5]);
});

test('subdim sets how much data each file holds, and the file count must match it', async () => {
  const fields = ['type: uchar', 'dimension: 3', 'sizes: 2 2 2', 'encoding: raw'];
  const resolve = (each) => async (path) => new Uint8Array(Array.from({ length: each }, (_, k) => Number(path[1]) * each + k));
  const read = (data, each) => parseNRRD(text(head([...fields, `data file: ${data}`])), { resolve: resolve(each) });
  assert.deepEqual([...(await read('f%d.raw 0 1 1', 4)).data], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...(await read('f%d.raw 0 3 1 1', 2)).data], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...(await read('f%d.raw 0 1 1 3', 4)).data], [0, 1, 2, 3, 4, 5, 6, 7]);
  const list = (lines) => text(`NRRD0005\n${fields.join('\n')}\n${lines}\n`);
  assert.deepEqual([...(await parseNRRD(list('data file: LIST 3\nf0.raw\nf1.raw'), { resolve: resolve(4) })).data], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...(await parseNRRD(list('data file: LIST 1\nf0.raw\nf1.raw\nf2.raw\nf3.raw'), { resolve: resolve(2) })).data], [0, 1, 2, 3, 4, 5, 6, 7]);
  // The default is one slice along the slowest axis per file: four files of a 2 x 2 x 2 array do not fit it.
  await refuses(read('f%d.raw 0 3 1', 2), 'range');
  await refuses(parseNRRD(list('data file: LIST\nf0.raw\nf1.raw\nf2.raw\nf3.raw'), { resolve: resolve(2) }), 'range');
  await refuses(read('f%d.raw 0 2 1 3', 2), 'range');
  await refuses(read('f%d.raw 0 1 1 0', 4), 'range');
  await refuses(read('f%d.raw 0 1 1 4', 4), 'range');
  await refuses(parseNRRD(list('data file: LIST 4\nf0.raw\nf1.raw'), { resolve: resolve(4) }), 'range');
});

test('a data file pattern is formatted as sprintf would', async () => {
  const names = async (pattern, count) => {
    const asked = [];
    await parseNRRD(text(head(['type: uchar', 'dimension: 1', `sizes: ${count}`, 'encoding: raw', `data file: ${pattern}`])), {
      resolve: async (path) => (asked.push(path), new Uint8Array(1)),
    });
    return asked;
  };
  assert.deepEqual(await names('I.%03d -2 0 1', 3), ['I.-02', 'I.-01', 'I.000']);
  assert.deepEqual(await names('a%-3d| 1 1 1', 1), ['a1  |']);
  assert.deepEqual(await names('a%+d 1 1 1', 1), ['a+1']);
  assert.deepEqual(await names('a%5.3d 7 7 1', 1), ['a  007']);
  assert.deepEqual(await names('a%x.%%.raw 10 10 1', 1), ['aa.%.raw']);
  assert.deepEqual(await names('a%#06X 255 255 1', 1), ['a0X00FF']);
  assert.deepEqual(await names('a%o 8 8 1', 1), ['a10']);
  assert.deepEqual(await names('a%i 3 1 -2', 2), ['a3', 'a1']);
  await refuses(names('a%d%d 1 1 1', 1), 'syntax');
  await refuses(names('a%s 1 1 1', 1), 'syntax');
  await refuses(names('a%ld 1 1 1', 1), 'syntax');
});

test('byte skip -1 makes line skip moot', async () => {
  const fields = ['type: uchar', 'dimension: 1', 'sizes: 2', 'encoding: raw', 'line skip: 5', 'byte skip: -1'];
  assert.deepEqual([...(await parseNRRD(join(head(fields), 'no lines', Buffer.from([7, 8])))).data], [7, 8]);
});

test('only the magics NRRD0001 to NRRD0005 open, alone on their line', async () => {
  const body = 'type: uchar\ndimension: 1\nsizes: 1\nencoding: ascii\n\n1';
  for (const magic of ['NRRD0001', 'NRRD0005', 'NRRD00.01', 'NRRD0004\r'])
    assert.deepEqual([...(await parseNRRD(text(`${magic}\n${body}`))).data], [1]);
  for (const magic of ['NRRD0006', 'NRRD0000', 'NRRD0004 extra', 'NRRD00041', 'NRRDabcd'])
    await refuses(parseNRRD(text(`${magic}\n${body}`)), 'header');
});

test('a field or key/value pair newer than the magic is refused', async () => {
  const at = (version, extra, data = '1') =>
    parseNRRD(text(`NRRD000${version}\ntype: uchar\ndimension: 1\nsizes: 1\nencoding: ascii\n${extra}\n\n${data}`));
  await refuses(at(1, 'k:=v'), 'header');
  assert.equal((await at(2, 'k:=v')).meta.k, 'v');
  await refuses(at(2, 'kinds: domain'), 'header');
  assert.deepEqual([...(await at(3, 'kinds: domain')).data], [1]);
  await refuses(at(3, 'space: RAS'), 'header');
  await refuses(at(3, 'space dimension: 3'), 'header');
  await refuses(at(3, 'thicknesses: 1'), 'header');
  await refuses(at(3, 'sample units: mm'), 'header');
  await refuses(at(3, 'data file: s%d.raw 1 1 1'), 'header');
  await refuses(at(4, 'space: RAS\nmeasurement frame: (1,0,0) (0,1,0) (0,0,1)'), 'header');
  assert.equal((await at(4, 'space: RAS\nspace origin: (1,2,3)')).matrix[12], 1);
});

test('key/value escapes are only \\n and \\\\, in the key and the value', async () => {
  const { meta } = await parseNRRD(text(`${head(['type: uchar', 'dimension: 1', 'sizes: 1', 'encoding: ascii', 'a\\tb\\n:=x\\qy\\\\\\n'])}1`));
  assert.deepEqual(Object.entries(meta), [['a\\tb\n', 'x\\qy\\\n']]);
});

test('every space of section 4 is known, and an unknown one is refused', async () => {
  const at = (space, directions) =>
    parseNRRD(join(head(['type: uchar', 'dimension: 1', 'sizes: 1', 'encoding: raw', `space: ${space}`, `space directions: ${directions}`]), Buffer.alloc(1)));
  assert.equal((await at('scanner-xyz', '(1,0,0)')).space, 'scanner-xyz');
  assert.equal((await at('3d-right-handed', '(1,0,0)')).space, '3D-right-handed');
  assert.equal((await at('3D-LEFT-HANDED-TIME', '(1,0,0,0)')).space, '3D-left-handed-time');
  assert.equal((await at('LPST', '(1,0,0,0)')).space, 'left-posterior-superior-time');
  await refuses(at('mars', '(1,0,0)'), 'header');
  await refuses(at('3D-right-handed', '(1,0,0,0)'), 'syntax');
});

test('vectors refuse anything between or inside them', async () => {
  const at = (directions, origin = '(0,0,0)') =>
    parseNRRD(
      join(
        head(['type: uchar', 'dimension: 3', 'sizes: 1 1 1', 'encoding: raw', 'space: RAS', `space directions: ${directions}`, `space origin: ${origin}`]),
        Buffer.alloc(1),
      ),
    );
  assert.deepEqual((await at('(1,0,0)\t(0,1,0)  (0,0,1)')).spacing, [1, 1, 1]);
  await refuses(at('(1,0,0) junk (0,1,0) (0,0,1)'), 'syntax');
  await refuses(at('nonexistent (0,1,0) (0,0,1)'), 'syntax');
  await refuses(at('(1,0,0)(0,1,0) (0,0,1)'), 'syntax');
  await refuses(at('(1,0,0) (0,1,0) (0,0,1) none'), 'syntax');
  await refuses(at('(1,0,0) (0,1,0) (0,0,1)', '(0,0,0) (1,1,1)'), 'syntax');
  await refuses(at('(1,0,0) (0,1,0) (0,0,1)', 'none'), 'syntax');
  await refuses(at('(1,,0) (0,1,0) (0,0,1)'), 'syntax');
});

test('kinds, spacings and field order follow the per-axis rules', async () => {
  const at = (...extra) => parseNRRD(join(head(['type: uchar', 'dimension: 2', 'sizes: 4 2', 'encoding: raw', ...extra]), Buffer.alloc(8)));
  await refuses(at('kinds: RGB-color domain'), 'range');
  await refuses(at('kinds: 3D-matrix domain'), 'range');
  await refuses(at('kinds: colour domain'), 'syntax');
  assert.equal((await at('kinds: RGBA-color domain')).components, 4);
  assert.equal((await at('kinds: quaternion space')).components, 4);
  // A space direction and a known spacing, axis min or axis max exclude each other on the same axis.
  const directed = ['space dimension: 2', 'space directions: none (0,1)'];
  assert.deepEqual((await at(...directed, 'spacings: 2 nan')).spacing, [1, 1, 1]);
  await refuses(at(...directed, 'spacings: nan 2'), 'syntax');
  await refuses(at(...directed, 'axis mins: nan 0'), 'syntax');
  await refuses(at(...directed, 'axis maxs: NaN 1'), 'syntax');
  await refuses(at('spacings: 0 1'), 'range');
  await refuses(at('spacings: inf 1'), 'range');
  await refuses(at('spacings: 1 abc'), 'syntax');
  // Duplicate fields under their two spellings, and fields before what they depend on.
  await refuses(at('line skip: 0', 'lineskip: 0'), 'syntax');
  await refuses(at('byteskip: 0', 'byte skip: 0'), 'syntax');
  await refuses(at('centers: cell cell', 'centerings: cell cell'), 'syntax');
  await refuses(at('space origin: (0,0)', 'space dimension: 2'), 'syntax');
  await refuses(parseNRRD(join(head(['type: uchar', 'sizes: 2', 'dimension: 1', 'encoding: raw']), Buffer.alloc(2))), 'syntax');
});

test('a header past the limit stops, and an abort stops the read', async () => {
  await refuses(parseNRRD(text(`NRRD0004\n${'# comment line\n'.repeat(80_000)}`)), 'limit');
  const controller = new AbortController();
  controller.abort();
  await refuses(parseNRRD(text('NRRD0004\n'), { signal: controller.signal }), 'aborted');
});

test('a real bzip2 volume from pynrrd reads the same samples as its raw twin', async () => {
  const read = (name) => parseNRRD(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))),
    packed = await read('volume-bzip2.nrrd'),
    plain = await read('volume-raw.nrrd');
  assert.equal(packed.data.length, 24 * 16 * 8);
  assert.deepEqual([...packed.data], [...plain.data]);
  assert.deepEqual(packed.sizes, plain.sizes);
});

test('bzip2 data past what the header needs is ignored, and decoding stops at the needed length', async () => {
  // Section 2: data remaining after all data has been read is ignored. Reading 8 of the 3072 floats returns the first 8
  // samples; maxBytes in the decoder equals what the header needs, so nothing past them is ever inflated.
  const body = readFileSync(new URL('./fixtures/volume-bzip2.nrrd', import.meta.url)),
    at = body.indexOf('\n\n') + 2,
    short = head(['type: float', 'dimension: 1', 'sizes: 8', 'encoding: bzip2', 'endian: little']),
    plain = await parseNRRD(readFileSync(new URL('./fixtures/volume-raw.nrrd', import.meta.url)));
  const volume = await parseNRRD(join(short, body.subarray(at)));
  assert.deepEqual([...volume.data], [...plain.data.subarray(0, 8)]);
});
