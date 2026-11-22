import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeWav, encodeWav } from '../dist/wav.js';

const FORMATS = { pcm8: 8, pcm16: 16, pcm24: 24, pcm32: 32, float32: 32, float64: 64 };
const ascii = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));
const u32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);
const u16 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint16(at, true);
const coded = (code) => (error) =>
  error.name === 'MargoError' && error.code === code && /errors#wav/.test(error.message);
const text = (s) => [...Buffer.from(s, 'latin1')];

test('a 16-bit mono file has the 44-byte header of the Microsoft PCM layout', () => {
  const file = encodeWav({ sampleRate: 44100, channels: [Float32Array.of(0, 0.5, -0.5, -1)] });
  assert.equal(file.length, 44 + 8);
  assert.equal(ascii(file, 0), 'RIFF');
  assert.equal(u32(file, 4), file.length - 8);
  assert.equal(ascii(file, 8), 'WAVE');
  assert.equal(ascii(file, 12), 'fmt ');
  assert.deepEqual(
    [u32(file, 16), u16(file, 20), u16(file, 22), u32(file, 24), u32(file, 28), u16(file, 32), u16(file, 34)],
    [16, 1, 1, 44100, 88200, 2, 16],
  );
  assert.equal(ascii(file, 36), 'data');
  assert.equal(u32(file, 40), 8);
  assert.deepEqual([...new Int16Array(file.buffer.slice(44))], [0, 16384, -16384, -32768]);
});

test('more than two channels, or samples wider than 16 bits, use WAVE_FORMAT_EXTENSIBLE with the PCM or float SubFormat', () => {
  const channels = Array.from({ length: 6 }, () => Float32Array.of(0.25, -0.25));
  const file = encodeWav({ sampleRate: 48000, channels }, { format: 'pcm24' });
  assert.equal(file.length, 60 + 8 + 6 * 3 * 2);
  assert.equal(u16(file, 20), 0xfffe);
  assert.equal(u32(file, 16), 40);
  assert.equal(u16(file, 36), 22);
  assert.equal(u16(file, 38), 24);
  assert.equal(u32(file, 40), 0x3f);
  assert.deepEqual([...file.subarray(44, 60)], [1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]);
  assert.equal(ascii(file, 60), 'data');
  const float = encodeWav({ sampleRate: 48000, channels: [Float32Array.of(0.5)] }, { format: 'float64' });
  assert.equal(u16(float, 20), 0xfffe);
  assert.equal(float[44], 3);
  const plain = encodeWav({ sampleRate: 48000, channels: [Float32Array.of(0.5)] }, { format: 'float32' });
  assert.equal(u16(plain, 20), 3);
  assert.equal(plain.length, 44 + 4);
});

for (const [format, bits] of Object.entries(FORMATS)) {
  test(`${format} round trips the samples it can hold, and decodes in the same format`, () => {
    const count = bits === 8 ? 256 : 4096;
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      if (format === 'pcm8') samples[i] = (i - 128) / 128;
      else if (format === 'pcm16') samples[i] = (i * 16 - 32768) / 32768;
      else if (format === 'pcm24') samples[i] = (i * 2048 - 8388608) / 8388608;
      else if (format === 'pcm32') samples[i] = Math.fround((i * 524288 - 2147483648) / 2147483648);
      else samples[i] = (i / count) * 2 - 1 + 1e-4;
    }
    const reversed = samples.slice().reverse();
    const file = encodeWav({ sampleRate: 22050, channels: [samples, reversed] }, { format });
    const back = decodeWav(file);
    assert.equal(back.format, format);
    assert.equal(back.sampleRate, 22050);
    assert.equal(back.channels.length, 2);
    assert.deepEqual(back.channels[0], samples);
    assert.deepEqual(back.channels[1], reversed);
    assert.deepEqual(encodeWav(back, { format }), file, 'writing what was read gives the same bytes');
  });
}

test('1.0 clamps to the largest value instead of wrapping, NaN is silence, and -1 reads back as -1', () => {
  const file = encodeWav({ sampleRate: 8000, channels: [Float32Array.of(1, -1, 2, NaN, 0.99999)] });
  assert.deepEqual([...new Int16Array(file.buffer.slice(44))], [32767, -32768, 32767, 0, 32767]);
  const eight = encodeWav({ sampleRate: 8000, channels: [[1, -1, 0, NaN]] }, { format: 'pcm8' });
  assert.deepEqual([...eight.subarray(44)], [255, 0, 128, 128]);
  assert.equal(decodeWav(file).channels[0][1], -1);
});

test('decodeWav skips LIST and bext chunks, an odd-sized one with its pad byte', () => {
  const file = encodeWav({ sampleRate: 16000, channels: [Float32Array.of(0.5, -0.5)] });
  const junk = Uint8Array.of(...text('LIST'), 3, 0, 0, 0, 1, 2, 3, 0, ...text('bext'), 2, 0, 0, 0, 9, 9);
  const out = new Uint8Array(file.length + junk.length);
  out.set(file.subarray(0, 36));
  out.set(junk, 36);
  out.set(file.subarray(36), 36 + junk.length);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  const audio = decodeWav(out);
  assert.deepEqual([...audio.channels[0]], [0.5, -0.5]);
  assert.equal(audio.sampleRate, 16000);
});

test('a file still being written reads to its end: data size 0xFFFFFFFF or past the file, and a last partial frame is dropped', () => {
  const file = encodeWav({
    sampleRate: 8000,
    channels: [Float32Array.of(0.25, 0.5, 0.75), Float32Array.of(-0.25, -0.5, -0.75)],
  });
  for (const size of [0xffffffff, 1_000_000]) {
    const copy = file.slice();
    new DataView(copy.buffer).setUint32(40, size, true);
    assert.equal(decodeWav(copy).channels[0].length, 3);
  }
  const cut = file.slice(0, file.length - 3);
  new DataView(cut.buffer).setUint32(40, 12, true);
  assert.equal(decodeWav(cut).channels[0].length, 2);
});

test('decodeWav accepts a view into a larger buffer and an ArrayBuffer', () => {
  const file = encodeWav({ sampleRate: 8000, channels: [Float32Array.of(0.5)] });
  const big = new Uint8Array(file.length + 10);
  big.set(file, 7);
  assert.deepEqual([...decodeWav(big.subarray(7, 7 + file.length)).channels[0]], [0.5]);
  assert.deepEqual(
    [...decodeWav(file.buffer.slice(file.byteOffset, file.byteOffset + file.length)).channels[0]],
    [0.5],
  );
});

test('the shared 4-channel recording reads as 4 channels, and writing it back changes no sample', () => {
  const bytes = readFileSync(new URL('./fixtures/rain-foa.wav', import.meta.url));
  const audio = decodeWav(bytes);
  assert.equal(audio.channels.length, 4);
  assert.ok(audio.sampleRate > 0 && audio.channels[0].length > 1000);
  assert.ok(audio.channels.every((channel) => channel.length === audio.channels[0].length));
  const again = decodeWav(encodeWav(audio, { format: audio.format }));
  for (let c = 0; c < 4; c++) assert.deepEqual(again.channels[c], audio.channels[c]);
});

test('files it cannot read are named, with a help link', () => {
  const good = encodeWav({ sampleRate: 8000, channels: [[0]] });
  assert.throws(
    () => decodeWav('nope'),
    (error) => error instanceof TypeError && /errors#wav/.test(error.message),
  );
  assert.throws(() => decodeWav(new Uint8Array(4)), coded('failed'));
  assert.throws(() => decodeWav(Uint8Array.of(...text('RIFX'), 0, 0, 0, 0, ...text('WAVE'))), coded('failed'));
  assert.throws(() => decodeWav(Uint8Array.of(...text('RF64'), 0, 0, 0, 0, ...text('WAVE'))), coded('unsupported'));
  const adpcm = good.slice();
  adpcm[20] = 2;
  assert.throws(() => decodeWav(adpcm), coded('unsupported'));
  const align = good.slice();
  align[32] = 5;
  assert.throws(() => decodeWav(align), coded('failed'));
  assert.throws(() => decodeWav(good.slice(0, 36)), coded('failed'));
  const noFmt = good.slice();
  noFmt[12] = 0x78;
  assert.throws(() => decodeWav(noFmt), coded('failed'));
});

test('encodeWav rejects what it cannot write', () => {
  const channel = Float32Array.of(0);
  assert.throws(() => encodeWav({ sampleRate: 0, channels: [channel] }), RangeError);
  assert.throws(() => encodeWav({ sampleRate: 44100.5, channels: [channel] }), RangeError);
  assert.throws(() => encodeWav({ sampleRate: 8000, channels: [] }), RangeError);
  assert.throws(() => encodeWav({ sampleRate: 8000, channels: [channel, Float32Array.of(0, 0)] }), RangeError);
  assert.throws(() => encodeWav({ sampleRate: 8000, channels: [channel] }, { format: 'mp3' }), /errors#wav/);
});
