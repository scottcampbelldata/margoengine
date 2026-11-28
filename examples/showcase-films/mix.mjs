import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createMix, peakDb } from '../demo-audio/mix.mjs';

const film = process.argv[2];
const output = process.argv[3];
if (!['robot-cell', 'last-tram', 'above-the-treeline', 'the-kiln-shift'].includes(film) || !output)
  throw Error('Pass a showcase name and WAV output path.');
const sources = JSON.parse(await readFile(new URL('./audio-sources.json', import.meta.url), 'utf8'));
const cache = resolve('test-results/showcase-recordings');
await mkdir(cache, { recursive: true });
const rate = 48000;

async function load(key, filter, limit) {
  const mp3 = resolve(cache, key + '.mp3');
  if (!existsSync(mp3)) {
    const response = await fetch(sources[key].url, { signal: AbortSignal.timeout(175000) });
    if (!response.ok) throw Error('Audio download failed for ' + key + ' (' + response.status + ')');
    await writeFile(mp3, Buffer.from(await response.arrayBuffer()));
  }
  const read = spawnSync(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      mp3,
      '-t',
      String(limit),
      '-af',
      filter,
      '-ar',
      String(rate),
      '-ac',
      '2',
      '-f',
      'f32le',
      '-',
    ],
    { maxBuffer: 58_000_000, timeout: 30000 },
  );
  if (read.status !== 0) throw read.error ?? Error(read.stderr);
  const { buffer, byteOffset, byteLength } = read.stdout;
  return { channels: 2, samples: new Float32Array(buffer, byteOffset, byteLength / 4) };
}

function generate(length, fn) {
  const frames = Math.round(length * rate);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = fn(i / rate, i);
  return { samples, channels: 1 };
}

function servo(length, pitch, speed) {
  let phase = 0;
  return generate(length, (t) => {
    const p = t / length;
    const load = Math.sin(Math.PI * p) ** 0.7;
    phase += (2 * Math.PI * (pitch + speed * load + (2.7 * Math.sin(9.2 * t) + 1.4 * Math.sin(17.5 * t)))) / rate;
    return (
      load *
      (0.48 * Math.sin(phase) +
        0.22 * Math.sin(phase * 2) +
        0.12 * Math.sin(phase * 3.013) +
        0.08 * Math.sin(phase * 0.497))
    );
  });
}

function resonant(length, frequency, decay, seed) {
  return generate(length, (t) => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    const trans = (seed / 2 ** 31 - 1) * Math.exp(-t * 153);
    const ring =
      (0.54 * Math.sin(2 * Math.PI * t * frequency) + 0.31 * Math.sin(2 * Math.PI * t * frequency * 1.743)) *
      Math.exp(-t * decay);
    return Math.min(1, t * 960) * (0.43 * trans + ring);
  });
}

const mix = createMix(90);
const put = (source, { db, offset = 0, length, ...rest }) => {
  if (Math.round((offset + length) * rate) > source.samples.length / source.channels) {
    throw Error('Recording is shorter than the cue at ' + rest.at + ' seconds.');
  }
  const gain = db - peakDb(source, offset, length);
  mix.place(source, { gain, offset, length, ...rest });
};
if (film === 'robot-cell') {
  const [room, latch, gears] = await Promise.all([
    load('room', 'highpass=f=90,lowpass=f=5200', 105),
    load('latch', 'highpass=f=115,lowpass=f=5400', 3),
    load('robot-motor', 'highpass=f=167,lowpass=f=4700', 7),
  ]);
  put(room, { at: 0, offset: 6, length: 90, db: -37, fadeIn: 0.28, fadeOut: 2.9 });
  for (const [at, offset, length, pan] of [
    [5.0, 0.17, 1.03, -0.09],
    [20.6, 1.22, 1.38, -0.16],
    [42.0, 2.62, 1.59, 0.14],
    [59.2, 4.21, 1.42, 0.26],
  ])
    put(gears, { at, offset, length, db: -19.5, pan, fadeIn: 0.12, fadeOut: 0.34 });
  for (const [at, length, pitch, speed, db, pan] of [
    [0, 4.74, 148, 47, -21, 0.11],
    [5.26, 6.67, 136, 35, -27, -0.07],
    [12.06, 5.62, 143, 41, -23, -0.11],
    [20.6, 8.32, 166, 46, -21, -0.19],
    [29.23, 10.64, 124, 59, -24, 0.02],
    [42.05, 10.87, 154, 69, -22, 0.14],
    [53.05, 5.87, 146, 41, -24, 0.2],
    [59.26, 6.29, 154, 23, -23, 0.13],
    [70.11, 11.62, 140, 63, -25, -0.09],
  ])
    put(servo(length, pitch, speed), { at, length, db: db - 4, pan, fadeIn: 0.16, fadeOut: 0.21 });
  for (const [at, frequency, db, pan] of [
    [20.0, 428, -16, -0.21],
    [65.6, 588, -12, 0.25],
    [69.42, 299, -20, 0.15],
  ]) {
    const click = resonant(0.47, frequency, 13.7, Math.round(at * 4100));
    put(click, { at, length: 0.47, db, pan });
  }
  put(latch, { at: 19.98, offset: 0.01, length: 0.48, db: -21, pan: -0.17, fadeOut: 0.12 });
  const confirmed = generate(0.43, (t) => Math.sin(2 * Math.PI * 721 * t) * Math.min(1, t * 278) * Math.exp(-t * 8.5));
  put(confirmed, { at: 67.83, length: 0.43, db: -21, pan: 0.22 });
} else if (film === 'last-tram') {
  const [rain, rail, door] = await Promise.all([
    load('rain', 'highpass=f=135,lowpass=f=7000', 116),
    load('rail', 'highpass=f=110,lowpass=f=5100', 58),
    load('door', 'highpass=f=127,lowpass=f=6800', 16),
  ]);
  put(rain, { at: 0, offset: 13, length: 90, db: -29, fadeIn: 0.17, fadeOut: 2.7 });
  const travel = [
    [0, 5, 0, 0.38],
    [5, 13, 0.38, 0.54],
    [13, 19, 0.54, 0.59],
    [19, 27, 0.59, 0.71],
    [27, 35, 0.71, 0.86],
    [35, 44, 0.86, 0.45],
    [44, 52, 0.45, 0.58],
    [52, 61, 0.58, 0.72],
    [61, 70.2, 0.72, 0],
  ];
  let phase = 0;
  let section = 0;
  const motor = generate(70.3, (t) => {
    while (section < travel.length - 1 && t >= travel[section][1]) section++;
    const [a, b, f, g] = travel[section];
    const u = Math.min(1, (t - a) / (b - a));
    const p = f + (g - f) * u;
    const pitch = 104 + Math.min(1, t / 10) * 89 - Math.max(0, t - 61) * 10 + 2 * Math.sin(t * 3.6);
    phase += (2 * Math.PI * pitch) / rate;
    return (
      p *
      (0.42 * Math.sin(phase) +
        0.26 * Math.sin(phase * 1.995) +
        0.14 * Math.sin(phase * 3.01) +
        0.12 * Math.sin(phase * 0.48))
    );
  });
  put(motor, { at: 0, length: 70.3, db: -23, fadeIn: 1.2, fadeOut: 0.63 });
  const railTime = rail.samples.length / (rate * rail.channels);
  put(rail, {
    at: 24.9,
    offset: 0.1,
    length: Math.min(railTime - 0.11, 15),
    db: -16,
    fadeIn: 2.7,
    fadeOut: 3.2,
    pan: -0.16,
  });
  for (const [at, hz, db] of [
    [26.23, 471, -24],
    [28.99, 462, -22],
    [31.26, 439, -20],
    [33.66, 427, -22],
    [63.24, 538, -22],
    [65.73, 511, -24],
    [70.12, 323, -22],
  ]) {
    put(resonant(0.42, hz, 12.9, Math.round(at * 10009)), { at, length: 0.42, db, pan: -0.17 });
  }
  // The release click, slide and end stop follow the door animation's event times.
  const release = resonant(0.19, 562, 23, 7256);
  put(release, { at: 70.78, length: 0.19, db: -15, pan: 0.16 });
  put(door, { at: 70.86, offset: 0.13, length: 2.35, db: -19, fadeIn: 0.11, fadeOut: 0.44, pan: 0.16 });
  put(servo(2.43, 169, 27), { at: 70.88, length: 2.43, db: -22, fadeIn: 0.1, fadeOut: 0.18, pan: 0.15 });
  put(resonant(0.26, 353, 19, 233), { at: 73.35, length: 0.26, db: -16, pan: 0.17 });
} else if (film === 'above-the-treeline') {
  const [meadow, forest] = await Promise.all([
    load('alpine-wind', 'highpass=f=145,lowpass=f=6250', 123),
    load('alpine-forest', 'highpass=f=155,lowpass=f=7200', 118),
  ]);
  // Two continuous takes shift in perspective with the rising camera.
  put(forest, { at: 0, offset: 17, length: 76, db: -18.5, fadeIn: 0.19, fadeOut: 46, pan: -0.06 });
  put(meadow, { at: 0, offset: 24, length: 90, db: -24, fadeIn: 4.8, fadeOut: 2.8, pan: 0.04 });
} else {
  const [room, fire, door, hinge, latch] = await Promise.all([
    load('room', 'highpass=f=135,lowpass=f=5100', 113),
    load('kiln-fire', 'highpass=f=209,lowpass=f=6900', 112),
    load('kiln-door', 'highpass=f=165,lowpass=f=5800', 31),
    load('kiln-hinge', 'highpass=f=146,lowpass=f=6100', 1.31),
    load('latch', 'highpass=f=138,lowpass=f=5900', 3),
  ]);
  put(room, { at: 0, offset: 18, length: 90, db: -36, fadeIn: 0.3, fadeOut: 2.7 });
  put(fire, { at: 0.05, offset: 9.2, length: 4.63, db: -22, fadeIn: 0.44, fadeOut: 0.23, pan: 0.07 });
  put(hinge, { at: 0.29, offset: 0.06, length: 1.17, db: -22, fadeIn: 0.12, fadeOut: 0.19 });
  put(fire, { at: 27.68, offset: 26.4, length: 46.14, db: -23, fadeIn: 8, fadeOut: 7.9, pan: 0.08 });
  put(door, { at: 27.62, offset: 0.12, length: 4.3, db: -24, fadeIn: 0.1, fadeOut: 1.1, pan: -0.13 });
  put(hinge, { at: 70.12, offset: 0.16, length: 1.14, db: -26, fadeIn: 0.14, fadeOut: 0.2, pan: -0.09 });
  put(latch, { at: 19.12, offset: 0.016, length: 0.43, db: -17, fadeOut: 0.11, pan: 0.17 });
  for (const [at, hz, db, pan] of [
    [17.62, 526, -23, 0.17],
    [27.64, 356, -21, 0.04],
    [37.54, 317, -19, -0.1],
    [51.82, 928, -26, 0.13],
    [64.29, 1067, -27, -0.2],
    [73.82, 288, -11, 0.06],
    [75.35, 512, -17, 0.16],
  ]) {
    put(resonant(0.45, hz, 15.7, Math.round(at * 5023)), { at, length: 0.45, db, pan });
  }
}
await mix.save(output);
