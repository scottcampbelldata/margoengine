import { createMix, recording } from '../demo-audio/mix.mjs';
import { duration, underwaterPass } from './timeline.js';

const output = process.argv[2];
if (!output) throw new Error('Pass the output WAV path.');

const filters = {
  'cargo-hull': 'highpass=f=207,lowpass=f=6800',
  harbor: 'highpass=f=155,lowpass=f=6400',
  boardwalk: 'highpass=f=160,lowpass=f=6500',
  engine: 'highpass=f=140,lowpass=f=1200',
  'bow-close': 'highpass=f=175,lowpass=f=6700',
  'bow-distant': 'highpass=f=155,lowpass=f=5900',
  submerged: 'highpass=f=115,lowpass=f=1850',
};
const recordings = new Map(
  await Promise.all(Object.entries(filters).map(async ([name, filter]) => [name, await recording(name, filter)])),
);
const { start, end } = underwaterPass;

// Keep each recording moving forwards. Changing position on the boat changes the recording and distance.
const cues = [
  ['cargo-hull', { at: 0, offset: 2.3, length: 4.39, gain: -8.5, fadeIn: 0.18, fadeOut: 0.45, pan: 0.14 }],
  ['harbor', { at: 4.05, offset: 6, length: 47.07, gain: 2.7, fadeIn: 0.38, fadeOut: 0.26 }],
  ['boardwalk', { at: 4.05, offset: 11.3, length: 15.16, gain: 6.0, fadeIn: 0.52, fadeOut: 1.1, pan: -0.16 }],
  ['engine', { at: 5.5, offset: 2.8, length: 12.8, gain: -16, fadeIn: 1.4, fadeOut: 3.75, pan: 0.12 }],
  ['bow-close', { at: 18.57, offset: 46.75, length: 16.69, gain: 2.3, fadeIn: 0.9, fadeOut: 1.2 }],
  ['cargo-hull', { at: 27.32, offset: 8.15, length: 7.95, gain: -12, fadeIn: 0.62, fadeOut: 1.35, pan: 0.2 }],
  ['bow-distant', { at: 34.9, offset: 1.25, length: 8.94, gain: 9, fadeIn: 0.7, fadeOut: 0.85 }],
  ['cargo-hull', { at: 43.2, offset: 17.82, length: 7.92, gain: -11.5, fadeIn: 0.65, fadeOut: 0.7, pan: -0.23 }],
  ['submerged', { at: start - 0.12, offset: 25.3, length: end - start + 0.32, gain: 14, fadeIn: 0.2, fadeOut: 0.18 }],
  [
    'bow-distant',
    { at: end - 0.08, offset: 12.4, length: duration - end + 0.08, gain: 8.4, fadeIn: 0.23, fadeOut: 7.3 },
  ],
  ['bow-close', { at: 75.2, offset: 69.1, length: 7.62, gain: 3.3, fadeIn: 0.8, fadeOut: 1.1, pan: 0.16 }],
];

const mix = createMix(duration);
const usedThrough = new Map();
for (const [name, cue] of cues) {
  if (cue.offset < (usedThrough.get(name) ?? 0)) throw new Error('Repeated recording section in ' + name);
  usedThrough.set(name, cue.offset + cue.length);
  mix.place(recordings.get(name), cue);
}

await mix.save(output);
