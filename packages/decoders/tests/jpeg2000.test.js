// `@margoengine/decoders/jpeg2000` through its Wasm module, on the calling thread and in workers. The hand-built streams
// follow the marker syntax of Rec. ITU-T T.800 Annex A and the boxes of Annex I (support/jpeg2000-streams.js), with
// empty packets, so each sample is the middle of its range; OpenJPEG's streams (fixtures/jpeg2000, written by
// generate-jpeg2000-openjpeg.py) carry real packets, whose pixels an outside encoder and decoder give. The coding passes
// are also tested in the crate (`cargo test`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JPEG2000Decoder, decodeJPEG2000, loadJPEG2000 } from '../dist/jpeg2000.js';
import { decodeImage, imageFormat } from '../dist/image.js';
import { decodePNG } from '../dist/png.js';
import { vectors } from './support/jpeg2000-fuzz.js';
import { codestream, jp2 } from './support/jpeg2000-streams.js';

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

test('OpenJPEG streams decode to its pixels: lossless exactly, lossy within one level', async () => {
  const read = await loadJPEG2000();
  const all = vectors();
  assert.equal(all.length, 16);
  for (const { file, pixels, lossless, bytes } of all) {
    const image = read(bytes);
    const expected = decodePNG(new Uint8Array(readFileSync(new URL(`fixtures/jpeg2000/${pixels}`, import.meta.url))));
    assert.deepEqual([image.width, image.height, image.truncated], [expected.width, expected.height, false], file);
    let worst = 0;
    for (let i = 0; i < expected.data.length; i++) worst = Math.max(worst, Math.abs(image.data[i] - expected.data[i]));
    assert.ok(worst <= (lossless ? 0 : 1), `${file}: ${worst} levels apart`);
  }
});

test('decodeImage names a codestream and a JP2 file and decodes them in a worker', { timeout: 60000 }, async () => {
  const read = await loadJPEG2000();
  for (const { file, bytes } of vectors().filter(({ file }) => ['grey.j2k', 'rgba.jp2'].includes(file))) {
    assert.equal(imageFormat(bytes), 'jpeg2000', file);
    const { width, height, data } = read(bytes);
    assert.deepEqual(await decodeImage(bytes), { width, height, data }, file);
  }
  const stream = codestream(13, 9, { levels: 2 });
  assert.equal(imageFormat(stream), 'jpeg2000');
  assert.equal(imageFormat(jp2(stream, 13, 9)), 'jpeg2000');
  // The signature is the whole marker pair or box, not its first bytes.
  assert.equal(imageFormat(stream.subarray(0, 3)), undefined);
  assert.equal(imageFormat(jp2(stream, 13, 9).subarray(0, 11)), undefined);
  // A picture cut short is a damaged file here; decodeJPEG2000 gives what it holds.
  const cut = stream.subarray(0, stream.length - 3);
  await assert.rejects(decodeImage(cut), { code: 'failed', message: /stops early.*decodeJPEG2000/ });
  assert.equal((await decodeJPEG2000(cut)).truncated, true);
  await assert.rejects(decodeImage(stream, { maxPixels: 116 }), RangeError);
  // decodeImage takes larger limits than this decoder holds; the file is read within its own.
  assert.equal((await decodeImage(stream, { maxPixels: 2 ** 30 })).width, 13);
  await assert.rejects(decodeImage(stream, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
