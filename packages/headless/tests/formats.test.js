import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEXR } from '@margoengine/environment';
import { encodeEXR, encodeJPEG, encodeWebP, linearPixels, readTexture } from '../dist/formats.js';

const image = (width, height, paint) => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  return { width, height, data };
};
const gradient = (width = 37, height = 21) => image(width, height, (x, y) => [x * 6, y * 11, (x + y) * 4, 255]);

/** The segments of a JPEG up to its scan data. */
function jpegSegments(bytes) {
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8]);
  const out = [];
  for (let at = 2; ; ) {
    assert.equal(bytes[at], 0xff);
    const marker = bytes[at + 1],
      length = (bytes[at + 2] << 8) | bytes[at + 3];
    out.push({ marker, body: bytes.subarray(at + 4, at + 2 + length) });
    at += 2 + length;
    if (marker === 0xda) return { segments: out, scan: at };
  }
}

test('a JPEG has the markers a baseline decoder needs, and ends cleanly', () => {
  const bytes = encodeJPEG(gradient()),
    { segments, scan } = jpegSegments(bytes),
    byMarker = (marker) => segments.find((segment) => segment.marker === marker).body;
  assert.deepEqual(
    segments.map((segment) => segment.marker),
    [0xe0, 0xdb, 0xc0, 0xc4, 0xda],
  );
  assert.equal(String.fromCharCode(...byMarker(0xe0).subarray(0, 4)), 'JFIF');
  const frame = byMarker(0xc0);
  assert.deepEqual([...frame.subarray(0, 6)], [8, 0, 21, 0, 37, 3]);
  assert.equal(frame[7], 0x22, '4:2:0 by default');
  assert.equal(jpegSegments(encodeJPEG(gradient(), { subsampling: '444' })).segments[2].body[7], 0x11);
  assert.deepEqual([...bytes.subarray(-2)], [0xff, 0xd9]);
  // In the scan, every 0xff is stuffed, so no marker can appear before the end.
  for (let i = scan; i < bytes.length - 2; i++) if (bytes[i] === 0xff) assert.equal(bytes[i + 1], 0, `byte ${i}`);
});

test('the Huffman tables are the full Annex K sets', () => {
  const { segments } = jpegSegments(encodeJPEG(gradient())),
    body = segments.find((segment) => segment.marker === 0xc4).body,
    sizes = [];
  for (let at = 0; at < body.length; ) {
    const count = body.subarray(at + 1, at + 17).reduce((sum, value) => sum + value, 0),
      values = body.subarray(at + 17, at + 17 + count);
    assert.equal(new Set(values).size, count, 'no symbol twice');
    sizes.push([body[at], count]);
    at += 17 + count;
  }
  assert.deepEqual(sizes, [
    [0x00, 12],
    [0x10, 162],
    [0x01, 12],
    [0x11, 162],
  ]);
});

test('JPEG quality follows the scaled tables, and a higher quality costs more bytes', () => {
  const table = (quality) => jpegSegments(encodeJPEG(gradient(), { quality })).segments[1].body;
  assert.equal(table(50)[1], 16, 'quality 50 is the table as printed');
  assert.equal(table(100)[1], 1);
  assert.equal(table(1)[1], 255, 'clamped to a byte');
  assert.ok(encodeJPEG(gradient(), { quality: 95 }).length > encodeJPEG(gradient(), { quality: 20 }).length);
});

test('JPEG takes any size, and a 1 x 1 picture', () => {
  for (const [w, h] of [
    [1, 1],
    [8, 8],
    [9, 7],
    [16, 16],
    [17, 33],
  ])
    assert.deepEqual([...encodeJPEG(gradient(w, h)).subarray(-2)], [0xff, 0xd9]);
});

test('JPEG lays transparency over the background', () => {
  const clear = image(8, 8, () => [0, 0, 0, 0]),
    white = encodeJPEG(clear),
    painted = image(8, 8, () => [255, 255, 255, 255]);
  assert.deepEqual(white, encodeJPEG(painted));
  assert.deepEqual(encodeJPEG(clear, { background: [0, 0, 0] }), encodeJPEG(image(8, 8, () => [0, 0, 0, 255])));
});

test('encoders refuse what they cannot write', async () => {
  const bad = { width: 2, height: 2, data: new Uint8Array(3) };
  assert.throws(() => encodeJPEG(bad), /match its size/);
  await assert.rejects(encodeWebP(bad), /match its size/);
  assert.throws(() => encodeJPEG(gradient(), { quality: 0 }), RangeError);
  assert.throws(() => encodeJPEG(gradient(), { subsampling: '422' }), TypeError);
  const huge = { width: 16385, height: 1, data: new Uint8Array(16385 * 4) };
  await assert.rejects(encodeWebP(huge), /too large/);
  await assert.rejects(encodeWebP(gradient(), { quality: 2 }), RangeError);
  await assert.rejects(encodeWebP(gradient(), { quality: 0.5 }), { code: 'unsupported' }, 'Node has no OffscreenCanvas');
  await assert.rejects(encodeEXR({ width: 1, height: 1, data: new Float32Array(3) }), /match its size/);
  await assert.rejects(encodeEXR({ width: 1, height: 1, data: new Uint8Array(4) }), /match its size/);
  await assert.rejects(encodeEXR({ width: 1, height: 1, data: new Float32Array(4) }, { type: 'x' }), TypeError);
});

test('a lossless WebP has the RIFF and VP8L headers its size and alpha need', async () => {
  const bytes = await encodeWebP(gradient()),
    view = new DataView(bytes.buffer, bytes.byteOffset),
    text = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  assert.deepEqual([text(0), text(8), text(12)], ['RIFF', 'WEBP', 'VP8L']);
  assert.equal(view.getUint32(4, true), bytes.length - 8);
  assert.equal(bytes.length % 2, 0, 'RIFF pads to an even size');
  assert.equal(bytes[20], 0x2f);
  const header = view.getUint32(21, true);
  assert.equal((header & 0x3fff) + 1, 37);
  assert.equal(((header >>> 14) & 0x3fff) + 1, 21);
  assert.equal((header >>> 28) & 1, 0, 'opaque');
  assert.equal(header >>> 29, 0, 'version 0');
  const clear = await encodeWebP(image(2, 2, () => [1, 2, 3, 100]));
  assert.equal((new DataView(clear.buffer, clear.byteOffset).getUint32(21, true) >>> 28) & 1, 1);
});

test('lossless WebP shrinks what repeats', async () => {
  const flat = await encodeWebP(image(256, 256, () => [10, 20, 30, 255]));
  assert.ok(flat.length < 200, `${flat.length} B`);
});

test('EXR files carry the pixels, in half or float, read back by the environment package', async () => {
  const data = Float32Array.from([0.5, 2, 1000, 1, 0, 0.25, 65504, 0.5]),
    source = { width: 2, height: 1, data },
    half = parseEXR(await encodeEXR(source)),
    float = parseEXR(await encodeEXR(source, { type: 'float' }));
  assert.deepEqual([half.width, half.height], [2, 1]);
  assert.deepEqual(
    half.channels.map((channel) => [channel.name, channel.type]),
    [
      ['A', 'HALF'],
      ['B', 'HALF'],
      ['G', 'HALF'],
      ['R', 'HALF'],
    ],
  );
  assert.equal(float.channels[0].type, 'FLOAT');
  for (const file of [half, float]) assert.deepEqual([...file.data], [...data], 'all these values are exact in half');
});

test('linearPixels undoes the sRGB curve and leaves alpha linear', () => {
  const { data, width, height } = linearPixels({ width: 2, height: 1, data: Uint8Array.of(0, 255, 188, 128, 10, 10, 10, 51) });
  assert.deepEqual([width, height], [2, 1]);
  assert.equal(data[0], 0);
  assert.equal(data[1], 1);
  assert.ok(Math.abs(data[2] - 0.5029) < 1e-3);
  assert.ok(Math.abs(data[3] - 128 / 255) < 1e-6);
  assert.ok(Math.abs(data[4] - 10 / 255 / 12.92) < 1e-6, 'the straight part of the curve');
});

/** A device whose buffer holds rows of `bytes`, padded as a real copy pads them. */
function floatDevice(format, rows) {
  return {
    createBuffer: ({ size }) => ({
      mapAsync: async () => {},
      getMappedRange: () => {
        const out = new Uint8Array(size);
        rows.forEach((row, y) => out.set(row, y * (size / rows.length)));
        return out.buffer;
      },
      destroy() {},
    }),
    createCommandEncoder: () => ({ copyTextureToBuffer() {}, finish: () => 'commands' }),
    queue: { submit() {} },
  };
}

test('readTexture drops the row padding and decodes half and float', async () => {
  const halves = new Uint8Array(new Uint16Array([0x3c00, 0x4000, 0x7bff, 0xc000]).buffer),
    device = floatDevice('rgba16float', [halves, halves]),
    read = await readTexture({ gpu: device }, { format: 'rgba16float', width: 1, height: 2 });
  assert.deepEqual([...read.data], [1, 2, 65504, -2, 1, 2, 65504, -2]);
  const floats = new Uint8Array(new Float32Array([1.5, 0, 0, 1]).buffer),
    wide = await readTexture({ gpu: floatDevice('rgba32float', [floats]) }, { format: 'rgba32float', width: 1, height: 1 });
  assert.deepEqual([...wide.data], [1.5, 0, 0, 1]);
});

test('readTexture refuses other formats, a missing GPU, and an aborted read', async () => {
  await assert.rejects(readTexture({ gpu: {} }, { format: 'rgba8unorm', width: 1, height: 1 }), { code: 'unsupported' });
  await assert.rejects(readTexture({}, { format: 'rgba16float', width: 1, height: 1 }), { code: 'unsupported' });
  const stop = new AbortController();
  stop.abort(new Error('enough'));
  await assert.rejects(readTexture({ gpu: {} }, {}, { signal: stop.signal }), /enough/);
});
