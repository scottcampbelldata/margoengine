import { fault, rangeError, typeError } from '../../shared/errors.js';

// RIFF WAVE reader and writer for Node, workers and pages: no Web Audio, no DOM, no file system.
//
// Sources (read clean room, no other library's code):
//  - Microsoft and IBM, "Multimedia Programming Interface and Data Specifications 1.0" (August 1991): the RIFF chunk
//    layout (ID, little-endian uint32 size, data, one pad byte after an odd size), the WAVE form, and the `fmt `
//    chunk of WAVE_FORMAT_PCM (wFormatTag 1; 8-bit samples unsigned, wider ones signed two's complement).
//  - Microsoft, "Multiple Channel Audio Data and WAVE Files" (2001, WAVE_FORMAT_EXTENSIBLE, tag 0xFFFE): a 22-byte
//    extension (valid bits, channel mask, 16-byte SubFormat GUID) after cbSize, required for more than two channels or
//    more than 16 bits per sample; the PCM and IEEE-float SubFormats are the format tag in their first two bytes
//    followed by 0000-0010-8000-00AA00389B71.
//  - Microsoft mmreg.h: WAVE_FORMAT_IEEE_FLOAT is tag 3; the speaker bits of the channel mask.
//  - EBU Tech 3285, "Specification of the Broadcast Wave Format" (2011): a BWF file is a WAVE file with extra chunks
//    (`bext`, `iXML`, `cue `), which a reader skips like any other chunk it does not know.
//  - EBU Tech 3306, "RF64: an extended File Format for Audio" (2009): the 64-bit form for files over 4 GiB. Not read or
//    written here; a file that starts `RF64` is rejected by name.

/** How a file stores each sample. `pcm8` is unsigned; the other integer formats are signed. */
export type WavSampleFormat = 'pcm8' | 'pcm16' | 'pcm24' | 'pcm32' | 'float32' | 'float64';

/** Decoded audio: one Float32Array per channel, samples nominally in -1..1. */
export interface WavAudio {
  /** Frames per second, a positive integer. */
  sampleRate: number;
  /** One array per channel, all the same length. */
  channels: Float32Array[];
  /** The sample format of the file the audio was read from. */
  format: WavSampleFormat;
  /** The speaker bits of a WAVE_FORMAT_EXTENSIBLE file (bit 0 front left, bit 1 front right, bit 2 front centre, ...); 0 when absent or unspecified. */
  channelMask: number;
}

/** What `encodeWav` needs: a rate and the channels (typed arrays or plain number arrays, all the same length). */
export interface WavInput {
  sampleRate: number;
  channels: ArrayLike<number>[];
  /** The speaker bits written to an extensible header. Default: the usual layout for 1, 2, 4, 6 and 8 channels, else 0. */
  channelMask?: number;
}

/** Options of `encodeWav`. */
export interface EncodeWavOptions {
  /** Default `pcm16`. */
  format?: WavSampleFormat;
}

const BITS: Record<WavSampleFormat, number> = { pcm8: 8, pcm16: 16, pcm24: 24, pcm32: 32, float32: 32, float64: 64 };
const PCM = 1,
  FLOAT = 3,
  EXTENSIBLE = 0xfffe,
  GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71],
  MASKS: Record<number, number> = { 1: 0x4, 2: 0x3, 4: 0x33, 6: 0x3f, 8: 0x63f };

type Code = 'failed' | 'unsupported';
const wavFault = (code: Code, message: string) => fault(code, message, 'wav');
const text = (view: DataView, at: number) =>
  String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

function bytesOf(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw typeError(
    'decodeWav needs an ArrayBuffer or a typed array holding the file; read the file into bytes first',
    'wav',
  );
}

function sampleFormat(tag: number, bits: number): WavSampleFormat {
  if (tag === PCM) {
    if (bits === 8) return 'pcm8';
    if (bits === 16) return 'pcm16';
    if (bits === 24) return 'pcm24';
    if (bits === 32) return 'pcm32';
  }
  if (tag === FLOAT) {
    if (bits === 32) return 'float32';
    if (bits === 64) return 'float64';
  }
  throw wavFault(
    'unsupported',
    `WAV format tag ${tag} with ${bits} bits per sample is not supported; read 8, 16, 24 and 32-bit PCM and 32 and 64-bit float, or convert the file first`,
  );
}

/**
 * Reads a RIFF WAVE file: 8, 16, 24 and 32-bit integer PCM and 32 and 64-bit float, plain or WAVE_FORMAT_EXTENSIBLE,
 * with any number of channels. Chunks other than `fmt ` and `data` (`LIST`, `bext`, `iXML`, `cue `) are skipped. A
 * `data` size that is 0xFFFFFFFF, or runs past the end of the file (a file still being written), reads to the end; a
 * last partial frame is dropped. Integer samples become `value / 2^(bits - 1)` (8-bit: `(byte - 128) / 128`), so
 * `encodeWav` of the result in the same format returns the same samples.
 * @example
 * const audio = decodeWav(bytes); // bytes: the file as a Uint8Array or ArrayBuffer
 * console.log(audio.sampleRate, audio.channels.length, audio.channels[0].length);
 */
export function decodeWav(data: ArrayBuffer | ArrayBufferView): WavAudio {
  const bytes = bytesOf(data),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) throw wavFault('failed', 'Not a WAV file: shorter than the 12-byte RIFF header');
  const magic = text(view, 0);
  if (magic === 'RF64' || magic === 'BW64')
    throw wavFault(
      'unsupported',
      'RF64 and BW64 files (over 4 GiB) are not supported; split the audio into files under 4 GiB',
    );
  if (magic !== 'RIFF' || text(view, 8) !== 'WAVE')
    throw wavFault('failed', 'Not a WAV file: it must start with RIFF and form type WAVE');
  let format: { tag: number; channels: number; rate: number; bits: number; mask: number } | undefined,
    start = -1,
    size = 0;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = text(view, at);
    let length = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      if (length < 16 || body + 16 > bytes.length)
        throw wavFault('failed', 'The WAV fmt chunk is shorter than 16 bytes');
      let tag = view.getUint16(body, true),
        mask = 0;
      const bits = view.getUint16(body + 14, true);
      if (tag === EXTENSIBLE) {
        if (length < 40 || body + 40 > bytes.length)
          throw wavFault('failed', 'The WAV extensible fmt chunk is shorter than 40 bytes');
        if (view.getUint16(body + 16, true) < 22)
          throw wavFault('failed', 'The WAV extensible fmt chunk has no 22-byte extension');
        mask = view.getUint32(body + 20, true);
        tag = view.getUint16(body + 24, true);
        for (let i = 0; i < GUID_TAIL.length; i++)
          if (view.getUint8(body + 26 + i) !== GUID_TAIL[i])
            throw wavFault(
              'unsupported',
              'The WAV extensible SubFormat is not PCM or IEEE float; convert the file first',
            );
      }
      format = { tag, channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits, mask };
      const align = view.getUint16(body + 12, true);
      if (format.channels < 1 || format.rate < 1)
        throw wavFault('failed', 'The WAV fmt chunk has no channels or a zero sample rate');
      if (bits === 0 || bits % 8 || align !== (format.channels * bits) / 8)
        throw wavFault(
          'failed',
          `The WAV fmt chunk is inconsistent: ${bits} bits per sample, ${format.channels} channels, block align ${align}`,
        );
    } else if (id === 'data' && start < 0) {
      start = body;
      size = length === 0xffffffff || body + length > bytes.length ? bytes.length - body : length;
      if (format) break;
    }
    length += length & 1;
    at = body + length;
  }
  if (!format) throw wavFault('failed', 'The WAV file has no fmt chunk');
  if (start < 0) throw wavFault('failed', 'The WAV file has no data chunk');
  const kind = sampleFormat(format.tag, format.bits),
    width = format.bits / 8,
    frames = Math.floor(size / (width * format.channels)),
    channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
  for (let frame = 0, at = start; frame < frames; frame++)
    for (let c = 0; c < format.channels; c++, at += width) {
      let v: number;
      switch (kind) {
        case 'pcm8':
          v = (view.getUint8(at) - 128) / 128;
          break;
        case 'pcm16':
          v = view.getInt16(at, true) / 32768;
          break;
        case 'pcm24':
          v = (view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) / 8388608;
          break;
        case 'pcm32':
          v = view.getInt32(at, true) / 2147483648;
          break;
        case 'float32':
          v = view.getFloat32(at, true);
          break;
        default:
          v = view.getFloat64(at, true);
      }
      channels[c][frame] = v;
    }
  return { sampleRate: format.rate, channels, format: kind, channelMask: format.mask };
}

/**
 * Writes a RIFF WAVE file. Integer formats scale by `2^(bits - 1)`, round to nearest and clamp to the format's range
 * (so 1 becomes the largest value, no wrap); float formats store the samples as they are. Files with more than two
 * channels, or 24 or 32-bit integer or 64-bit float samples, use WAVE_FORMAT_EXTENSIBLE as the Microsoft guidance for
 * multichannel and wide files says; the rest use the plain header every tool reads. NaN becomes 0 in integer formats.
 * @example
 * const left = new Float32Array(48_000).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.5);
 * const file = encodeWav({sampleRate: 48_000, channels: [left, left]}, {format: 'pcm24'}); // a Uint8Array
 * console.log(file.byteLength);
 */
export function encodeWav(audio: WavInput, options: EncodeWavOptions = {}): Uint8Array {
  const kind = options.format ?? 'pcm16';
  if (!(kind in BITS))
    throw rangeError(`Unknown WAV format ${String(kind)}; use pcm8, pcm16, pcm24, pcm32, float32 or float64`, 'wav');
  const { sampleRate, channels } = audio;
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 0xffffffff)
    throw rangeError('encodeWav needs an integer sampleRate from 1 to 4294967295', 'wav');
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 0xffff)
    throw rangeError('encodeWav needs from 1 to 65535 channels, each an array of samples', 'wav');
  const frames = channels[0]?.length;
  if (!Number.isInteger(frames) || channels.some((channel) => !channel || channel.length !== frames))
    throw rangeError('encodeWav needs every channel to be an array of the same length', 'wav');
  const count = channels.length,
    bits = BITS[kind],
    width = bits / 8,
    float = kind === 'float32' || kind === 'float64',
    extensible = count > 2 || kind === 'pcm24' || kind === 'pcm32' || kind === 'float64',
    header = extensible ? 60 : 36,
    dataSize = frames * count * width,
    pad = dataSize & 1;
  if (header + dataSize + pad > 0xffffffff)
    throw rangeError('A WAV file holds under 4 GiB; split the audio into shorter files', 'wav');
  const out = new Uint8Array(header + 8 + dataSize + pad),
    view = new DataView(out.buffer);
  const tag = (at: number, name: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = name.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, extensible ? 40 : 16, true);
  view.setUint16(20, extensible ? EXTENSIBLE : float ? FLOAT : PCM, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * width, true);
  view.setUint16(32, count * width, true);
  view.setUint16(34, bits, true);
  let at: number;
  if (extensible) {
    view.setUint16(36, 22, true);
    view.setUint16(38, bits, true);
    view.setUint32(40, audio.channelMask ?? MASKS[count] ?? 0, true);
    view.setUint16(44, float ? FLOAT : PCM, true);
    out.set(GUID_TAIL, 46);
  }
  at = header;
  tag(at, 'data');
  view.setUint32(at + 4, dataSize, true);
  at += 8;
  // NaN becomes 0, so a stray NaN is silence, not the most negative value.
  const clamp = (v: number, low: number, high: number) => Math.min(high, Math.max(low, Math.round(v) || 0));
  for (let frame = 0; frame < frames; frame++)
    for (let c = 0; c < count; c++, at += width) {
      const v = channels[c][frame];
      switch (kind) {
        case 'pcm8':
          view.setUint8(at, clamp(v * 128, -128, 127) + 128);
          break;
        case 'pcm16':
          view.setInt16(at, clamp(v * 32768, -32768, 32767), true);
          break;
        case 'pcm24': {
          const i = clamp(v * 8388608, -8388608, 8388607);
          view.setUint8(at, i & 0xff);
          view.setUint8(at + 1, (i >> 8) & 0xff);
          view.setUint8(at + 2, (i >> 16) & 0xff);
          break;
        }
        case 'pcm32':
          view.setInt32(at, clamp(v * 2147483648, -2147483648, 2147483647), true);
          break;
        case 'float32':
          view.setFloat32(at, v, true);
          break;
        default:
          view.setFloat64(at, v, true);
      }
    }
  return out;
}
