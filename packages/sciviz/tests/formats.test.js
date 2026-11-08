import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync, gzipSync, gunzipSync, deflateSync } from 'node:zlib';
import { parseNIfTI, parseDICOM, dicomSeries, openZarr, zarrGrid, volumeFromGrid } from '@margoengine/sciviz/formats';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const code = (c) => (error) => error.code === c;

// ------------------------------------------------------------------------------------------------------------ NIfTI

test('a real big-endian NIfTI-1 statistics map (FSL zstat1, gzip) reads its grid, sizes and sform', async () => {
  const image = await parseNIfTI(fixture('zstat1.nii.gz'));
  assert.equal(image.version, 1);
  assert.deepEqual(image.dims, [64, 64, 21]);
  assert.equal(image.datatype, 16);
  assert.ok(image.data instanceof Float32Array);
  assert.equal(image.data.length, 64 * 64 * 21);
  // The same samples read by hand from the gunzipped file, big endian at vox_offset.
  const raw = gunzipSync(fixture('zstat1.nii.gz')),
    view = new DataView(raw.buffer, raw.byteOffset),
    offset = view.getFloat32(108, false);
  for (const i of [0, 1000, 40000, 64 * 64 * 21 - 1]) assert.equal(image.data[i], view.getFloat32(offset + i * 4, false));
  assert.deepEqual(image.spacing, [4, 4, 6]);
  assert.ok(image.range[0] < 0 && image.range[1] > 0, `range ${image.range}`);
});

// A NIfTI-1 or -2 header written field by field from the format's definition (a stand-in, not a tool's file).
function nifti({ version = 1, little = true, dims = [2, 2, 2], datatype = 4, bitpix = 16, slope = 0, inter = 0, qform, sform, pixdim = [1, 1, 1, 1], magic, data }) {
  const size = version === 1 ? 348 : 540,
    offset = version === 1 ? 352 : 544,
    bytes = new Uint8Array(offset + data.byteLength),
    v = new DataView(bytes.buffer);
  v.setInt32(0, size, little);
  const put = (o, s) => [...s].forEach((ch, k) => (bytes[o + k] = ch.charCodeAt(0)));
  if (version === 1) {
    v.setInt16(40, dims.length, little);
    dims.forEach((d, k) => v.setInt16(42 + k * 2, d, little));
    v.setInt16(70, datatype, little);
    v.setInt16(72, bitpix, little);
    pixdim.forEach((p, k) => v.setFloat32(76 + k * 4, p, little));
    v.setFloat32(108, offset, little);
    v.setFloat32(112, slope, little);
    v.setFloat32(116, inter, little);
    bytes[123] = 2 | 8;
    if (qform) {
      v.setInt16(252, 1, little);
      qform.quat.forEach((q, k) => v.setFloat32(256 + k * 4, q, little));
      qform.offset.forEach((q, k) => v.setFloat32(268 + k * 4, q, little));
    }
    if (sform) {
      v.setInt16(254, 1, little);
      sform.forEach((row, r) => row.forEach((x, c) => v.setFloat32(280 + r * 16 + c * 4, x, little)));
    }
    put(344, magic ?? 'n+1');
  } else {
    put(4, magic ?? 'n+2');
    v.setInt16(12, datatype, little);
    v.setInt16(14, bitpix, little);
    v.setBigInt64(16, BigInt(dims.length), little);
    dims.forEach((d, k) => v.setBigInt64(24 + k * 8, BigInt(d), little));
    pixdim.forEach((p, k) => v.setFloat64(104 + k * 8, p, little));
    v.setBigInt64(168, BigInt(offset), little);
    v.setFloat64(176, slope, little);
    v.setFloat64(184, inter, little);
    if (sform) {
      v.setInt32(348, 1, little);
      sform.forEach((row, r) => row.forEach((x, c) => v.setFloat64(400 + r * 32 + c * 8, x, little)));
    }
    v.setInt32(500, 2 | 8, little);
  }
  bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
  return bytes;
}

test('NIfTI-2, scaling, qform rotation with qfac and the sform win as the definition orders', async () => {
  const two = await parseNIfTI(nifti({ version: 2, dims: [2, 1, 1], datatype: 16, bitpix: 32, data: new Float32Array([1.5, -2]) }));
  assert.equal(two.version, 2);
  assert.deepEqual([...two.data], [1.5, -2]);
  assert.deepEqual(two.units, { space: 'mm', time: 's' });
  const scaled = await parseNIfTI(nifti({ slope: 2, inter: -10, data: new Int16Array([0, 1, 2, 3, 4, 5, 6, 7]) }));
  assert.deepEqual([...scaled.data], [-10, -8, -6, -4, -2, 0, 2, 4]);
  // A quarter turn about z (b = c = 0, d = sin 45 degrees) with qfac -1 flips k.
  const s = Math.SQRT1_2;
  const q = await parseNIfTI(
    nifti({ pixdim: [-1, 2, 3, 4], qform: { quat: [0, 0, s], offset: [10, 20, 30] }, data: new Int16Array(8) }),
  );
  assert.equal(q.transform, 'qform');
  const m = [...q.matrix].map((x) => Math.round(x * 1e5) / 1e5 + 0);
  assert.deepEqual(m, [0, 2, 0, 0, -3, 0, 0, 0, 0, 0, -4, 0, 10, 20, 30, 1]);
  const both = await parseNIfTI(
    nifti({ qform: { quat: [0, 0, s], offset: [0, 0, 0] }, sform: [[1, 0, 0, 5], [0, 2, 0, 6], [0, 0, 3, 7]], data: new Int16Array(8) }),
  );
  assert.equal(both.transform, 'sform');
  assert.deepEqual([...both.matrix], [1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 5, 6, 7, 1]);
  const big = await parseNIfTI(gzipSync(nifti({ little: false, dims: [2, 1, 1, 3], datatype: 512, data: be16([1, 2, 3, 4, 5, 6]) })));
  assert.equal(big.frames, 3);
  assert.deepEqual([...big.data], [1, 2]);
  assert.deepEqual([...big.all], [1, 2, 3, 4, 5, 6]);
});

const be16 = (values) => {
  const out = new Uint8Array(values.length * 2),
    v = new DataView(out.buffer);
  values.forEach((x, k) => v.setUint16(k * 2, x, false));
  return out;
};

test('a .hdr and .img pair reads the image through resolve; bad files are coded errors', async () => {
  const header = nifti({ magic: 'ni1', data: new Uint8Array(0) }).subarray(0, 348);
  // In a pair, vox_offset is the image's offset inside the .img file: 0 here.
  new DataView(header.buffer, header.byteOffset).setFloat32(108, 0, true);
  const img = new Int16Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const asked = [];
  const pair = await parseNIfTI(header, {
    name: 'brain.hdr',
    resolve: async (path) => (asked.push(path), new Uint8Array(img.buffer)),
  });
  assert.deepEqual(asked, ['brain.img']);
  assert.deepEqual([...pair.data], [1, 2, 3, 4, 5, 6, 7, 8]);
  await assert.rejects(parseNIfTI(header), TypeError);
  await assert.rejects(parseNIfTI(new Uint8Array(100)), RangeError);
  await assert.rejects(parseNIfTI(nifti({ datatype: 32, bitpix: 64, data: new Float32Array(16) })), code('unsupported'));
  await assert.rejects(parseNIfTI(nifti({ dims: [1000, 1000, 1000], data: new Int16Array(1) })), RangeError);
  await assert.rejects(parseNIfTI(nifti({ data: new Int16Array(3) })), RangeError);
});

// ------------------------------------------------------------------------------------------------------------ DICOM

test('real pydicom CT and MR slices read their size, rescale and geometry', async () => {
  const ct = await parseDICOM(fixture('CT_small.dcm'));
  assert.equal(ct.rows, 128);
  assert.equal(ct.columns, 128);
  assert.equal(ct.modality, 'CT');
  assert.equal(ct.transferSyntax, '1.2.840.10008.1.2.1');
  assert.ok(ct.data instanceof Float32Array, 'rescaled to Hounsfield units');
  assert.equal(ct.data.length, 128 * 128);
  assert.deepEqual(ct.elements['00281052'], [-1024]);
  assert.ok(ct.position && ct.orientation);
  // The stored sample plus the intercept, read by hand at the pixel data.
  const raw = fixture('CT_small.dcm'),
    at = raw.lastIndexOf(Buffer.from([0xe0, 0x7f, 0x10, 0x00])) + 12;
  assert.equal(ct.data[5000], raw.readInt16LE(at + 5000 * 2) - 1024);
  const mr = await parseDICOM(fixture('MR_small.dcm'));
  assert.equal(mr.rows, 64);
  assert.equal(mr.modality, 'MR');
});

test('one MR image in explicit little, implicit little and explicit big endian reads the same pixels', async () => {
  const little = await parseDICOM(fixture('MR_small.dcm')),
    implicit = await parseDICOM(fixture('MR_small_implicit.dcm')),
    big = await parseDICOM(fixture('MR_small_bigendian.dcm'));
  assert.equal(implicit.transferSyntax, '1.2.840.10008.1.2');
  assert.equal(big.transferSyntax, '1.2.840.10008.1.2.2');
  assert.deepEqual([...implicit.data], [...little.data]);
  assert.deepEqual([...big.data], [...little.data]);
  assert.deepEqual(big.pixelSpacing, little.pixelSpacing);
});

test('compressed pixel data is refused naming its transfer syntax', async () => {
  await assert.rejects(parseDICOM(fixture('MR_small_RLE.dcm')), (error) => error.code === 'unsupported' && /1\.2\.840\.10008\.1\.2\.5/.test(error.message));
});

// A DICOM file written element by element (a stand-in): explicit VR little endian meta, then the data set.
function dicom({ syntax = '1.2.840.10008.1.2.1', rows = 2, columns = 2, position, orientation = [1, 0, 0, 0, 1, 0], instance, series = '1.2.3', pixels, deflate = false, frames, sequence = false }) {
  const parts = [];
  const el = (g, e, vr, value, little = true) => {
    const body = typeof value === 'string' ? Buffer.from(value.length % 2 ? `${value}${vr === 'UI' ? '\0' : ' '}` : value, 'latin1') : Buffer.from(value);
    const long = ['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr);
    const head = Buffer.alloc(long ? 12 : 8);
    head.writeUInt16LE(g, 0);
    head.writeUInt16LE(e, 2);
    head.write(vr, 4, 'latin1');
    if (long) head.writeUInt32LE(body.length, 8);
    else head.writeUInt16LE(body.length, 6);
    return Buffer.concat([head, body]);
  };
  const us = (v) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
  };
  const meta = Buffer.concat([el(0x0002, 0x0010, 'UI', syntax)]);
  const body = [];
  if (sequence) {
    // A sequence and an item of undefined length, which the reader must skip to its delimiters.
    const head = Buffer.alloc(12);
    head.writeUInt16LE(0x0008, 0);
    head.writeUInt16LE(0x1140, 2);
    head.write('SQ', 4, 'latin1');
    head.writeUInt32LE(0xffffffff, 8);
    const item = Buffer.from([0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff]);
    const inner = el(0x0008, 0x1150, 'UI', '1.2');
    const itemEnd = Buffer.from([0xfe, 0xff, 0x0d, 0xe0, 0, 0, 0, 0]);
    const seqEnd = Buffer.from([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]);
    body.push(Buffer.concat([head, item, inner, itemEnd, seqEnd]));
  }
  body.push(el(0x0008, 0x0060, 'CS', 'MR'));
  if (position) body.push(el(0x0020, 0x0032, 'DS', position.join('\\')));
  body.push(el(0x0020, 0x000e, 'UI', series));
  if (instance !== undefined) body.push(el(0x0020, 0x0013, 'IS', String(instance)));
  body.push(el(0x0020, 0x0037, 'DS', orientation.join('\\')));
  if (frames) body.push(el(0x0028, 0x0008, 'IS', String(frames)));
  body.push(el(0x0028, 0x0010, 'US', us(rows)), el(0x0028, 0x0011, 'US', us(columns)));
  body.push(el(0x0028, 0x0030, 'DS', '0.5\\0.25'), el(0x0028, 0x0100, 'US', us(16)), el(0x0028, 0x0103, 'US', us(0)));
  body.push(el(0x7fe0, 0x0010, 'OW', Buffer.from(new Uint16Array(pixels).buffer)));
  let data = Buffer.concat(body);
  if (deflate) data = deflateRawSync(data);
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), meta, data]);
}

test('a deflated file and a skipped undefined-length sequence read like the plain file', async () => {
  const plain = await parseDICOM(dicom({ pixels: [1, 2, 3, 4], sequence: true }));
  assert.deepEqual([...plain.data], [1, 2, 3, 4]);
  const deflated = await parseDICOM(dicom({ syntax: '1.2.840.10008.1.2.1.99', pixels: [1, 2, 3, 4], deflate: true }));
  assert.deepEqual([...deflated.data], [1, 2, 3, 4]);
  assert.deepEqual(deflated.pixelSpacing, [0.5, 0.25]);
});

test('dicomSeries orders slices by position along the normal, spaces them and builds the patient matrix', async () => {
  // Shuffled slices of a sagittal-free axial stack 2 mm apart; the normal of the default orientation is +z.
  const slices = await Promise.all(
    [4, 0, 2].map((z, k) => parseDICOM(dicom({ position: [-5, 7, z], instance: k, pixels: [z, z, z, z + 1] }))),
  );
  const volume = dicomSeries(slices);
  assert.deepEqual(volume.dims, [2, 2, 3]);
  assert.deepEqual([...volume.data], [0, 0, 0, 1, 2, 2, 2, 3, 4, 4, 4, 5]);
  assert.deepEqual(volume.spacing, [0.25, 0.5, 2]);
  assert.deepEqual(volume.bounds, [0, 0.25, 0, 0.5, 0, 4]);
  assert.deepEqual([...volume.matrix], [0.25, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 2, 0, -5, 7, 0, 1]);
  const other = await parseDICOM(dicom({ position: [0, 0, 6], series: '9.9', pixels: [0, 0, 0, 0] }));
  assert.throws(() => dicomSeries([...slices, other]), RangeError);
  // A multi-frame image stacks its frames.
  const multi = await parseDICOM(dicom({ frames: 2, pixels: [1, 2, 3, 4, 5, 6, 7, 8] }));
  assert.equal(multi.frames, 2);
  assert.deepEqual(dicomSeries([multi]).dims, [2, 2, 2]);
});

// ------------------------------------------------------------------------------------------------------------- Zarr

// Zarr stores written key by key from the v2 and v3 specifications (stand-ins).
const json = (value) => JSON.stringify(value);
const f32 = (values) => new Uint8Array(new Float32Array(values).buffer);

test('a chunked Zarr v2 array with zlib reads whole, as a box, and with a missing chunk as its fill value', async () => {
  // shape [3, 4], chunks [2, 3]: four chunks, chunk (1, 1) missing.
  const full = Array.from({ length: 12 }, (_, i) => i);
  const chunk = (r, c) => {
    const out = new Float32Array(6).fill(0);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) {
      const y = r * 2 + i, x = c * 3 + j;
      out[i * 3 + j] = y < 3 && x < 4 ? full[y * 4 + x] : 0;
    }
    return deflateSync(new Uint8Array(out.buffer));
  };
  const store = {
    'a/.zarray': json({ zarr_format: 2, shape: [3, 4], chunks: [2, 3], dtype: '<f4', compressor: { id: 'zlib', level: 1 }, fill_value: -1, order: 'C', filters: null }),
    'a/.zattrs': json({ units: 'K' }),
    'a/0.0': chunk(0, 0),
    'a/0.1': chunk(0, 1),
    'a/1.0': chunk(1, 0),
  };
  const array = await openZarr(store, 'a');
  assert.equal(array.zarrFormat, 2);
  assert.deepEqual(array.attributes, { units: 'K' });
  const { data, shape } = await array.read();
  assert.deepEqual(shape, [3, 4]);
  assert.deepEqual([...data], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, -1]);
  const box = await array.read({ start: [1, 1], stop: [3, 3] });
  assert.deepEqual([...box.data], [5, 6, 9, 10]);
  await assert.rejects(array.read({ start: [0, 0], stop: [4, 4] }), RangeError);
});

test('a Zarr v3 array with gzip, crc32c and big-endian bytes reads; a damaged chunk fails its check', async () => {
  const be = new Uint8Array(8),
    v = new DataView(be.buffer);
  [1, 2, 3, 4].forEach((x, k) => v.setInt16(k * 2, x, false));
  // CRC-32C of the gzipped chunk, little endian, from the Castagnoli polynomial (worked here independently).
  const crc = (bytes) => {
    let c = ~0;
    for (const b of bytes) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const packed = gzipSync(be),
    tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, crc(packed), true);
  const chunk = new Uint8Array([...packed, ...tail]);
  const meta = json({
    zarr_format: 3,
    node_type: 'array',
    shape: [2, 2],
    data_type: 'int16',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [2, 2] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 0,
    codecs: [{ name: 'bytes', configuration: { endian: 'big' } }, { name: 'gzip', configuration: { level: 1 } }, { name: 'crc32c' }],
    dimension_names: ['y', 'x'],
  });
  const array = await openZarr({ 'zarr.json': meta, 'c/0/0': chunk });
  assert.equal(array.zarrFormat, 3);
  assert.deepEqual(array.dimensionNames, ['y', 'x']);
  assert.deepEqual([...(await array.read()).data], [1, 2, 3, 4]);
  const bad = chunk.slice();
  bad[12] ^= 1;
  const damaged = await openZarr({ 'zarr.json': meta, 'c/0/0': bad });
  await assert.rejects(damaged.read(), (error) => error.code === 'failed');
  // A transposed chunk (stored x-major) comes back in C order.
  const transposed = await openZarr({
    'zarr.json': json({ ...JSON.parse(meta), data_type: 'float32', codecs: [{ name: 'transpose', configuration: { order: [1, 0] } }, { name: 'bytes', configuration: { endian: 'little' } }] }),
    'c/0/0': f32([1, 3, 2, 4]),
  });
  assert.deepEqual([...(await transposed.read()).data], [1, 2, 3, 4]);
  await assert.rejects(
    openZarr({ 'zarr.json': json({ ...JSON.parse(meta), codecs: [{ name: 'bytes' }, { name: 'blosc' }] }) }),
    (error) => error.code === 'unsupported' && /blosc/.test(error.message),
  );
});

test('zarrGrid makes a volume of the last three dimensions and volumeFromGrid hands it to fig.volume', async () => {
  const store = {
    '.zarray': json({ zarr_format: 2, shape: [1, 2, 2, 3], chunks: [1, 2, 2, 3], dtype: '<f4', compressor: null, fill_value: 0, order: 'C', filters: null }),
    '0.0.0.0': f32(Array.from({ length: 12 }, (_, i) => i)),
  };
  const array = await openZarr(store);
  const grid = zarrGrid(await array.read(), [0.5, 1, 2]);
  assert.deepEqual(grid.dims, [3, 2, 2]);
  assert.deepEqual(grid.bounds, [0, 1, 0, 1, 0, 2]);
  assert.deepEqual(grid.range, [0, 11]);
  const calls = [];
  volumeFromGrid({ volume: (data, options) => (calls.push(options), {}) }, grid, { colormap: 'viridis' });
  assert.deepEqual(calls[0].dims, [3, 2, 2]);
  assert.deepEqual(calls[0].range, [0, 11]);
});
