// Regression tests from the spec reviews of @margoengine/sciviz/formats: each input is written byte by byte here from
// the DICOM (PS3.3, PS3.5, PS3.10), NIfTI (nifti1.h, nifti2.h) and Zarr (v2, v3.1) texts, plus real Zarr stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { parseNIfTI, parseDICOM, dicomSeries, openZarr, zarrGrid } from '@margoengine/sciviz/formats';

const code = (c) => (error) => error.code === c;

// ------------------------------------------------------------------------------------------------------------ DICOM

const SHORT = [
  'AE',
  'AS',
  'AT',
  'CS',
  'DA',
  'DS',
  'DT',
  'FL',
  'FD',
  'IS',
  'LO',
  'LT',
  'PN',
  'SH',
  'SL',
  'SS',
  'ST',
  'TM',
  'UI',
  'UL',
  'US',
];
const UNDEFINED = 0xffffffff;

/** One element: explicit VR in either byte order, or implicit VR little endian. */
function el(g, e, vr, body, { little = true, explicit = true, length } = {}) {
  const long = !SHORT.includes(vr),
    head = Buffer.alloc(explicit && long ? 12 : 8),
    n = length ?? body.length;
  const w16 = (o, v) => (little ? head.writeUInt16LE(v, o) : head.writeUInt16BE(v, o));
  const w32 = (o, v) => (little ? head.writeUInt32LE(v, o) : head.writeUInt32BE(v, o));
  w16(0, g);
  w16(2, e);
  if (!explicit) w32(4, n);
  else {
    head.write(vr, 4, 'latin1');
    if (long) w32(8, n);
    else w16(6, n);
  }
  return Buffer.concat([head, body]);
}
const str = (s, pad = ' ') => Buffer.from(s.length % 2 ? s + pad : s, 'latin1');
const u16 = (values, little = true) => {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, k) => (little ? b.writeUInt16LE(v & 0xffff, k * 2) : b.writeUInt16BE(v & 0xffff, k * 2)));
  return b;
};
const tagAt = (g, e, little = true) => u16([g, e], little);
const item = (body, length = body.length) =>
  Buffer.concat([Buffer.from([0xfe, 0xff, 0x00, 0xe0]), Buffer.from(new Uint32Array([length]).buffer), body]);
const ITEM_END = Buffer.from([0xfe, 0xff, 0x0d, 0xe0, 0, 0, 0, 0]);
const SEQ_END = Buffer.from([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]);

/** The image elements of a 2 x 2 (or rows x columns) image, then `extra`, then the pixel data. */
function image({
  little = true,
  rows = 2,
  columns = 2,
  bits = 16,
  stored,
  high,
  signed = 0,
  samples,
  photometric,
  planar,
  frames,
  extra = [],
  pixels,
  vr = 'OW',
  pixelTag = [0x7fe0, 0x0010],
}) {
  const o = { little };
  const parts = [el(0x0008, 0x0060, 'CS', str('MR'), o)];
  if (samples) parts.push(el(0x0028, 0x0002, 'US', u16([samples], little), o));
  if (photometric) parts.push(el(0x0028, 0x0004, 'CS', str(photometric), o));
  if (planar !== undefined) parts.push(el(0x0028, 0x0006, 'US', u16([planar], little), o));
  if (frames) parts.push(el(0x0028, 0x0008, 'IS', str(String(frames)), o));
  parts.push(el(0x0028, 0x0010, 'US', u16([rows], little), o), el(0x0028, 0x0011, 'US', u16([columns], little), o));
  parts.push(el(0x0028, 0x0100, 'US', u16([bits], little), o));
  if (stored !== undefined) parts.push(el(0x0028, 0x0101, 'US', u16([stored], little), o));
  if (high !== undefined) parts.push(el(0x0028, 0x0102, 'US', u16([high], little), o));
  parts.push(el(0x0028, 0x0103, 'US', u16([signed], little), o), ...extra);
  parts.push(el(pixelTag[0], pixelTag[1], vr, pixels, o));
  return Buffer.concat(parts);
}

/** A Part 10 file: preamble and DICM (or only the meta group), a meta group with its group length, then `body`. */
function file(body, { syntax = '1.2.840.10008.1.2.1', preamble = true, groupLength = true } = {}) {
  let meta = el(0x0002, 0x0010, 'UI', str(syntax, '\0'));
  if (groupLength)
    meta = Buffer.concat([el(0x0002, 0x0000, 'UL', Buffer.from(new Uint32Array([meta.length]).buffer)), meta]);
  return Buffer.concat([
    preamble ? Buffer.concat([Buffer.alloc(128), Buffer.from('DICM')]) : Buffer.alloc(0),
    meta,
    body,
  ]);
}
const BIG = '1.2.840.10008.1.2.2',
  DEFLATED = '1.2.840.10008.1.2.1.99';

test('DICOM: Bits Stored and High Bit mask the stored value and sign-extend it before the rescale (PS3.5 8.1.1)', async () => {
  const masked = await parseDICOM(file(image({ stored: 12, high: 11, pixels: u16([0xf123, 0x0fff, 0x1000, 0x0001]) })));
  assert.deepEqual([...masked.data], [0x123, 0xfff, 0, 1]);
  const signedValues = await parseDICOM(
    file(image({ stored: 12, high: 11, signed: 1, pixels: u16([0x0fff, 0x0800, 0xf7ff, 0x0005]) })),
  );
  assert.deepEqual([...signedValues.data], [-1, -2048, 2047, 5]);
  // A high bit above Bits Stored - 1 (older files): the value sits in the top bits.
  const shifted = await parseDICOM(
    file(image({ stored: 12, high: 15, pixels: u16([0xabc0, 0x0010, 0xfff0, 0x000f]) })),
  );
  assert.deepEqual([...shifted.data], [0xabc, 1, 0xfff, 0]);
  const rescaled = await parseDICOM(
    file(
      image({
        stored: 12,
        high: 11,
        extra: [el(0x0028, 0x1052, 'DS', str('10')), el(0x0028, 0x1053, 'DS', str('1'))],
        pixels: u16([0xf005, 0, 0, 0]),
      }),
    ),
  );
  assert.deepEqual([...rescaled.data], [15, 10, 10, 10]);
  await assert.rejects(parseDICOM(file(image({ stored: 17, pixels: u16([0, 0, 0, 0]) }))), RangeError);
});

test('DICOM: a deflated data set of odd length takes its single NUL pad byte, and nothing else may follow (PS3.5 A.5)', async () => {
  let deflated, pixels;
  for (let seed = 0; !deflated; seed++) {
    pixels = [seed, seed * 7, 3, 4];
    const d = deflateRawSync(image({ pixels: u16(pixels) }));
    if (d.length % 2) deflated = d;
  }
  const padded = await parseDICOM(file(Buffer.concat([deflated, Buffer.from([0])]), { syntax: DEFLATED }));
  assert.deepEqual([...padded.data], pixels);
  assert.deepEqual([...(await parseDICOM(file(deflated, { syntax: DEFLATED }))).data], pixels);
  await assert.rejects(
    parseDICOM(file(Buffer.concat([deflated, Buffer.from([0, 0])]), { syntax: DEFLATED })),
    RangeError,
  );
  await assert.rejects(parseDICOM(file(Buffer.concat([deflated, Buffer.from([1])]), { syntax: DEFLATED })), RangeError);
  let even;
  for (let seed = 0; !even; seed++) {
    const d = deflateRawSync(image({ pixels: u16([seed, 9, 9, 9]) }));
    if (d.length % 2 === 0) even = d;
  }
  await assert.rejects(parseDICOM(file(Buffer.concat([even, Buffer.from([0])]), { syntax: DEFLATED })), RangeError);
});

// A raw DEFLATE stream whose first two bytes read as group 0002 little endian: an empty fixed block (0x02 0x00 holds
// its header and end-of-block code), then the data set in a stored block, an empty stored block and a final one.
function deflateStartingWith0002(body) {
  const stored = (data, final) =>
    Buffer.concat([Buffer.from([final ? 1 : 0]), u16([data.length, ~data.length & 0xffff]), data]);
  return Buffer.concat([
    Buffer.from([0x02, 0x00]),
    u16([body.length, ~body.length & 0xffff]),
    body,
    stored(Buffer.alloc(0), false),
    stored(Buffer.alloc(0), true),
  ]);
}

test('DICOM: the meta group ends where (0002,0000) says, not where the group number changes (PS3.10 7.1)', async () => {
  const stream = deflateStartingWith0002(image({ pixels: u16([1, 2, 3, 4]) }));
  assert.equal(stream.readUInt16LE(0), 0x0002);
  assert.equal(stream.length % 2, 0);
  const read = await parseDICOM(file(stream, { syntax: DEFLATED }));
  assert.deepEqual([...read.data], [1, 2, 3, 4]);
});

test('DICOM: an explicit VR outside the 16-bit length list uses the 32-bit length form (PS3.5 7.1.2)', async () => {
  const unknown = el(0x0011, 0x1010, 'XX', Buffer.from('ABCD'));
  assert.equal(unknown.length, 16);
  const read = await parseDICOM(file(Buffer.concat([unknown, image({ pixels: u16([1, 2, 3, 4]) })])));
  assert.deepEqual([...read.data], [1, 2, 3, 4]);
});

test('DICOM: UN of undefined length holds implicit VR little endian items in any syntax (PS3.5 6.2.2)', async () => {
  for (const little of [true, false]) {
    const inner = Buffer.concat([
      tagAt(0x0011, 0x1021),
      Buffer.from(new Uint32Array([10]).buffer),
      Buffer.from('1.2.3.4.5\0'),
    ]);
    const un = Buffer.concat([
      el(0x0011, 0x1020, 'UN', Buffer.alloc(0), { little, length: UNDEFINED }),
      item(inner, UNDEFINED),
      ITEM_END,
      SEQ_END,
    ]);
    const read = await parseDICOM(
      file(Buffer.concat([un, image({ little, pixels: u16([1, 2, 3, 4], little) })]), {
        syntax: little ? undefined : BIG,
      }),
    );
    assert.deepEqual([...read.data], [1, 2, 3, 4], little ? 'little' : 'big');
  }
});

test('DICOM: a known tag sent as UN reads with its dictionary VR, little endian (PS3.5 6.2.2)', async () => {
  const body = image({ pixels: u16([1, 2, 3, 4]) });
  // Rows (0028,0010) as UN instead of US, in an explicit VR little endian and a big endian file.
  const rows = el(0x0028, 0x0010, 'US', u16([2]));
  const asUN = Buffer.concat([
    body.subarray(0, body.indexOf(rows)),
    el(0x0028, 0x0010, 'UN', u16([2])),
    body.subarray(body.indexOf(rows) + rows.length),
  ]);
  assert.equal((await parseDICOM(file(asUN))).rows, 2);
  const bigBody = image({ little: false, pixels: u16([1, 2, 3, 4], false) }),
    bigRows = el(0x0028, 0x0010, 'US', u16([2], false), { little: false });
  const bigUN = Buffer.concat([
    bigBody.subarray(0, bigBody.indexOf(bigRows)),
    el(0x0028, 0x0010, 'UN', u16([2]), { little: false }),
    bigBody.subarray(bigBody.indexOf(bigRows) + bigRows.length),
  ]);
  const big = await parseDICOM(file(bigUN, { syntax: BIG }));
  assert.equal(big.rows, 2);
  assert.deepEqual([...big.data], [1, 2, 3, 4]);
});

test('DICOM: explicit VR big endian swaps 8-bit OW pixel bytes in 16-bit words and refuses 32-bit OW (PS3.5 2016b A.3)', async () => {
  const ow = await parseDICOM(
    file(image({ little: false, bits: 8, pixels: Buffer.from([2, 1, 4, 3]) }), { syntax: BIG }),
  );
  assert.deepEqual([...ow.data], [1, 2, 3, 4]);
  const ob = await parseDICOM(
    file(image({ little: false, bits: 8, vr: 'OB', pixels: Buffer.from([1, 2, 3, 4]) }), { syntax: BIG }),
  );
  assert.deepEqual([...ob.data], [1, 2, 3, 4]);
  await assert.rejects(
    parseDICOM(file(image({ little: false, bits: 32, pixels: Buffer.alloc(16) }), { syntax: BIG })),
    code('unsupported'),
  );
});

test('DICOM: empty DS and IS values are no value, and an empty entry of a list is not 0', async () => {
  const read = await parseDICOM(
    file(
      image({
        extra: [
          el(0x0018, 0x0050, 'DS', Buffer.alloc(0)),
          el(0x0020, 0x0013, 'IS', Buffer.alloc(0)),
          el(0x0020, 0x0032, 'DS', str('1\\\\3')),
        ],
        pixels: u16([1, 2, 3, 4]),
      }),
    ),
  );
  assert.equal(read.sliceThickness, undefined);
  assert.equal(read.instanceNumber, undefined);
  assert.equal(read.position, undefined);
  assert.deepEqual(read.elements['00180050'], []);
  assert.ok(Number.isNaN(read.elements['00200032'][1]));
});

test('DICOM: native YBR_FULL_422 expands two Y values sharing one CB and CR to three samples a pixel (PS3.3 C.7.6.3.1.2)', async () => {
  const read = await parseDICOM(
    file(
      image({
        rows: 1,
        columns: 4,
        bits: 8,
        samples: 3,
        photometric: 'YBR_FULL_422',
        planar: 0,
        vr: 'OB',
        pixels: Buffer.from([10, 11, 100, 200, 12, 13, 101, 201]),
      }),
    ),
  );
  assert.equal(read.samplesPerPixel, 3);
  assert.equal(read.photometric, 'YBR_FULL_422');
  assert.deepEqual([...read.data], [10, 100, 200, 11, 100, 200, 12, 101, 201, 13, 101, 201]);
  await assert.rejects(
    parseDICOM(
      file(
        image({
          rows: 1,
          columns: 3,
          bits: 8,
          samples: 3,
          photometric: 'YBR_FULL_422',
          planar: 0,
          vr: 'OB',
          pixels: Buffer.alloc(6),
        }),
      ),
    ),
    code('unsupported'),
  );
});

test('DICOM: Float Pixel Data (OF) and Double Float Pixel Data (OD) read as floats (PS3.5 8.2)', async () => {
  const floats = new Float32Array([1.5, -2, 0.25, 1e30]);
  const of = await parseDICOM(
    file(image({ bits: 32, vr: 'OF', pixelTag: [0x7fe0, 0x0008], pixels: Buffer.from(floats.buffer) })),
  );
  assert.ok(of.data instanceof Float32Array);
  assert.deepEqual([...of.data], [...floats]);
  const doubles = new Float64Array([1e-300, -0.5, Math.PI, 7]);
  const od = await parseDICOM(
    file(image({ bits: 64, vr: 'OD', pixelTag: [0x7fe0, 0x0009], pixels: Buffer.from(doubles.buffer) })),
  );
  assert.ok(od.data instanceof Float64Array);
  assert.deepEqual([...od.data], [...doubles]);
  const be = Buffer.alloc(16);
  floats.forEach((v, k) => be.writeFloatBE(v, k * 4));
  const big = await parseDICOM(
    file(image({ little: false, bits: 32, vr: 'OF', pixelTag: [0x7fe0, 0x0008], pixels: be }), { syntax: BIG }),
  );
  assert.deepEqual([...big.data], [...floats]);
});

test('DICOM: a Modality LUT Sequence maps stored values, clamped below the first and past the last (PS3.3 C.11.1.1.1)', async () => {
  const descriptor = el(0x0028, 0x3002, 'US', u16([4, 10, 16])),
    data = el(0x0028, 0x3006, 'US', u16([100, 200, 300, 400])),
    entry = item(Buffer.concat([descriptor, data]));
  const sequence = el(0x0028, 0x3000, 'SQ', entry);
  const read = await parseDICOM(file(image({ extra: [sequence], pixels: u16([5, 10, 12, 20]) })));
  assert.deepEqual([...read.data], [100, 100, 300, 400]);
  // Signed stored values, an SS descriptor with first value -2, 8-bit entries packed two to an OW word, undefined lengths.
  const packed = Buffer.concat([
    el(0x0028, 0x3002, 'SS', u16([3, -2, 8])),
    el(0x0028, 0x3006, 'OW', Buffer.from([7, 8, 9, 0])),
  ]);
  const open = Buffer.concat([
    el(0x0028, 0x3000, 'SQ', Buffer.alloc(0), { length: UNDEFINED }),
    item(packed, UNDEFINED),
    ITEM_END,
    SEQ_END,
  ]);
  const signed = await parseDICOM(file(image({ signed: 1, extra: [open], pixels: u16([-5, -1, 0, 7]) })));
  assert.ok(signed.data instanceof Uint8Array);
  assert.deepEqual([...signed.data], [7, 8, 9, 9]);
  await assert.rejects(
    parseDICOM(file(image({ extra: [sequence, el(0x0028, 0x1052, 'DS', str('-1024'))], pixels: u16([0, 0, 0, 0]) }))),
    RangeError,
  );
});

test('DICOM: dicomSeries takes Spacing Between Slices before Slice Thickness as the step', async () => {
  const slice = (instance) =>
    parseDICOM(
      file(
        image({
          extra: [
            el(0x0018, 0x0050, 'DS', str('5')),
            el(0x0018, 0x0088, 'DS', str('3')),
            el(0x0020, 0x000e, 'UI', str('1.2', '\0')),
            el(0x0020, 0x0013, 'IS', str(String(instance))),
          ],
          pixels: u16([instance, 0, 0, 0]),
        }),
      ),
    );
  const volume = dicomSeries(await Promise.all([slice(2), slice(1)]));
  assert.equal(volume.spacing[2], 3);
  assert.deepEqual([...volume.data.subarray(0, 5)], [1, 0, 0, 0, 2]);
});

test('DICOM: frames named by a time Frame Increment Pointer become time steps; others are not stacked (PS3.3 C.7.6.6)', async () => {
  const at = (g, e) => el(0x0028, 0x0009, 'AT', tagAt(g, e));
  const timed = (z, pointer = at(0x0018, 0x1063)) =>
    parseDICOM(
      file(
        image({
          frames: 2,
          extra: [
            el(0x0018, 0x1063, 'DS', str('40')),
            pointer,
            el(0x0020, 0x0032, 'DS', str(`0\\0\\${z}`)),
            el(0x0020, 0x0037, 'DS', str('1\\0\\0\\0\\1\\0')),
          ],
          pixels: u16([z, z, z, z, z + 100, z + 100, z + 100, z + 100]),
        }),
      ),
    );
  const one = await timed(0);
  const cine = dicomSeries([one]);
  assert.equal(cine.frames, 2);
  assert.deepEqual(cine.dims, [2, 2, 1]);
  assert.deepEqual(one.frameIncrementPointer, ['00181063']);
  assert.deepEqual([...cine.all], [0, 0, 0, 0, 100, 100, 100, 100]);
  // Two slices, each with two time frames: all is ((t * nz + z) * ny + y) * nx + x.
  const both = dicomSeries(await Promise.all([timed(2), timed(0)]));
  assert.deepEqual(both.dims, [2, 2, 2]);
  assert.equal(both.frames, 2);
  assert.deepEqual([...both.all], [0, 0, 0, 0, 2, 2, 2, 2, 100, 100, 100, 100, 102, 102, 102, 102]);
  assert.equal(both.spacing[2], 2);
  // Per-frame functional groups (5200,9230) describe each frame's place; this reader does not read them.
  const grouped = await timed(0, at(0x5200, 0x9230));
  assert.throws(() => dicomSeries([grouped]), code('unsupported'));
});

test('DICOM: a file that starts at its meta group (no preamble, no DICM) honours its transfer syntax (PS3.10 7.1)', async () => {
  const deflated = deflateRawSync(image({ pixels: u16([1, 2, 3, 4]) }));
  const pad = deflated.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  const read = await parseDICOM(file(Buffer.concat([deflated, pad]), { syntax: DEFLATED, preamble: false }));
  assert.equal(read.transferSyntax, DEFLATED);
  assert.deepEqual([...read.data], [1, 2, 3, 4]);
  const big = await parseDICOM(
    file(image({ little: false, pixels: u16([1, 2, 3, 4], false) }), { syntax: BIG, preamble: false }),
  );
  assert.equal(big.transferSyntax, BIG);
  assert.deepEqual([...big.data], [1, 2, 3, 4]);
  // A bare data set keeps the documented guess: explicit VR little endian from the two letters of a VR.
  const bare = await parseDICOM(image({ pixels: u16([5, 6, 7, 8]) }));
  assert.equal(bare.transferSyntax, '1.2.840.10008.1.2.1');
  assert.deepEqual([...bare.data], [5, 6, 7, 8]);
});

// ------------------------------------------------------------------------------------------------------------ NIfTI

function nifti({
  version = 1,
  little = true,
  dims = [2, 2, 2],
  datatype = 4,
  bitpix = 16,
  slope = 0,
  inter = 0,
  magic,
  data,
}) {
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
    v.setFloat32(108, offset, little);
    v.setFloat32(112, slope, little);
    v.setFloat32(116, inter, little);
    put(344, magic ?? 'n+1');
  } else {
    put(4, magic ?? 'n+2');
    bytes.set([0x0d, 0x0a, 0x1a, 0x0a], 8);
    v.setInt16(12, datatype, little);
    v.setInt16(14, bitpix, little);
    v.setBigInt64(16, BigInt(dims.length), little);
    dims.forEach((d, k) => v.setBigInt64(24 + k * 8, BigInt(d), little));
    v.setBigInt64(168, BigInt(offset), little);
    v.setFloat64(176, slope, little);
    v.setFloat64(184, inter, little);
  }
  bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
  return bytes;
}
const eight = new Int16Array([1, 2, 3, 4, 5, 6, 7, 8]);

test('NIfTI: a vox_offset below 352 (544 for NIfTI-2) in a .nii means 352 (544); a non-finite one is refused', async () => {
  const one = nifti({ data: eight });
  new DataView(one.buffer).setFloat32(108, 348, true);
  one.fill(0x7f, 348, 352);
  assert.deepEqual([...(await parseNIfTI(one)).data], [...eight]);
  const two = nifti({ version: 2, data: eight });
  new DataView(two.buffer).setBigInt64(168, 540n, true);
  two.fill(0x7f, 540, 544);
  assert.deepEqual([...(await parseNIfTI(two)).data], [...eight]);
  for (const bad of [NaN, Infinity]) {
    const file = nifti({ data: eight });
    new DataView(file.buffer).setFloat32(108, bad, true);
    await assert.rejects(parseNIfTI(file), RangeError);
  }
});

test('NIfTI: the magic ends in NUL, matches the header size, and NIfTI-2 carries 0D 0A 1A 0A', async () => {
  const unterminated = nifti({ data: eight });
  unterminated[347] = 0x58;
  await assert.rejects(parseNIfTI(unterminated), RangeError);
  await assert.rejects(parseNIfTI(nifti({ magic: 'n+2', data: eight })), RangeError);
  await assert.rejects(parseNIfTI(nifti({ version: 2, magic: 'n+1', data: eight })), RangeError);
  const converted = nifti({ version: 2, data: eight });
  converted.set([0x0d, 0x0d, 0x0a, 0x1a], 8);
  await assert.rejects(parseNIfTI(converted), RangeError);
});

test('NIfTI: bitpix must match the datatype', async () => {
  await assert.rejects(parseNIfTI(nifti({ datatype: 4, bitpix: 8, data: eight })), RangeError);
  await assert.rejects(
    parseNIfTI(nifti({ datatype: 128, bitpix: 8, dims: [2, 1, 1], data: new Uint8Array(6) })),
    RangeError,
  );
});

test('NIfTI: RGB24 and RGBA32 data is never scaled (nifti1.h)', async () => {
  const rgb = await parseNIfTI(
    nifti({ datatype: 128, bitpix: 24, dims: [2, 1, 1], slope: 2, inter: 1, data: new Uint8Array([1, 2, 3, 4, 5, 6]) }),
  );
  assert.ok(rgb.all instanceof Uint8Array);
  assert.deepEqual([...rgb.all], [1, 2, 3, 4, 5, 6]);
  const rgba = await parseNIfTI(
    nifti({ datatype: 2304, bitpix: 32, dims: [1, 1, 1], slope: 2, inter: 1, data: new Uint8Array([9, 8, 7, 6]) }),
  );
  assert.deepEqual([...rgba.all], [9, 8, 7, 6]);
});

test('NIfTI: a gzipped .img with a vox_offset inflates the offset and the image together', async () => {
  const header = nifti({ magic: 'ni1', data: new Uint8Array(0) }).subarray(0, 348);
  new DataView(header.buffer, header.byteOffset).setFloat32(108, 16, true);
  const img = new Uint8Array(16 + 16);
  img.fill(0xee, 0, 16);
  img.set(new Uint8Array(eight.buffer), 16);
  const pair = await parseNIfTI(header, { name: 'brain.hdr', resolve: async () => gzipSync(img) });
  assert.deepEqual([...pair.data], [...eight]);
});

// ------------------------------------------------------------------------------------------------------------- Zarr

const json = (value) => JSON.stringify(value);
const crc32c = (bytes) => {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
  }
  return ~c >>> 0;
};
const withCrc = (bytes) => {
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(crc32c(bytes));
  return Buffer.concat([bytes, tail]);
};
const i16 = (values) => Buffer.from(new Int16Array(values).buffer);
const v3 = (fields = {}) => ({
  zarr_format: 3,
  node_type: 'array',
  shape: [2, 2],
  data_type: 'int16',
  chunk_grid: { name: 'regular', configuration: { chunk_shape: [2, 2] } },
  chunk_key_encoding: { name: 'default' },
  fill_value: 0,
  codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
  ...fields,
});
const read3 = async (fields, chunks = { 'c/0/0': i16([1, 2, 3, 4]) }) => [
  ...(await (await openZarr({ 'zarr.json': json(v3(fields)), ...chunks })).read()).data,
];
const v2 = (fields = {}) =>
  json({
    zarr_format: 2,
    shape: [2],
    chunks: [2],
    dtype: '<i2',
    compressor: null,
    fill_value: 0,
    order: 'C',
    filters: null,
    ...fields,
  });

test('Zarr: storage transformers and unknown metadata fields are refused unless must_understand is false', async () => {
  await assert.rejects(read3({ storage_transformers: [{ name: 'cache' }] }), code('unsupported'));
  assert.deepEqual(await read3({ storage_transformers: [] }), [1, 2, 3, 4]);
  await assert.rejects(read3({ extra_field: 1 }), code('unsupported'));
  assert.deepEqual(await read3({ extra_field: { must_understand: false } }), [1, 2, 3, 4]);
});

test('Zarr: v3.1 short-hand names; unknown chunk key encodings are refused; separators are "/" or "."', async () => {
  assert.deepEqual(
    await read3(
      { codecs: ['bytes'], data_type: 'uint8', chunk_key_encoding: 'v2' },
      { '0.0': Buffer.from([1, 2, 3, 4]) },
    ),
    [1, 2, 3, 4],
  );
  await assert.rejects(read3({ chunk_key_encoding: { name: 'hashed' } }), code('unsupported'));
  await assert.rejects(
    read3({ chunk_key_encoding: { name: 'default', configuration: { separator: '-' } } }),
    RangeError,
  );
  await assert.rejects(openZarr({ '.zarray': v2({ dimension_separator: '_' }) }), RangeError);
});

test('Zarr: transpose codecs compose in order', async () => {
  // shape [2, 3, 4]: encode by the transpose definition B[pos] = A[pos o order], twice.
  const shape = [2, 3, 4],
    a = Int16Array.from({ length: 24 }, (_, i) => i);
  const transpose = (values, from, order) => {
    const to = order.map((d) => from[d]),
      out = new Int16Array(values.length);
    const stride = (s) => s.map((_, d) => s.slice(d + 1).reduce((x, y) => x * y, 1));
    const sa = stride(from),
      sb = stride(to);
    for (let i = 0; i < values.length; i++) {
      const pos = from.map((n, d) => Math.floor(i / sa[d]) % n);
      out[order.reduce((acc, d, k) => acc + pos[d] * sb[k], 0)] = values[i];
    }
    return [out, to];
  };
  const [b, shapeB] = transpose(a, shape, [1, 2, 0]),
    [c] = transpose(b, shapeB, [1, 2, 0]);
  const meta = {
    shape,
    chunk_grid: { name: 'regular', configuration: { chunk_shape: shape } },
    codecs: [
      { name: 'transpose', configuration: { order: [1, 2, 0] } },
      { name: 'transpose', configuration: { order: [1, 2, 0] } },
      { name: 'bytes', configuration: { endian: 'little' } },
    ],
  };
  assert.deepEqual(await read3(meta, { 'c/0/0/0': Buffer.from(c.buffer) }), [...a]);
});

test('Zarr: each bytes-to-bytes decode step gets its own size: crc32c then gzip reads', async () => {
  const chunk = gzipSync(withCrc(i16([1, 2, 3, 4])));
  const codecs = [
    { name: 'bytes', configuration: { endian: 'little' } },
    { name: 'crc32c' },
    { name: 'gzip', configuration: { level: 1 } },
  ];
  assert.deepEqual(await read3({ codecs }, { 'c/0/0': chunk }), [1, 2, 3, 4]);
});

test('Zarr: zarr_format is checked in both versions', async () => {
  await assert.rejects(read3({ zarr_format: 2 }), RangeError);
  await assert.rejects(openZarr({ '.zarray': v2({ zarr_format: 3 }) }), RangeError);
});

test('Zarr: the codec chain has exactly one bytes codec in its place, and bytes gives a valid endian when it matters', async () => {
  const bytes = { name: 'bytes', configuration: { endian: 'little' } };
  for (const codecs of [
    [],
    [bytes, bytes],
    [{ name: 'gzip' }, bytes],
    [bytes, { name: 'transpose', configuration: { order: [1, 0] } }],
    [{ name: 'gzip' }],
  ])
    await assert.rejects(read3({ codecs }), RangeError, json(codecs));
  await assert.rejects(read3({ codecs: [{ name: 'bytes' }] }), RangeError);
  await assert.rejects(read3({ codecs: [{ name: 'bytes', configuration: { endian: 'middle' } }] }), RangeError);
  assert.deepEqual(
    await read3({ data_type: 'uint8', codecs: [{ name: 'bytes' }] }, { 'c/0/0': Buffer.from([4, 3, 2, 1]) }),
    [4, 3, 2, 1],
  );
});

test('Zarr: fill values are checked against the data type, and v3 needs one', async () => {
  for (const [data_type, fill_value] of [
    ['int8', 200],
    ['uint8', 1.5],
    ['uint8', -1],
    ['bool', 1],
    ['float32', '0x7fc0'],
    ['float64', '0x7fc00000'],
    ['int16', 'NaN'],
    ['int16', null],
  ])
    await assert.rejects(read3({ data_type, fill_value }), RangeError, `${data_type} ${fill_value}`);
  const meta = v3();
  delete meta.fill_value;
  await assert.rejects(openZarr({ 'zarr.json': json(meta) }), RangeError);
  assert.ok(
    Number.isNaN(
      (await openZarr({ 'zarr.json': json(v3({ data_type: 'float64', fill_value: '0x7ff8000000000000' })) })).fillValue,
    ),
  );
  assert.equal(
    (await openZarr({ 'zarr.json': json(v3({ data_type: 'float32', fill_value: '0x3f800000' })) })).fillValue,
    1,
  );
  assert.equal(
    (await openZarr({ 'zarr.json': json(v3({ data_type: 'bool', fill_value: true, codecs: ['bytes'] })) })).fillValue,
    1,
  );
  await assert.rejects(openZarr({ '.zarray': v2({ fill_value: 70000 }) }), RangeError);
});

test('Zarr: a data type looked up through the prototype (toString) is a coded unsupported error', async () => {
  for (const data_type of ['toString', 'constructor', '__proto__'])
    await assert.rejects(read3({ data_type }), code('unsupported'), data_type);
});

test('Zarr: v2 paths are normalised and "." or ".." segments raise RangeError', async () => {
  const store = { 'a/b/.zarray': v2(), 'a/b/0': i16([7, 8]) };
  assert.deepEqual([...(await (await openZarr(store, '\\a//b/')).read()).data], [7, 8]);
  await assert.rejects(
    openZarr({ '../x/.zarray': v2() }, '../x'),
    (error) => error instanceof RangeError && /segment/.test(error.message),
  );
  await assert.rejects(
    openZarr(store, 'a/./b'),
    (error) => error instanceof RangeError && /segment/.test(error.message),
  );
});

test('Zarr: dimension_names has one entry per dimension; v2 order, dtype byte order and separators are checked', async () => {
  await assert.rejects(read3({ dimension_names: ['y'] }), RangeError);
  await assert.rejects(read3({ dimension_names: ['y', 3] }), RangeError);
  await assert.rejects(openZarr({ '.zarray': v2({ order: 'K' }) }), RangeError);
  await assert.rejects(openZarr({ '.zarray': v2({ dtype: '|u2' }) }), RangeError);
  assert.equal((await openZarr({ '.zarray': v2({ dtype: '|u1' }) })).dtype, 'uint8');
});

test('Zarr: malformed metadata gives coded errors, not raw TypeErrors', async () => {
  for (const fields of [
    { chunk_grid: { name: 'regular' } },
    { codecs: [null] },
    { chunk_grid: 7 },
    { shape: 'big' },
    { attributes: [] },
  ])
    await assert.rejects(read3(fields), RangeError, json(fields));
  await assert.rejects(openZarr({ 'zarr.json': '[1, 2]' }), RangeError);
  await assert.rejects(openZarr({ '.zarray': v2({ compressor: {} }) }), RangeError);
  await assert.rejects(openZarr({ '.zarray': json({ zarr_format: 2 }) }), RangeError);
});

test('Zarr: a multi-member gzip chunk decodes every member (RFC 1952 2.2)', async () => {
  const raw = i16([1, 2, 3, 4]),
    chunk = Buffer.concat([gzipSync(raw.subarray(0, 3)), gzipSync(raw.subarray(3))]);
  assert.deepEqual(
    await read3(
      { codecs: [{ name: 'bytes', configuration: { endian: 'little' } }, { name: 'gzip' }] },
      { 'c/0/0': chunk },
    ),
    [1, 2, 3, 4],
  );
  await assert.rejects(
    read3(
      { codecs: [{ name: 'bytes', configuration: { endian: 'little' } }, { name: 'gzip' }] },
      { 'c/0/0': Buffer.concat([gzipSync(raw), Buffer.from([0])]) },
    ),
    RangeError,
  );
});

test('Zarr: a chunk longer than its shape and data type give is refused', async () => {
  const array = await openZarr({ '.zarray': v2(), 0: i16([1, 2, 3]) });
  await assert.rejects(array.read(), RangeError);
  await assert.rejects(read3({}, { 'c/0/0': i16([1, 2, 3, 4, 5]) }), RangeError);
});

test('Zarr: bool chunks hold only the bytes 0 and 1 (bytes codec)', async () => {
  const codecs = [{ name: 'bytes' }];
  await assert.rejects(
    read3({ data_type: 'bool', fill_value: false, codecs }, { 'c/0/0': Buffer.from([0, 1, 2, 0]) }),
    RangeError,
  );
  assert.deepEqual(
    await read3({ data_type: 'bool', fill_value: false, codecs }, { 'c/0/0': Buffer.from([0, 1, 1, 0]) }),
    [0, 1, 1, 0],
  );
});

test('zarrGrid range is the smallest and largest finite sample', async () => {
  const grid = zarrGrid({ data: new Float32Array([1, Infinity, -Infinity, 3, NaN, 2]), shape: [6] });
  assert.deepEqual(grid.range, [1, 3]);
  assert.deepEqual(zarrGrid({ data: new Float32Array([NaN, Infinity]), shape: [2] }).range, [0, 0]);
});

// Serves a folder, or an object of paths to bytes, on a free local port; `answers` gives a status for some paths.
async function serve(source, answers = {}) {
  const files = typeof source === 'string' ? storeOf(source) : source;
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url.split('?')[0]);
    if (answers[path]) return void response.writeHead(answers[path]).end();
    const body = files[path.slice(1)];
    if (body === undefined) return void response.writeHead(404).end();
    response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
// Every file under a folder, keyed by its path from the folder with "/".
function storeOf(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full).split('\\').join('/')] = new Uint8Array(readFileSync(full));
    }
  };
  walk(root);
  return out;
}
const ZARR = fileURLToPath(new URL('./fixtures/zarr/', import.meta.url));

test('Zarr over HTTP: only 404 is a missing chunk; 403 and server errors fail with code failed', async () => {
  const files = { 'zarr.json': json(v3()) };
  for (const status of [403, 500]) {
    const server = await serve(files, { '/c/0/0': status });
    try {
      await assert.rejects((await openZarr(server.base)).read(), code('failed'), String(status));
    } finally {
      await server.close();
    }
  }
  const server = await serve(files);
  try {
    assert.deepEqual([...(await (await openZarr(server.base)).read()).data], [0, 0, 0, 0]);
  } finally {
    await server.close();
  }
});

test('real Zarr v2 store: the zarr_implementations astronaut (gzip, 108 chunks) reads its known samples', async () => {
  const root = join(ZARR, 'v2-astronaut'),
    server = await serve(root);
  try {
    for (const store of [storeOf(root), server.base]) {
      const array = await openZarr(store, 'gzip');
      assert.deepEqual(array.shape, [512, 512, 3]);
      assert.deepEqual(array.chunks, [100, 100, 1]);
      assert.equal(array.dtype, 'uint8');
      const { data, shape } = await array.read();
      assert.deepEqual(shape, [512, 512, 3]);
      const at = (y, x, c) => data[(y * 512 + x) * 3 + c];
      assert.deepEqual(
        [at(0, 0, 0), at(0, 0, 1), at(0, 0, 2), at(100, 200, 0), at(256, 256, 1), at(511, 511, 2), at(305, 47, 0)],
        [154, 147, 151, 81, 14, 0, 239],
      );
      // A box across the partial edge chunks matches the same samples of the whole read.
      const box = await array.read({ start: [495, 498, 1], stop: [512, 512, 3] });
      assert.deepEqual(box.shape, [17, 14, 2]);
      for (let y = 0; y < 17; y++)
        for (let x = 0; x < 14; x++)
          for (let c = 0; c < 2; c++) assert.equal(box.data[(y * 14 + x) * 2 + c], at(495 + y, 498 + x, 1 + c));
    }
  } finally {
    await server.close();
  }
});

test('real Zarr v3 stores: zarrs array_gzip and GDAL order_f_u2 and gzip read their known values', async () => {
  for (const [folder, path, check] of [
    [
      'v3-zarrs/array_gzip.zarr',
      '',
      async (array) => {
        assert.deepEqual(array.attributes, { key: 'value' });
        assert.deepEqual(array.shape, [10, 10]);
        assert.deepEqual(
          [...(await array.read()).data],
          Array.from({ length: 100 }, (_, i) => i),
        );
      },
    ],
    [
      'v3-gdal/order_f_u2.zarr',
      'order_f_u2',
      async (array) => {
        assert.deepEqual(array.dimensionNames, ['Y', 'X']);
        assert.deepEqual(
          [...(await array.read()).data],
          Array.from({ length: 16 }, (_, i) => i),
        );
      },
    ],
    ['v3-gdal/gzip.zarr', 'gzip', async (array) => assert.deepEqual([...(await array.read()).data], [1, 2])],
  ]) {
    const root = join(ZARR, folder),
      server = await serve(root);
    try {
      for (const store of [storeOf(root), server.base]) await check(await openZarr(store, path));
    } finally {
      await server.close();
    }
  }
});
