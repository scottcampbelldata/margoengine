// @ts-check
// Audio handling for margo-convert. Written from the WAVE (RIFF) format description: PCM and float WAV files can be
// mixed to mono and resampled here, with a windowed-sinc low-pass filter. Ogg Vorbis is produced only when an
// `ffmpeg` with the encoder is already on the PATH; nothing is downloaded. Without it, files that need a codec are
// passed through unchanged and the manifest says so.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** @typedef {import('./presets.js').AudioPreset} AudioPreset */

/**
 * A parsed WAV file.
 * @typedef {object} Wav
 * @property {number} channels
 * @property {number} rate samples per second
 * @property {Float32Array[]} samples one array per channel, -1..1
 */

/**
 * Reads a PCM (8, 16, 24 or 32 bit integer) or IEEE float (32 or 64 bit) WAV file.
 * @param {Uint8Array} bytes
 * @returns {Wav|null} null for anything else (compressed WAV, a damaged file)
 */
export function parseWav(bytes) {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (/** @type {number} */ at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let format = 0,
    channels = 0,
    rate = 0,
    bits = 0,
    dataAt = -1,
    dataLength = 0;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at + 4, true),
      body = at + 8;
    if (tag(at) === 'fmt ' && body + 16 <= bytes.length) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (format === 0xfffe && size >= 40) format = view.getUint16(body + 24, true);
    } else if (tag(at) === 'data') {
      dataAt = body;
      dataLength = Math.min(size, bytes.length - body);
    }
    at = body + size + (size & 1);
  }
  const isFloat = format === 3;
  if ((format !== 1 && !isFloat) || !channels || !rate || dataAt < 0) return null;
  if (isFloat ? bits !== 32 && bits !== 64 : ![8, 16, 24, 32].includes(bits)) return null;
  const width = bits / 8,
    frames = Math.floor(dataLength / (width * channels)),
    samples = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++)
    for (let c = 0; c < channels; c++) {
      const at = dataAt + (f * channels + c) * width;
      /** @type {number} */ let v;
      if (isFloat) v = bits === 32 ? view.getFloat32(at, true) : view.getFloat64(at, true);
      else if (bits === 8) v = (bytes[at] - 128) / 128;
      else if (bits === 16) v = view.getInt16(at, true) / 32768;
      else if (bits === 24) v = (((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) << 8) >> 8) / 8388608;
      else v = view.getInt32(at, true) / 2147483648;
      samples[c][f] = v;
    }
  return { channels, rate, samples };
}

/**
 * A 16-bit PCM WAV file.
 * @param {Float32Array[]} samples one array per channel, -1..1 (clipped)
 * @param {number} rate
 * @returns {Uint8Array}
 */
export function encodeWav(samples, rate) {
  const channels = samples.length,
    frames = samples[0].length,
    dataBytes = frames * channels * 2,
    out = new Uint8Array(44 + dataBytes),
    view = new DataView(out.buffer);
  const text = (/** @type {number} */ at, /** @type {string} */ s) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let f = 0; f < frames; f++)
    for (let c = 0; c < channels; c++)
      view.setInt16(
        44 + (f * channels + c) * 2,
        Math.max(-32768, Math.min(32767, Math.round(samples[c][f] * 32768))),
        true,
      );
  return out;
}

/** @param {Float32Array[]} samples @returns {Float32Array[]} one channel: the average of all */
export function mixToMono(samples) {
  if (samples.length === 1) return samples;
  const out = new Float32Array(samples[0].length);
  for (const channel of samples) for (let i = 0; i < out.length; i++) out[i] += channel[i] / samples.length;
  return [out];
}

const ZERO_CROSSINGS = 16;

/**
 * Resamples one channel to another rate with a Hann-windowed sinc low-pass whose cutoff is 95% of the lower Nyquist
 * frequency, normalised so a constant signal keeps its level.
 * @param {Float32Array} input @param {number} from @param {number} to @returns {Float32Array}
 */
export function resample(input, from, to) {
  if (from === to) return input;
  const step = from / to,
    length = Math.max(1, Math.round(input.length / step)),
    out = new Float32Array(length),
    cutoff = Math.min(1, to / from) * 0.95,
    half = ZERO_CROSSINGS / cutoff;
  for (let j = 0; j < length; j++) {
    const t = j * step;
    let sum = 0,
      weights = 0;
    for (let i = Math.max(0, Math.ceil(t - half)); i <= Math.min(input.length - 1, Math.floor(t + half)); i++) {
      const x = i - t,
        arg = Math.PI * cutoff * x,
        sinc = x === 0 ? 1 : Math.sin(arg) / arg,
        w = sinc * 0.5 * (1 + Math.cos((Math.PI * x) / half));
      sum += input[i] * w;
      weights += w;
    }
    out[j] = weights ? sum / weights : 0;
  }
  return out;
}

/**
 * What became of one audio file.
 * @typedef {object} AudioResult
 * @property {Uint8Array} bytes
 * @property {string} extension with the dot, `.wav` or `.ogg`
 * @property {'built'|'copied'} status
 * @property {string} note empty when nothing needed saying
 */

/**
 * How `ffmpeg` is run. `run` gets the argument list and the output file; the default spawns `ffmpeg`.
 * @typedef {object} AudioTools
 * @property {{version: string}|null} ffmpeg the ffmpeg found, null when there is none that can write Ogg Vorbis
 * @property {(args: string[], files: {output: string, write: (bytes: Uint8Array) => void}) => {status: number|null, stderr?: string}} [run]
 */

/** @type {{encoder: boolean, version: string}|null|undefined} */
let ffmpegProbe;

/**
 * The `ffmpeg` on the PATH, when it can write Ogg Vorbis; null otherwise. Looked up once.
 * @returns {{version: string}|null}
 */
export function findFfmpeg() {
  if (ffmpegProbe === undefined) {
    const version = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 10_000 });
    if (version.status !== 0) ffmpegProbe = null;
    else {
      const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 });
      ffmpegProbe = {
        encoder: /\blibvorbis\b/.test(encoders.stdout ?? ''),
        version: (version.stdout ?? '').split('\n')[0],
      };
    }
  }
  return ffmpegProbe?.encoder ? { version: ffmpegProbe.version } : null;
}

/** The formats the Ogg conversion starts from; MP3, AAC, Opus and Ogg are web formats already and are never re-encoded. */
const SOURCE_FORMATS = new Set(['.wav', '.flac']);

/** @param {string[]} args @returns {{status: number|null, stderr?: string}} */
const spawnFfmpeg = (args) => spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 300_000 });

/**
 * Applies a preset's audio settings to one file. WAV files are mixed down and resampled here; with an ffmpeg that has
 * libvorbis, WAV and FLAC files become Ogg Vorbis when the preset asks for it. Everything else passes through.
 * @param {Uint8Array} bytes @param {string} extension lower-case, with the dot @param {AudioPreset} preset
 * @param {AudioTools} [tools] default: the ffmpeg on the PATH, if any
 * @returns {AudioResult}
 */
export function processAudio(bytes, extension, preset, tools = { ffmpeg: findFfmpeg() }) {
  const keep = (/** @type {string} */ note) => ({ bytes, extension, status: /** @type {const} */ ('copied'), note });
  const wav = extension === '.wav' ? parseWav(bytes) : null;
  if (extension === '.wav' && !wav)
    return keep('WAV in a format margo-convert cannot read (compressed or damaged); left as it is');
  const notes = /** @type {string[]} */ ([]);

  if (preset.format === 'ogg' && SOURCE_FORMATS.has(extension) && tools.ffmpeg) {
    const dir = mkdtempSync(join(tmpdir(), 'margo-audio-'));
    try {
      const input = join(dir, `in${extension}`),
        output = join(dir, 'out.ogg');
      writeFileSync(input, bytes);
      const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input];
      if (preset.mono) args.push('-ac', '1');
      if (preset.maxSampleRate && (!wav || wav.rate > preset.maxSampleRate))
        args.push('-ar', String(preset.maxSampleRate));
      args.push('-vn', '-c:a', 'libvorbis', '-q:a', '4', output);
      const run = (tools.run ?? spawnFfmpeg)(args, { output, write: (data) => writeFileSync(output, data) });
      if (run.status === 0 && existsSync(output)) {
        const out = new Uint8Array(readFileSync(output));
        if (out.length < bytes.length || preset.requireCompressed)
          return {
            bytes: out,
            extension: '.ogg',
            status: 'built',
            note: `Ogg Vorbis by ffmpeg (${bytes.length} -> ${out.length} bytes)`,
          };
        notes.push('the Ogg Vorbis file was not smaller');
      } else notes.push(`ffmpeg failed (${(run.stderr ?? '').trim().split('\n').at(-1) || 'no message'})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (wav) {
    const tooFast = preset.maxSampleRate > 0 && wav.rate > preset.maxSampleRate,
      mixDown = preset.mono && wav.channels > 1;
    if (tooFast || mixDown) {
      const rate = tooFast ? preset.maxSampleRate : wav.rate;
      let channels = mixDown ? mixToMono(wav.samples) : wav.samples;
      if (tooFast) channels = channels.map((c) => resample(c, wav.rate, rate));
      const out = encodeWav(channels, rate);
      const what = [mixDown ? 'mono' : '', tooFast ? `${rate} Hz` : ''].filter(Boolean).join(', ');
      notes.push(`${what} 16-bit WAV (${bytes.length} -> ${out.length} bytes)`);
      if (preset.requireCompressed) notes.push('the target takes mp3 or ogg only: convert it with ffmpeg');
      return { bytes: out, extension, status: 'built', note: notes.join('; ') };
    }
  }
  if (preset.requireCompressed && SOURCE_FORMATS.has(extension))
    notes.push('the target takes mp3 or ogg only and no ffmpeg with libvorbis was found: convert the file with ffmpeg');
  else if (!wav && (preset.mono || preset.maxSampleRate) && !notes.length)
    notes.push(
      `${extension.slice(1)} left as it is (mixing down and resampling need a decoder: only WAV is handled here)`,
    );
  return keep(notes.join('; '));
}
