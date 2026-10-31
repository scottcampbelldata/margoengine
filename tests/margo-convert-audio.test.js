// margo-convert audio: WAV reading and writing, mono mix-down, low-pass resampling, preset handling, the ffmpeg path
// (with an injected runner: no ffmpeg is needed or called), and audio files in `build`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../tools/margo-convert/pipeline/build.js';
import { encodeWav, mixToMono, parseWav, processAudio, resample } from '../tools/margo-convert/pipeline/audio.js';
import { preset } from '../tools/margo-convert/pipeline/presets.js';

const tone = (hz, rate, seconds, amplitude) =>
  Float32Array.from(
    { length: Math.round(rate * seconds) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate),
  );

/** Magnitude of one frequency in a signal (Goertzel). */
function magnitude(signal, hz, rate) {
  const w = (2 * Math.PI * hz) / rate;
  let re = 0,
    im = 0;
  for (let i = 0; i < signal.length; i++) {
    re += signal[i] * Math.cos(w * i);
    im -= signal[i] * Math.sin(w * i);
  }
  return (2 * Math.hypot(re, im)) / signal.length;
}

/** A WAV file of the given sample format, for the reader tests. */
function wavFile(channels, rate, bits, float, frames) {
  const width = bits / 8,
    data = new Uint8Array(frames.length * channels * width),
    view = new DataView(data.buffer);
  frames.forEach((frame, f) =>
    frame.forEach((v, c) => {
      const at = (f * channels + c) * width;
      if (float) bits === 32 ? view.setFloat32(at, v, true) : view.setFloat64(at, v, true);
      else if (bits === 8) data[at] = Math.round(v * 127) + 128;
      else if (bits === 16) view.setInt16(at, Math.round(v * 32767), true);
      else if (bits === 24) {
        const n = Math.round(v * 8388607);
        data[at] = n & 255;
        data[at + 1] = (n >> 8) & 255;
        data[at + 2] = (n >> 16) & 255;
      } else view.setInt32(at, Math.round(v * 2147483647), true);
    }),
  );
  const out = new Uint8Array(44 + data.length),
    v = new DataView(out.buffer);
  out.set(
    [...'RIFF'].map((ch) => ch.charCodeAt(0)),
    0,
  );
  v.setUint32(4, 36 + data.length, true);
  out.set(
    [...'WAVEfmt '].map((ch) => ch.charCodeAt(0)),
    8,
  );
  v.setUint32(16, 16, true);
  v.setUint16(20, float ? 3 : 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * width, true);
  v.setUint16(32, channels * width, true);
  v.setUint16(34, bits, true);
  out.set(
    [...'data'].map((ch) => ch.charCodeAt(0)),
    36,
  );
  v.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

test('parseWav reads 8, 16, 24 and 32 bit PCM and 32 and 64 bit float WAV files', () => {
  const frames = [
    [0.5, -0.25],
    [-0.75, 1],
    [0, 0.125],
  ];
  for (const [bits, float, tolerance] of [
    [8, false, 1 / 127],
    [16, false, 1e-4],
    [24, false, 1e-6],
    [32, false, 1e-8],
    [32, true, 1e-7],
    [64, true, 1e-9],
  ]) {
    const wav = parseWav(wavFile(2, 48000, bits, float, frames));
    assert.ok(wav, `${bits} ${float}`);
    assert.equal(wav.channels, 2);
    assert.equal(wav.rate, 48000);
    frames.forEach((frame, f) =>
      frame.forEach((v, c) =>
        assert.ok(
          Math.abs(wav.samples[c][f] - v) <= tolerance + 1e-9,
          `${bits}${float ? 'f' : ''} frame ${f} channel ${c}`,
        ),
      ),
    );
  }
  assert.equal(parseWav(new Uint8Array(10)), null);
  const adpcm = wavFile(1, 8000, 16, false, [[0]]);
  new DataView(adpcm.buffer).setUint16(20, 2, true);
  assert.equal(parseWav(adpcm), null, 'compressed WAV is not read');
});

test('encodeWav writes 16-bit PCM that parseWav reads back; samples clip', () => {
  const samples = [Float32Array.from([0, 0.5, -0.5, 2, -2]), Float32Array.from([1, 1, -1, 0, 0])];
  const wav = parseWav(encodeWav(samples, 22050));
  assert.equal(wav.rate, 22050);
  assert.deepEqual([...wav.samples[0].map((v) => Math.round(v * 32768))], [0, 16384, -16384, 32767, -32768]);
});

test('mixToMono averages the channels; resample keeps a tone and removes what the new rate cannot hold', {
  timeout: 60_000,
}, () => {
  const l = tone(440, 44100, 0.5, 0.5),
    r = tone(440, 44100, 0.5, 0.25);
  const [mono] = mixToMono([l, r]);
  assert.ok(Math.abs(magnitude(mono, 440, 44100) - 0.375) < 0.005);

  const half = resample(mono, 44100, 22050);
  assert.equal(half.length, Math.round(mono.length / 2));
  assert.ok(Math.abs(magnitude(half, 440, 22050) - 0.375) < 0.01, 'the tone keeps its level');

  // 15 kHz is above the new Nyquist (11.025 kHz): it must not fold back into the band.
  const high = resample(tone(15000, 44100, 0.5, 0.5), 44100, 22050);
  let peak = 0;
  for (let hz = 100; hz < 11000; hz += 100) peak = Math.max(peak, magnitude(high, hz, 22050));
  assert.ok(peak < 0.01, `alias level ${peak}`);

  // A constant signal keeps its level.
  const dc = resample(new Float32Array(1000).fill(0.5), 48000, 16000);
  assert.ok(Math.abs(dc[150] - 0.5) < 1e-4);
  assert.equal(resample(mono, 44100, 44100), mono);
});

const stereo = () => encodeWav([tone(440, 44100, 0.25, 0.5), tone(880, 44100, 0.25, 0.25)], 44100);

test('processAudio: web keeps files, mobile mixes to mono at 22.05 kHz, others pass through with a reason', () => {
  const wav = stereo();
  const web = processAudio(wav, '.wav', preset('web').audio, { ffmpeg: null });
  assert.equal(web.status, 'copied');
  assert.equal(web.bytes, wav);

  const mobile = processAudio(wav, '.wav', preset('mobile').audio, { ffmpeg: null });
  assert.equal(mobile.status, 'built');
  const back = parseWav(mobile.bytes);
  assert.deepEqual([back.channels, back.rate], [1, 22050]);
  assert.ok(mobile.bytes.length < wav.length * 0.3);
  assert.match(mobile.note, /mono, 22050 Hz/);

  // A file that is already mono and slow enough is left alone.
  const small = encodeWav([tone(440, 16000, 0.1, 0.5)], 16000);
  assert.equal(processAudio(small, '.wav', preset('mobile').audio, { ffmpeg: null }).bytes, small);

  const mp3 = Uint8Array.from([0x49, 0x44, 0x33, 3, 0]);
  const kept = processAudio(mp3, '.mp3', preset('mobile').audio, { ffmpeg: null });
  assert.equal(kept.bytes, mp3);
  assert.equal(kept.status, 'copied');

  const roblox = processAudio(wav, '.wav', preset('roblox').audio, { ffmpeg: null });
  assert.equal(roblox.status, 'copied');
  assert.match(roblox.note, /mp3 or ogg/);
  assert.match(roblox.note, /no ffmpeg/);

  const adpcm = wavFile(1, 8000, 16, false, [[0]]);
  new DataView(adpcm.buffer).setUint16(20, 2, true);
  assert.match(processAudio(adpcm, '.wav', preset('mobile').audio, { ffmpeg: null }).note, /cannot read/);
});

// Whole-argument lookups: a joined command line also holds the random temp folder, whose name can contain "-ac".
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

test('argument checks look at whole arguments, not text inside a temp folder name', () => {
  const tempName = ['-i', 'C:/tmp/margo-audio-acCdpS/in.wav', '-ar', '22050', 'C:/tmp/margo-audio-acCdpS/out.ogg'];
  // The old assertion fails on this command line although no -ac argument is passed.
  assert.throws(() => assert.doesNotMatch(tempName.join(' '), /-ac/));
  assert.ok(!tempName.includes('-ac'));
  const real = [...tempName, '-ac', '1'];
  assert.ok(real.includes('-ac'));
  assert.equal(flagValue(real, '-ac'), '1');
});

test('processAudio with ffmpeg: Ogg Vorbis for WAV and FLAC with the preset mono and rate, otherwise left alone', () => {
  const wav = stereo();
  const calls = [];
  const ok = {
    ffmpeg: { version: 'ffmpeg test' },
    run(args, files) {
      calls.push(args);
      files.write(new Uint8Array(200).fill(7));
      return { status: 0, stderr: '' };
    },
  };
  const out = processAudio(wav, '.wav', preset('mobile').audio, ok);
  assert.equal(out.extension, '.ogg');
  assert.equal(out.status, 'built');
  assert.equal(out.bytes.length, 200);
  const args = calls[0];
  assert.equal(flagValue(args, '-ac'), '1');
  assert.equal(flagValue(args, '-ar'), '22050');
  assert.equal(flagValue(args, '-c:a'), 'libvorbis');
  assert.match(flagValue(args, '-i'), /in\.wav$/);

  const web = processAudio(wav, '.wav', preset('web').audio, ok);
  assert.equal(web.extension, '.ogg');
  assert.ok(!calls[1].includes('-ac'), 'the web preset keeps the channel count');

  // Already a web format: not touched.
  const mp3 = Uint8Array.from([1, 2, 3, 4]);
  assert.equal(processAudio(mp3, '.mp3', preset('web').audio, ok).bytes, mp3);
  assert.equal(calls.length, 2);

  // Bigger than the input and not required: the WAV stays. A failing ffmpeg is reported and the WAV stays.
  const big = {
    ffmpeg: ok.ffmpeg,
    run: (_, files) => (files.write(new Uint8Array(wav.length + 10)), { status: 0, stderr: '' }),
  };
  assert.equal(processAudio(wav, '.wav', preset('web').audio, big).bytes, wav);
  const broken = { ffmpeg: ok.ffmpeg, run: () => ({ status: 1, stderr: 'Unknown encoder\nboom' }) };
  const failed = processAudio(wav, '.wav', preset('web').audio, broken);
  assert.equal(failed.bytes, wav);
  assert.match(failed.note, /ffmpeg failed \(boom\)/);

  // Roblox requires a compressed format: it takes the Ogg even when larger.
  const roblox = processAudio(wav, '.wav', preset('roblox').audio, big);
  assert.equal(roblox.extension, '.ogg');
});

test('build: audio files follow the preset and are listed in the manifest and report', {
  timeout: 120_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-convert-audio-'));
  try {
    const input = join(dir, 'in');
    mkdirSync(join(input, 'sfx'), { recursive: true });
    const wav = stereo();
    writeFileSync(join(input, 'sfx', 'zap.wav'), wav);
    writeFileSync(join(input, 'music.mp3'), Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]));
    const mobile = await build({ input, outDir: join(dir, 'out'), preset: 'mobile', ffmpeg: false });
    const zap = mobile.manifest.files.find((f) => f.source === 'sfx/zap.wav');
    assert.equal(zap.kind, 'audio');
    assert.equal(zap.status, 'built');
    assert.ok(zap.outputs[0].bytes < wav.length * 0.3);
    assert.deepEqual([parseWav(new Uint8Array(readFileSync(join(dir, 'out', zap.outputs[0].path)))).rate], [22050]);
    const music = mobile.manifest.files.find((f) => f.source === 'music.mp3');
    assert.equal(music.status, 'copied');
    assert.equal(mobile.manifest.encoders.ffmpeg, null);
    assert.match(mobile.report, /sfx\/zap\.wav\s+audio\s+built/);

    const roblox = await build({ input, outDir: join(dir, 'roblox'), preset: 'roblox', ffmpeg: false });
    const note = roblox.manifest.files.find((f) => f.source === 'sfx/zap.wav').notes.join(' ');
    assert.match(note, /mp3 or ogg/);
    assert.ok(existsSync(join(dir, 'roblox', 'sfx', 'zap.wav')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
