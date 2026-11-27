import { writeFile } from 'node:fs/promises';
import { breathCycleAt, duration } from './timeline.js';
import { showcaseDiverTime } from './showcase.js';

const output = process.argv[2];
if (!output) throw new Error('Pass the output WAV path');

const rate = 48_000;
const count = rate * duration;
const pcm = Buffer.alloc(44 + count * 4);
pcm.write('RIFF', 0);
pcm.writeUInt32LE(pcm.length - 8, 4);
pcm.write('WAVEfmt ', 8);
pcm.writeUInt32LE(16, 16);
pcm.writeUInt16LE(1, 20);
pcm.writeUInt16LE(2, 22);
pcm.writeUInt32LE(rate, 24);
pcm.writeUInt32LE(rate * 4, 28);
pcm.writeUInt16LE(4, 32);
pcm.writeUInt16LE(16, 34);
pcm.write('data', 36);
pcm.writeUInt32LE(count * 4, 40);

const tau = Math.PI * 2;
const waterline = 17;
let seed = 430_027;
const noise = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
};
const fade = (x) => {
  const u = Math.min(1, Math.max(0, x));
  return u * u * (3 - 2 * u);
};
const channels = Array.from({ length: 2 }, () => ({ swell: 0, wash: 0, air: 0 }));

for (let sample = 0; sample < count; sample++) {
  const t = sample / rate;
  const mix = fade((t - waterline + 0.25) / 0.8);
  const breath = breathCycleAt(showcaseDiverTime(t));
  const regulator = fade(breath * 13) * (1 - fade((breath - 0.54) / 0.78)) * (1 - fade((t - 13.3) / 0.7));
  const burst = fade((t - waterline + 0.25) * 8) * Math.exp(-Math.max(0, t - waterline) * 2.9);
  const wake = fade((t - 40.5) / 2.1) * (1 - fade((t - 50.6) / 2.2));
  const swell = (0.5 + 0.5 * Math.sin(t * 1.29 + 0.7 * Math.sin(t * 0.38))) ** 2;
  const motor =
    (Math.sin(t * tau * 44 + 0.11 * Math.sin(t * 1.1)) + 0.22 * Math.sin(t * tau * 88)) *
    (0.018 + 0.012 * wake) *
    (0.89 + 0.11 * Math.sin(t * 2.8));
  const distantMotor = 0.008 * Math.sin(t * tau * 41) * fade((t - 12.7) / 4.2);
  const envelope = fade(t / 0.3) * fade((duration - t) / 2.0);
  const common = noise();

  for (const [i, filter] of channels.entries()) {
    const input = common * 0.74 + noise() * 0.26;
    filter.swell += (input - filter.swell) * 0.009;
    filter.wash += (input - filter.wash) * 0.083;
    filter.air += (input - filter.air) * 0.31;
    const bubbles = (0.65 + 0.35 * Math.sin(t * 45 + i * 0.26 + Math.sin(t * 12))) * filter.wash * regulator;
    const below = filter.swell * 0.68 + 0.36 * bubbles + distantMotor;
    const above =
      filter.swell * 0.38 +
      (0.15 + 0.31 * swell + 0.21 * wake) * filter.wash +
      (0.07 + 0.07 * wake) * filter.air +
      motor;
    const splash = burst * (0.49 * filter.wash + 0.1 * filter.air);
    const signal = envelope * ((1 - mix) * below + mix * above + splash);
    pcm.writeInt16LE(Math.round(signal * 32767), 44 + (sample * 2 + i) * 2);
  }
}

await writeFile(output, pcm);
