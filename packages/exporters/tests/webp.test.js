import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWebpLossless } from '@margoengine/decoders/webp-lossless';
import { encodeAnimatedWebP, encodeWebP } from '@margoengine/exporters/webp';
import { canonicalCodes, codeLengths } from '../dist/prefix-codes.js';

const seeded = (seed) => () => (seed = Math.imul(seed, 1664525) + 1013904223) >>> 24;

function image(width, height, paint) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  return { data, width, height };
}
async function roundTrip(pixels) {
  const file = await encodeWebP(pixels),
    decoded = decodeWebpLossless(file);
  assert.equal(decoded.width, pixels.width);
  assert.equal(decoded.height, pixels.height);
  assert.deepEqual(decoded.data, pixels.data);
  return file;
}

test('every side from 1 to 40 round-trips pixel-exact through the decoder, in all colour-count routes', async () => {
  for (const colours of [1, 2, 4, 5, 16, 17, 256, 257]) {
    const random = seeded(colours),
      table = Array.from({ length: colours }, () => [random(), random(), random(), random()]);
    for (const [width, height] of [
      [1, 1],
      [2, 1],
      [1, 2],
      [3, 3],
      [7, 2],
      [9, 5],
      [16, 16],
      [17, 17],
      [33, 40],
      [40, 7],
    ]) {
      if (width * height < colours) continue;
      let next = 0;
      await roundTrip(image(width, height, () => table[next++ % colours]));
    }
  }
});

test('colour under transparent pixels survives, in the indexed and the predicted route', async () => {
  await roundTrip({ data: new Uint8Array([10, 20, 30, 0, 40, 50, 60, 0]), width: 2, height: 1 });
  const random = seeded(5);
  await roundTrip(image(32, 32, () => [random(), random(), random(), 0]));
});

test('runs, repeated rows, gradients and noise round-trip and only the compressible ones shrink', async () => {
  const flat = await roundTrip(image(256, 256, () => [12, 34, 56, 255]));
  assert.ok(flat.length < 80, `flat image is ${flat.length} bytes`);
  const raw = 128 * 128 * 4,
    gradient = await roundTrip(image(128, 128, (x, y) => [x * 2, y * 2, (x + y) & 255, 255]));
  assert.ok(gradient.length < raw / 8, `gradient is ${gradient.length} of ${raw} bytes`);
  const random = seeded(9),
    row = Array.from({ length: 128 }, () => [random(), random(), random(), 255]),
    rows = await roundTrip(image(128, 128, (x) => row[x]));
  assert.ok(rows.length < raw / 8, `repeated rows are ${rows.length} of ${raw} bytes`);
  const sprite = await roundTrip(image(64, 64, (x, y) => ((x ^ y) & 8 ? [200, 30, 40, 255] : [0, 0, 0, 0])));
  assert.ok(sprite.length < (64 * 64 * 4) / 16, `two-colour sprite is ${sprite.length} bytes`);
  await roundTrip(image(128, 128, () => [random(), random(), random(), random()]));
});

test('a Fibonacci histogram round-trips', async () => {
  const pixels = [];
  for (let colour = 0, a = 1, b = 1; colour < 26; colour++, [a, b] = [b, a + b])
    for (let i = 0; i < a; i++) pixels.push([colour * 9, 0, 255 - colour, 255]);
  // Shuffled, so copies do not absorb the skew and the indices reach the green code as literals.
  const random = seeded(77);
  for (let i = pixels.length - 1; i > 0; i--) {
    const j = ((random() << 16) | (random() << 8) | random()) % (i + 1);
    [pixels[i], pixels[j]] = [pixels[j], pixels[i]];
  }
  const side = Math.ceil(Math.sqrt(pixels.length));
  await roundTrip(image(side, side, (x, y) => pixels[y * side + x] ?? pixels[0]));
});

test('a Fibonacci histogram, whose Huffman tree is 39 bits deep, comes out complete within the limit', () => {
  const counts = new Uint32Array(40);
  for (let i = 0, a = 1, b = 1; i < 40; i++, [a, b] = [b, a + b]) counts[i] = a;
  for (const limit of [15, 7]) {
    const fits = limit === 15 ? counts : counts.slice(0, 19),
      lengths = codeLengths(fits, limit);
    assert.ok(Math.max(...lengths) <= limit);
    assert.equal(
      lengths.reduce((sum, length) => sum + 2 ** -length, 0),
      1,
      'Kraft sum of a complete code',
    );
    assert.ok(
      lengths.every((length, s) => s === 0 || length <= lengths[s - 1]),
      'rarer symbols get longer codes',
    );
  }
  // Reversed canonical codes: lengths 1, 2, 3, 3 give 0, 10, 110, 111, written last bit first.
  assert.deepEqual([...canonicalCodes(new Uint8Array([1, 2, 3, 3]))], [0, 0b01, 0b011, 0b111]);
});

test('the same pixels give the same bytes', async () => {
  const random = seeded(3),
    pixels = image(50, 50, () => [random(), random(), random(), 255]);
  assert.deepEqual(await encodeWebP(pixels), await encodeWebP(pixels));
});

test('the file is a RIFF WEBP with an even VP8L chunk and the stream header of the spec', async () => {
  const file = await encodeWebP(image(300, 200, (x) => [x & 255, 0, 0, x % 2 ? 255 : 128])),
    view = new DataView(file.buffer, file.byteOffset, file.byteLength),
    text = (at) => String.fromCharCode(...file.subarray(at, at + 4));
  assert.equal(text(0), 'RIFF');
  assert.equal(view.getUint32(4, true), file.length - 8);
  assert.equal(text(8), 'WEBP');
  assert.equal(text(12), 'VP8L');
  assert.equal(file.length % 2, 0);
  assert.equal(file[20], 0x2f);
  const bits = view.getUint32(21, true);
  assert.equal(bits & 0x3fff, 299);
  assert.equal((bits >>> 14) & 0x3fff, 199);
  assert.equal((bits >>> 28) & 1, 1, 'alpha is used');
  assert.equal(bits >>> 29, 0, 'version 0');
  const opaque = await encodeWebP(image(2, 2, () => [1, 2, 3, 255]));
  assert.equal((new DataView(opaque.buffer, opaque.byteOffset).getUint32(21, true) >>> 28) & 1, 0);
});

// The chunks of a RIFF file, or of an ANMF body from `start`.
function chunks(file, start = 12) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength),
    out = [];
  for (let at = start; at < file.length; ) {
    const size = view.getUint32(at + 4, true);
    out.push({ tag: String.fromCharCode(...file.subarray(at, at + 4)), body: file.subarray(at + 8, at + 8 + size) });
    at += 8 + size + (size & 1);
  }
  return out;
}
const uint24 = (b, at) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

test('an animated WebP has VP8X, ANIM and one ANMF per frame, each decoding pixel-exact', async () => {
  const random = seeded(11),
    frames = [0, 1, 2].map(() => image(9, 5, () => [random(), random(), random(), random() | 1])),
    file = await encodeAnimatedWebP(3, (i) => frames[i], { fps: 30, loops: 7 }),
    parts = chunks(file);
  assert.deepEqual(
    parts.map((p) => p.tag),
    ['VP8X', 'ANIM', 'ANMF', 'ANMF', 'ANMF'],
  );
  assert.equal(new DataView(file.buffer, file.byteOffset).getUint32(4, true), file.length - 8);
  const [vp8x, anim] = parts;
  assert.equal(vp8x.body[0], 0x12, 'alpha and animation flags');
  assert.equal(uint24(vp8x.body, 4), 8);
  assert.equal(uint24(vp8x.body, 7), 4);
  assert.deepEqual([...anim.body], [0, 0, 0, 0, 7, 0]);
  const durations = [];
  parts.slice(2).forEach((part, i) => {
    assert.equal(uint24(part.body, 0), 0);
    assert.equal(uint24(part.body, 3), 0);
    assert.equal(uint24(part.body, 6), 8);
    assert.equal(uint24(part.body, 9), 4);
    durations.push(uint24(part.body, 12));
    assert.equal(part.body[15], 2, 'no blend, no dispose');
    const [inner] = chunks(part.body, 16);
    assert.equal(inner.tag, 'VP8L');
    const header = new Uint8Array([
        ...new TextEncoder().encode('RIFF'),
        0,
        0,
        0,
        0,
        ...new TextEncoder().encode('WEBP'),
      ]),
      wrapped = new Uint8Array(12 + 8 + inner.body.length);
    wrapped.set(header);
    wrapped.set(part.body.subarray(16, 16 + 8 + inner.body.length), 12);
    assert.deepEqual(decodeWebpLossless(wrapped).data, frames[i].data);
  });
  assert.deepEqual(durations, [33, 34, 33]);
});

test('an opaque animation leaves the alpha flag off and durations sum to the exact total', async () => {
  const opaque = image(2, 2, () => [1, 2, 3, 255]),
    parts = chunks(await encodeAnimatedWebP(70, () => opaque, { fps: 7 }));
  assert.equal(parts[0].body[0], 2);
  assert.equal(
    parts.slice(2).reduce((sum, part) => sum + uint24(part.body, 12), 0),
    10000,
  );
});

test('sizes and options out of range are refused with the fix named', async () => {
  const pixel = { data: new Uint8Array(4), width: 1, height: 1 };
  await assert.rejects(encodeWebP({ data: new Uint8Array(16385 * 4), width: 16385, height: 1 }), /at most 16384/);
  await assert.rejects(encodeWebP({ data: new Uint8Array(3), width: 1, height: 1 }), RangeError);
  await assert.rejects(encodeWebP({ data: [], width: 1, height: 1 }), TypeError);
  await assert.rejects(
    encodeAnimatedWebP(0, () => pixel),
    /Frame count 0/,
  );
  await assert.rejects(
    encodeAnimatedWebP(1, () => pixel, { fps: 2000 }),
    /fps 2000/,
  );
  await assert.rejects(
    encodeAnimatedWebP(1, () => pixel, { loops: 65536 }),
    /loops 65536/,
  );
  await assert.rejects(
    encodeAnimatedWebP(2, (i) => (i ? { data: new Uint8Array(8), width: 2, height: 1 } : pixel)),
    /WebP frame 1 is 2x1, not 1x1/,
  );
});
