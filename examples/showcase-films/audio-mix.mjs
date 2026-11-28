// The stereo mix bus the showcase films' soundtracks are built on (mix.mjs): sources are 48 kHz float PCM, placed with
// gain in dB, an equal-power pan and linear fades, and saved as 16-bit stereo WAV with the peak held at -2 dBFS.

const rate = 48_000;
const decibels = (value) => 10 ** (value / 20);

/**
 * Peak level in dBFS of `source` ({samples, channels}) over `length` seconds from `offset` seconds.
 * @returns {number} 20 log10 of the largest absolute sample (-Infinity for silence).
 */
export function peakDb(source, offset, length) {
  const start = Math.round(offset * rate) * source.channels;
  const end = Math.min(source.samples.length, start + Math.round(length * rate) * source.channels);
  let peak = 0;
  for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(source.samples[i]));
  return 20 * Math.log10(peak);
}

/**
 * A stereo mix `duration` seconds long. `place(source, cue)` adds `length` seconds of `source` from `offset` at `at`
 * seconds with `gain` dB, `pan` -1 (left) to 1 (right) and `fadeIn` / `fadeOut` seconds; `wav()` returns the 16-bit
 * WAV bytes, scaled so the loudest sample sits at -2 dBFS; `save(path)` writes them.
 */
export function createMix(duration) {
  const frames = Math.round(rate * duration);
  const output = new Float32Array(2 * frames);
  function place(source, { at, offset = 0, length, gain, fadeIn = 0, fadeOut = 0, pan = 0 }) {
    const start = Math.round(at * rate);
    const first = Math.round(offset * rate);
    const count = Math.min(Math.round(length * rate), source.samples.length / source.channels - first, frames - start);
    if (!Number.isFinite(gain) || start < 0 || count <= 0) throw new RangeError('Invalid cue at ' + at);
    const left = decibels(gain) * Math.sqrt(1 - pan);
    const right = decibels(gain) * Math.sqrt(1 + pan);
    for (let i = 0; i < count; i++) {
      const time = i / rate;
      const incoming = fadeIn ? Math.min(1, time / fadeIn) : 1;
      const outgoing = fadeOut ? Math.min(1, (count - i - 1) / (fadeOut * rate)) : 1;
      const envelope = incoming * outgoing;
      const index = (first + i) * source.channels;
      output[2 * (start + i)] += envelope * left * source.samples[index];
      output[2 * (start + i) + 1] += envelope * right * source.samples[index + source.channels - 1];
    }
  }
  function wav() {
    const bytes = Buffer.alloc(44 + frames * 4);
    bytes.write('RIFF');
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(2, 22);
    bytes.writeUInt32LE(rate, 24);
    bytes.writeUInt32LE(rate * 4, 28);
    bytes.writeUInt16LE(4, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36);
    bytes.writeUInt32LE(frames * 4, 40);
    let peak = 0;
    for (let i = 0; i < output.length; i++) peak = Math.max(peak, Math.abs(output[i]));
    const protection = Math.min(1, decibels(-2) / Math.max(peak, 1e-12));
    for (let i = 0; i < output.length; i++) bytes.writeInt16LE(Math.round(output[i] * 32767 * protection), 44 + i * 2);
    return bytes;
  }
  async function save(path) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, wav());
  }
  return { place, wav, save };
}
