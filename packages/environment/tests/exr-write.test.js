import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeEXR } from '../dist/exr-write.js';
import { parseEXR } from '../dist/index.js';

const f32 = (bits) => new Float32Array(new Uint32Array(bits).buffer);
const one = (data, type = 'FLOAT', name = 'Y', rest = {}) => ({
  width: data.length,
  height: 1,
  channels: [{ name, type, data }],
  ...rest,
});
// Stored samples, per channel in file order: rows sit at the end of the file, each an 8-byte header then each channel.
function samples(bytes, width, height, sizes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset),
    line = 8 + width * sizes.reduce((a, b) => a + b);
  return sizes.map((size, c) => {
    const values = [];
    for (let y = 0; y < height; y++) {
      let at = bytes.length - (height - y) * line + 8 + width * sizes.slice(0, c).reduce((a, b) => a + b, 0);
      for (let x = 0; x < width; x++, at += size)
        values.push(size === 2 ? view.getUint16(at, true) : view.getUint32(at, true));
    }
    return values;
  });
}

test('the OpenEXR documentation sample file (mixed HALF G and FLOAT Z) is reproduced byte for byte', async () => {
  // https://openexr.com/en/latest/OpenEXRFileLayout.html#sample-file
  const G = [
    0, 1026195456, 1052418048, 1035796480, 1057415168, 1047445504, 1064206336, 1057906688, 1061445632, 1048657920,
    1063272448, 1064017920,
  ];
  const Z = [
    981543004, 1043653071, 1035668363, 1056535689, 1055435647, 1062522762, 1058106459, 1028666656, 1016787768,
    1050193229, 1057494044, 1057223500,
  ];
  const bytes = await encodeEXR({
    width: 4,
    height: 3,
    channels: [
      { name: 'Z', type: 'FLOAT', data: f32(Z) },
      { name: 'G', type: 'HALF', data: f32(G) },
    ],
  });
  assert.equal(bytes.length, 415);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '6bc7d6095f50d30f08ec03c9689de11bbfd91776782de7cee4aa9a367c32f3f6',
  );
});

test('RGBA round trips through parseEXR, from interleaved data via offset and stride', async () => {
  const rgba = new Float32Array([0.5, 1, 2, 1, 4, 8, 16, 0.25, -1, 0, 0.125, 0.5, 100, 200, 300, 1]);
  const bytes = await encodeEXR({
    width: 2,
    height: 2,
    channels: ['R', 'G', 'B', 'A'].map((name, i) => ({
      name,
      type: i < 2 ? 'HALF' : 'FLOAT',
      data: rgba,
      offset: i,
      stride: 4,
    })),
  });
  const image = parseEXR(bytes);
  assert.deepEqual([image.width, image.height, image.layout, image.compression], [2, 2, 'RGBA', 'NONE']);
  assert.deepEqual(
    image.channels.map((c) => c.name + c.type),
    ['AFLOAT', 'BFLOAT', 'GHALF', 'RHALF'],
  );
  assert.deepEqual([...image.data], [...rgba]);
  assert.deepEqual(image.dataWindow, [0, 0, 1, 1]);
});

test('named layer channels are sorted; UINT and FLOAT keep their exact bits; colorInteropID is stored', async () => {
  const bits = [0, 16777217, 0xfffffffe, 0xffffffff];
  const bytes = await encodeEXR(
    {
      width: 2,
      height: 2,
      colorInteropID: 'lin_rec709_scene',
      channels: [
        { name: 'normal.X', type: 'HALF', data: new Float32Array([-1, -2, 3, 4]) },
        { name: 'id', type: 'UINT', data: new Uint32Array(bits) },
        { name: 'depth.Z', type: 'FLOAT', data: f32([0x7fc00001, 1, 0x80000000, 0x3f800000]) },
      ],
    },
    { nonFinite: 'preserve' },
  );
  assert.deepEqual(samples(bytes, 2, 2, [4, 4, 2]), [
    [0x7fc00001, 1, 0x80000000, 0x3f800000],
    bits,
    [0xbc00, 0xc000, 0x4200, 0x4400],
  ]);
  assert.ok(Buffer.from(bytes).includes('colorInteropID\0string\0'));
  assert.ok(Buffer.from(bytes).includes('lin_rec709_scene'));
});

test('HALF rounds to nearest even and refuses finite values over 65504', async () => {
  const halves = async (values) =>
    samples(await encodeEXR(one(new Float32Array(values), 'HALF')), values.length, 1, [2])[0];
  assert.deepEqual(
    await halves([1 + 2 ** -11, 1 + 3 * 2 ** -11, 65504, 65519.99, 2 ** -24, 2 ** -26]),
    [0x3c00, 0x3c02, 0x7bff, 0x7bff, 0x0001, 0x0000],
  );
  await assert.rejects(encodeEXR(one(new Float32Array([65520]), 'HALF')), /over the HALF maximum 65504; use FLOAT/);
});

test('nonfinite samples are refused by default and written with nonFinite: preserve', async () => {
  for (const type of ['HALF', 'FLOAT'])
    await assert.rejects(encodeEXR(one(new Float32Array([1, NaN]), type)), {
      name: 'RangeError',
      message: /pixel 1,0 is not finite/,
    });
  const bytes = await encodeEXR(one(new Float32Array([Infinity, -Infinity, NaN]), 'HALF'), { nonFinite: 'preserve' });
  assert.deepEqual(samples(bytes, 3, 1, [2])[0], [0x7c00, 0xfc00, 0x7e00]);
});

test('an abort stops the encode with the signal reason; bad input and limits throw before any work', async () => {
  const reason = new Error('stop'),
    big = { width: 4096, height: 64, channels: [{ name: 'Y', type: 'FLOAT', data: new Float32Array(4096 * 64) }] };
  const controller = new AbortController(),
    pending = encodeEXR(big, { signal: controller.signal, onProgress: () => controller.abort(reason) });
  await assert.rejects(pending, (e) => e === reason);
  await assert.rejects(encodeEXR(one(new Float32Array(1)), { signal: AbortSignal.abort(reason) }), (e) => e === reason);
  const progress = [];
  await encodeEXR(big, { onProgress: (done, total) => progress.push([done, total]) });
  assert.deepEqual(progress.at(-1), [4096 * 64, 4096 * 64]);
  assert.ok(progress.length > 1);
  const y = new Float32Array(4);
  for (const [input, options, error] of [
    [{ width: 0, height: 1, channels: [{ name: 'Y', type: 'FLOAT', data: y }] }, {}, RangeError],
    [{ width: 5, height: 1, channels: [{ name: 'Y', type: 'FLOAT', data: y }] }, {}, RangeError],
    [{ width: 2, height: 1, channels: [{ name: 'Y', type: 'FLOAT', data: y, offset: 1, stride: 3 }] }, {}, RangeError],
    [{ width: 1, height: 1, channels: [{ name: 'Y', type: 'UINT', data: y }] }, {}, TypeError],
    [
      {
        width: 1,
        height: 1,
        channels: [
          { name: 'Y', type: 'HALF', data: y },
          { name: 'Y', type: 'HALF', data: y },
        ],
      },
      {},
      TypeError,
    ],
    [{ width: 1, height: 1, channels: [{ name: 'é', type: 'HALF', data: y }] }, {}, TypeError],
    [one(y), { maxBytes: 300 }, RangeError],
    [one(y), { nonFinite: 'clamp' }, TypeError],
  ])
    await assert.rejects(encodeEXR(input, options), error);
});
