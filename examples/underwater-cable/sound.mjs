import { writeFile } from 'node:fs/promises';
import { breathCycleAt, diveAt, duration } from './timeline.js';

const path = process.argv[2];
if (!path) throw new Error('Pass the output WAV path');
const rate = 48000;
const count = rate * duration;
const bytes = Buffer.alloc(44 + count * 4);
const tau = 2 * Math.PI;
let seed = 211321;
const white = () => {
  seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
};

const smooth = (x) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

function writeHeader() {
  bytes.write('RIFF', 0);
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
  bytes.writeUInt32LE(count * 4, 40);
}

writeHeader();
const depths = [0, 0];
const crests = [0, 0];
const clicks = [0, 0];
for (let i = 0; i < count; i++) {
  const t = i / rate;
  const submerged = smooth((t - diveAt) / 0.85);
  const swell = 0.36 + 0.44 * (0.5 + 0.5 * Math.sin(t * 1.68 + Math.sin(t * 0.52))) ** 2;
  const dive = t - diveAt;
  const impact = dive >= 0 ? Math.exp(-dive * 4.2) * (1 - Math.exp(-dive * 65)) : 0;
  const below = Math.max(0, t - diveAt);
  const breath = breathCycleAt(t);
  const onDiver = smooth((t - 18.4) / 1.2) * (1 - smooth((t - 36.7) / 0.5));
  const exhale = submerged * onDiver * smooth(breath * 14) * (1 - smooth((breath - 0.78) * 1.42));
  const engine =
    (Math.sin(t * tau * 47) * 0.027 + Math.sin(t * tau * 71) * 0.009) *
    (0.82 * Math.exp(-below * 0.22) + 0.08) *
    (0.89 + 0.11 * Math.sin(t * 2.7));
  const passage =
    0.042 *
    Math.sin(t * tau * 32 + 1.38 * Math.sin(t * 2.1)) *
    (Math.exp(-((t - 13.7) ** 2) / 8) + 0.76 * Math.exp(-((t - 44.3) ** 2) / 10));
  const fade = smooth(t / 0.42) * smooth((duration - t) / 1.35);
  const shared = white();
  for (let channel = 0; channel < 2; channel++) {
    const input = shared * 0.66 + white() * 0.34;
    depths[channel] += (input - depths[channel]) * 0.008;
    crests[channel] += (input - crests[channel]) * 0.1;
    clicks[channel] += (input - clicks[channel]) * 0.31;
    const foam = (0.48 * crests[channel] + 0.075 * clicks[channel]) * swell;
    const sea = depths[channel] * 0.39 + foam;
    const pulse = 0.43 + 0.57 * (0.5 + 0.5 * Math.sin(t * 38 + channel * 0.46 + Math.sin(t * 12))) ** 4;
    const belowWater = depths[channel] * 0.51 + crests[channel] * 0.18 * exhale * pulse;
    const splash = impact * (crests[channel] * 0.49 + depths[channel] * 0.43);
    const sample =
      fade * ((sea + engine) * (1 - submerged) + (belowWater + engine * 0.66 + passage) * submerged + splash);
    const clamped = Math.max(-1, Math.min(1, sample));
    bytes.writeInt16LE(Math.round(clamped * 32767), 44 + (i * 2 + channel) * 2);
  }
}

await writeFile(path, bytes);
