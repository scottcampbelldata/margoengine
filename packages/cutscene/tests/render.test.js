import assert from 'node:assert/strict';
import test from 'node:test';
import { Cutscene } from '@margoengine/cutscene';
import { cutsceneFrames, mixCutsceneAudio, renderCutscene } from '@margoengine/cutscene/render';

const RATE = 8000;
const doc = (tracks, extra = {}) => ({ format: 'margo-cutscene', version: 1, duration: 4, tracks, ...extra });
const audio = (clips, id = 'music') => ({ type: 'audio', id, clips });
/** A sound of given samples per channel, shaped as an AudioBuffer. */
const sound = (channels, sampleRate = RATE) => ({
  sampleRate,
  numberOfChannels: channels.length,
  length: channels[0].length,
  getChannelData: (i) => channels[i],
});
const flat = (value, seconds = 1, rate = RATE) => sound([new Float32Array(seconds * rate).fill(value)], rate);
/** A ramp from 0 to 1 over its length: each sample says where in the sound it was read. */
const ramp = (seconds = 2) => sound([Float32Array.from({ length: seconds * RATE }, (_, i) => i / (seconds * RATE))]);
const mix = (tracks, sounds, options, extra) =>
  mixCutsceneAudio(new Cutscene(doc(tracks, extra)), sounds, { sampleRate: RATE, ...options });
const near = (a, b, limit = 1e-5) => assert.ok(Math.abs(a - b) <= limit, `${a} is not ${b} within ${limit}`);

test('frames fall at i / fps and the last starts before the end', () => {
  const cutscene = new Cutscene(doc([]));
  const frames = [...cutsceneFrames(cutscene, { fps: 10 })];
  assert.equal(frames.length, 40);
  assert.deepEqual(frames.map((frame) => frame.time), frames.map((_, i) => i / 10));
  assert.equal(frames[3].state.time, 0.3);
  // 0.3 * 30 is 9.000000000000002 in doubles: rounding must not add a tenth frame.
  assert.equal([...cutsceneFrames(new Cutscene(doc([], { duration: 0.3 })), { fps: 30 })].length, 9);
  // A length that is not a whole number of frames keeps the part frame.
  assert.equal([...cutsceneFrames(cutscene, { fps: 10, from: 1, to: 1.25 })].length, 3);
  assert.deepEqual([...cutsceneFrames(cutscene, { fps: 10, from: 1, to: 1.25 })].map((frame) => frame.time), [1, 1.1, 1.2]);
  assert.throws(() => [...cutsceneFrames(cutscene, { fps: 0 })], /fps must be/);
  assert.throws(() => [...cutsceneFrames(cutscene, { from: 3, to: 2 })], /Render span/);
  assert.throws(() => [...cutsceneFrames(cutscene, { to: 5 })], /Render span/);
});

test('a clip sounds exactly across its span, at its volume', () => {
  const { channels, peak, sampleRate } = mix([audio([{ start: 1, duration: 1, sound: 'one', volume: 0.5 }])], { one: flat(1, 2) });
  assert.equal(sampleRate, RATE);
  assert.equal(channels.length, 2);
  assert.equal(channels[0].length, 4 * RATE);
  assert.equal(channels[0][RATE - 1], 0);
  assert.equal(channels[0][RATE], 0.5);
  assert.equal(channels[1][2 * RATE - 1], 0.5);
  assert.equal(channels[0][2 * RATE], 0);
  assert.equal(peak, 0.5);
});

test('a clip reads the sound from its offset, one second of sound per second', () => {
  const { channels } = mix([audio([{ start: 1, duration: 1, sound: 'ramp', offset: 0.5 }])], { ramp: ramp() }, { channels: 1 });
  for (const at of [0, 0.25, 0.5, 0.999]) near(channels[0][Math.round((1 + at) * RATE)], (0.5 + at) / 2, 1e-4);
});

test('fades follow straight lines', () => {
  const { channels } = mix([audio([{ start: 0, duration: 2, sound: 'one', fadeIn: 1, fadeOut: 0.5 }])], { one: flat(1, 2) }, { channels: 1 });
  near(channels[0][RATE / 4], 0.25, 1e-3);
  near(channels[0][RATE / 2], 0.5, 1e-3);
  near(channels[0][1.25 * RATE], 1, 1e-3);
  near(channels[0][1.75 * RATE], 0.5, 1e-3);
});

test('a nested timeline places its clips, and its speed reads the sound faster', () => {
  const timelines = {
    inner: { duration: 2, tracks: [audio([{ start: 0, duration: 2, sound: 'ramp' }])] },
  };
  const tracks = [{ type: 'timeline', id: 'scene', clips: [{ start: 1, duration: 1, timeline: 'inner', speed: 2 }] }];
  const { channels } = mix(tracks, { ramp: ramp() }, { channels: 1 }, { timelines });
  assert.equal(channels[0][RATE - 1], 0);
  // Half a second in, the nested time is 1 s of the 2 s ramp.
  near(channels[0][1.5 * RATE], 0.5, 1e-3);
  near(channels[0][1.75 * RATE], 0.75, 1e-3);
});

test('overlapping clips add up, peak reports it, and a muted track is silent', () => {
  const clip = { start: 0, duration: 1, sound: 'one' };
  const { channels, peak } = mix([audio([clip, clip]), audio([clip], 'more')], { one: flat(0.5) }, { channels: 1 });
  assert.equal(channels[0][100], 1.5);
  assert.equal(peak, 1.5);
  assert.equal(mix([{ ...audio([clip]), muted: true }], { one: flat(0.5) }).peak, 0);
});

test('channels map: mono to both, stereo keeps sides, stereo to mono averages', () => {
  const clip = audio([{ start: 0, duration: 1, sound: 's' }]),
    stereo = sound([new Float32Array(RATE).fill(0.2), new Float32Array(RATE).fill(0.8)]);
  const both = mix([clip], { s: flat(0.5) }).channels;
  assert.deepEqual([both[0][9], both[1][9]], [0.5, 0.5]);
  const sides = mix([clip], { s: stereo }).channels;
  near(sides[0][9], 0.2);
  near(sides[1][9], 0.8);
  near(mix([clip], { s: stereo }, { channels: 1 }).channels[0][9], 0.5);
});

test('a sound of another rate is read at its own rate, and past its end is silence', () => {
  const low = sound([Float32Array.from({ length: 2000 }, (_, i) => i / 2000)], 2000);
  const { channels } = mix([audio([{ start: 0, duration: 2, sound: 'low' }])], { low }, { channels: 1 });
  near(channels[0][RATE / 2], 0.5, 1e-3);
  assert.equal(channels[0][1.5 * RATE], 0);
});

test('a span mixes only itself, from its own start', () => {
  const { channels } = mix([audio([{ start: 1, duration: 2, sound: 'one' }])], { one: flat(1, 2) }, { from: 2, to: 2.5, channels: 1 });
  assert.equal(channels[0].length, RATE / 2);
  assert.equal(channels[0][0], 1);
  assert.equal(channels[0].at(-1), 1);
});

test('a sound nobody gave is refused by name, even one named like an object member', () => {
  assert.throws(() => mix([audio([{ start: 0, duration: 1, sound: 'gone' }])], {}), /No sound 'gone' to mix/);
  assert.throws(() => mix([audio([{ start: 0, duration: 1, sound: 'constructor' }])], {}), /No sound 'constructor'/);
});

test('renderCutscene refuses bad options before it touches the engine', async () => {
  await assert.rejects(renderCutscene(null, doc([]), {}), /needs apply/);
  await assert.rejects(renderCutscene(null, doc([]), { apply() {}, fps: -1 }), /fps must be/);
  await assert.rejects(renderCutscene(null, doc([]), { apply() {}, to: 9 }), /Render span/);
});
