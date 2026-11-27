// `@margoengine/decoders/jpeg2000` through its Wasm module, on the calling thread and in workers. The streams are built
// here from the marker syntax of Rec. ITU-T T.800 Annex A and the boxes of Annex I; every packet is empty, so each
// sample is the middle of its range. The coding passes themselves are tested in the crate (`cargo test`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JPEG2000Decoder, decodeJPEG2000, loadJPEG2000 } from '../dist/jpeg2000.js';

const be = (value, bytes) => Array.from({ length: bytes }, (_, i) => (value >>> (8 * (bytes - 1 - i))) & 255);
const segment = (marker, body) => [...be(marker, 2), ...be(body.length + 2, 2), ...body];

/** One 8-bit grey tile with `levels` decomposition levels and the reversible filter; `style` is the code-block style. */
function codestream(width, height, { levels = 0, style = 0 } = {}) {
  const size = [width, height, 0, 0, width, height, 0, 0].flatMap((v) => be(v, 4));
  // One empty packet per resolution: a single zero bit each.
  const packets = new Array(levels + 1).fill(0);
  return Uint8Array.from([
    ...be(0xff4f, 2),
    ...segment(0xff51, [0, 0, ...size, 0, 1, 7, 1, 1]),
    ...segment(0xff52, [0, 0, 0, 1, 0, levels, 4, 4, style, 1]),
    ...segment(0xff5c, [0x20, ...new Array(3 * levels + 1).fill(8 << 3)]),
    ...segment(0xff90, [0, 0, ...be(14 + packets.length, 4), 0, 1]),
    ...be(0xff93, 2),
    ...packets,
    ...be(0xffd9, 2),
  ]);
}

const box = (type, body) => [...be(body.length + 8, 4), ...[...type].map((c) => c.charCodeAt(0)), ...body];

/** A greyscale JP2 file around a codestream. */
function jp2(stream, width, height) {
  const header = [
    ...box('ihdr', [...be(height, 4), ...be(width, 4), 0, 1, 7, 7, 0, 0]),
    ...box('colr', [1, 0, 0, ...be(17, 4)]),
  ];
  return Uint8Array.from([
    ...box('jP  ', [0x0d, 0x0a, 0x87, 0x0a]),
    ...box(
      'ftyp',
      [...'jp2 \0\0\0\0jp2 '].map((c) => c.charCodeAt(0)),
    ),
    ...box('jp2h', header),
    ...box('jp2c', [...stream]),
  ]);
}

const grey = (pixels, sample, opaque) => Array.from({ length: pixels }, () => [sample, sample, sample, opaque]).flat();
const linked = (code, anchor, pattern) => (error) => {
  assert.equal(error.code, code);
  assert.match(error.message, pattern);
  assert.ok(error.message.endsWith(`see https://margoengine.com/errors#${anchor}`), error.message);
  return true;
};

test('a codestream and a JP2 file decode to RGBA at 8 and 16 bits, full size and reduced', async () => {
  const read = await loadJPEG2000();
  const stream = codestream(13, 9, { levels: 2 });
  const image = read(stream);
  assert.deepEqual([image.width, image.height, image.depth, image.truncated], [13, 9, 8, false]);
  assert.ok(image.data instanceof Uint8Array);
  assert.deepEqual([...image.data], grey(13 * 9, 128, 255));
  const wide = read(stream.buffer, { depth: 16 });
  assert.ok(wide.data instanceof Uint16Array);
  assert.deepEqual([...wide.data], grey(13 * 9, 128 * 257, 65535));
  const half = read(stream, { reduce: 1 });
  assert.deepEqual([half.width, half.height, half.data.length], [7, 5, 7 * 5 * 4]);
  // A view into a larger buffer reads only its own bytes.
  const padded = new Uint8Array(stream.length + 8);
  padded.set(stream, 5);
  assert.deepEqual(read(padded.subarray(5, 5 + stream.length)), image);
  assert.deepEqual(read(jp2(stream, 13, 9)), image);
});

test('a cut stream gives its picture and says so', async () => {
  const read = await loadJPEG2000();
  const stream = codestream(13, 9, { levels: 2 });
  const cut = read(stream.subarray(0, stream.length - 3));
  assert.equal(cut.truncated, true);
  assert.deepEqual([...cut.data], grey(13 * 9, 128, 255));
});

test('failures are coded and link to their help', async () => {
  const read = await loadJPEG2000();
  const stream = codestream(13, 9);
  assert.throws(() => read(new Uint8Array(0)), linked('failed', 'failed', /empty/));
  assert.throws(() => read(stream.subarray(0, 12)), linked('failed', 'failed', /ends inside a header/));
  assert.throws(() => read(Uint8Array.of(1, 2, 3, 4, 5, 6)), linked('failed', 'failed', /malformed/));
  assert.throws(() => read(stream, { reduce: 1 }), linked('failed', 'failed', /reduce exceeds/));
  // Bit 6 of the code-block style selects the HT block coder of Part 15.
  assert.throws(() => read(codestream(13, 9, { style: 0x40 })), linked('unsupported', 'unsupported', /Part 15/));
  assert.throws(
    () => read(stream, { maxPixels: 116 }),
    (error) => error instanceof RangeError && /maxPixels.*errors#limits$/.test(error.message),
  );
  assert.equal(read(stream, { maxPixels: 117 }).width, 13);
  for (const options of [{ reduce: -1 }, { reduce: 33 }, { layers: 1.5 }, { maxPixels: 2 ** 28 + 1 }])
    assert.throws(() => read(stream, options), RangeError, JSON.stringify(options));
  assert.throws(() => read(stream, { depth: 12 }), TypeError);
});

test('worker decodes match, keep their error codes and obey their signal', { timeout: 60000 }, async () => {
  const read = await loadJPEG2000();
  const stream = codestream(13, 9, { levels: 2 });
  using decoder = new JPEG2000Decoder({ workerLimit: 2, timeout: 30000 });
  const [a, b] = await Promise.all([decoder.decode(stream), decoder.decode(stream, { depth: 16 })]);
  assert.deepEqual(a, read(stream));
  assert.deepEqual(b, read(stream, { depth: 16 }));
  const transferred = stream.slice().buffer;
  assert.deepEqual(await decoder.decode(transferred, { transfer: true }), a);
  assert.equal(transferred.byteLength, 0);
  // The pool once rebuilt only 'failed': an unsupported or over-limit image arrived as a plain, uncoded Error.
  await assert.rejects(decoder.decode(codestream(13, 9, { style: 0x40 })), (error) => {
    assert.equal(error.name, 'MargoError');
    return linked('unsupported', 'unsupported', /Part 15/)(error);
  });
  await assert.rejects(decoder.decode(stream, { maxPixels: 1 }), RangeError);
  await assert.rejects(decoder.decode(stream.subarray(0, 12)), linked('failed', 'failed', /header/));
  await assert.rejects(decoder.decode(stream, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.deepEqual(await decodeJPEG2000(stream), a);
});

test('loading obeys its signal and a failed load is not kept', async () => {
  await assert.rejects(loadJPEG2000({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  const decoderPath = new URL('./no-such-folder/', import.meta.url).href;
  await assert.rejects(loadJPEG2000({ decoderPath }), { code: 'ENOENT' });
  await assert.rejects(loadJPEG2000({ decoderPath }), { code: 'ENOENT' });
  const controller = new AbortController();
  const loading = loadJPEG2000({ signal: controller.signal });
  controller.abort();
  await assert.rejects(loading, { name: 'AbortError' });
});
