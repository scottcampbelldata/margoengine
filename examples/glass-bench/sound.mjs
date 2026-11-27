import { writeFile } from 'node:fs/promises';
import { between, duration } from './timeline.js';

const output = process.argv[2];
if (!output) throw new Error('Pass the output WAV path');
const rate = 48_000;
const count = rate * duration;
const bytes = Buffer.alloc(44 + count * 4);
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

const tau = Math.PI * 2;
const events = [
  1.04, 2.75, 3.5, 4.18, 4.92, 5.87, 6.45, 27.17, 27.78, 28.34, 28.92, 29.53, 30.22, 30.97, 31.83, 33.25, 34.71,
];
const room = [0, 0];
const metal = [0, 0];
let cursor = 0;
let seed = 190_331;
let clickAt = -100;
const noise = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
};

for (let i = 0; i < count; i++) {
  const time = i / rate;
  if (time >= events[cursor]) clickAt = events[cursor++];
  const since = time - clickAt;
  const tick = Math.exp(-since * 84);
  const edge = Math.exp(-since * 37);
  const roomFade = between(time, 0, 0.45) * (1 - between(time, 58.2, duration));
  const padFade = between(time, 4.6, 11.4) * (1 - between(time, 55.2, duration));
  const shift = between(time, 32, 43.8);
  const servo = between(time, 27, 27.4) * (1 - between(time, 31.2, 31.85));
  const lamp = between(time, 34.5, 36.8);
  const common = noise();

  for (let channel = 0; channel < 2; channel++) {
    const z = channel * 0.13;
    const air = common * 0.7 + noise() * 0.3;
    room[channel] += (air - room[channel]) * 0.0048;
    metal[channel] += (air - metal[channel]) * 0.25;
    const oscillator = (hz, phase) => Math.sin(tau * hz * time + phase);
    const chord =
      oscillator(73.416, z) * 0.017 +
      oscillator(146.832, z + Math.sin(time * 0.33) * 0.33) * 0.0085 +
      oscillator(220.0, z * 3 + time * 0.041) * 0.0065 +
      oscillator(329.628, z * 6 + time * 0.036) * 0.0032 * shift +
      oscillator(349.228, z * 6 + time * 0.053) * 0.0022 * (1 - shift);
    const hum = oscillator(119.96, z * 0.2) * (0.0011 + 0.0011 * lamp);
    const stage = servo * (0.007 * room[channel] + 0.002 * oscillator(503, z + Math.sin(time * 9)));
    const click = (air - metal[channel]) * tick * 0.037 + Math.sin(tau * 2180 * since + z) * edge * 0.024;
    const value = roomFade * (room[channel] * 0.12 + hum + stage + click) + padFade * chord;
    bytes.writeInt16LE(Math.round(value * 32767), 44 + (i * 2 + channel) * 2);
  }
}
await writeFile(output, bytes);
