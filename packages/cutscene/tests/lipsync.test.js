import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Cutscene, CutscenePlayer, validateCutscene } from '@margoengine/cutscene';
import {
  VISEMES,
  analyseSpeech,
  lipSyncTrack,
  mouthOf,
  mouthShapes,
  visemeOf,
  visemesAt,
} from '@margoengine/cutscene/lipsync';
import { FACE_SHAPES } from '../../rigging/dist/face.js';
import { VRMExpressions, readVRM } from '../../rigging/dist/vrm.js';

const fixture = (name) => new URL(`fixtures/arctic/${name}`, import.meta.url);
const near = (a, b, limit = 1e-9) => assert.ok(Math.abs(a - b) <= limit, `${a} is not ${b} within ${limit}`);
const doc = (tracks, extra = {}) => ({ format: 'margo-cutscene', version: 1, duration: 4, tracks, ...extra });
const line = (phonemes, extra = {}) => ({ start: 0, duration: 2, phonemes, ...extra });
const track = (clips, extra = {}) => ({ type: 'lipsync', id: 'ada', target: 'ada', clips, ...extra });
const build = (tracks, extra) => new Cutscene(doc(tracks, extra), { tracks: [lipSyncTrack()] });

/** A real recording: 16-bit mono WAV with a plain 44-byte header, as these files have. */
function readWAV(name) {
  const file = readFileSync(fixture(`${name}.wav`)),
    view = new DataView(file.buffer, file.byteOffset, file.length);
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint16(34, true), 16, '16-bit');
  const rate = view.getUint32(24, true),
    samples = new Float32Array((file.length - 44) >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(44 + i * 2, true) / 32768;
  return { samples, rate };
}
/** Its hand-checked label file: end time and ARPAbet symbol per line. */
const readLabels = (name) =>
  readFileSync(fixture(name), 'utf8')
    .split('\n')
    .map((row) => row.trim().split(/\s+/))
    .filter((row) => row.length === 3)
    .map(([end, , phoneme]) => ({ end: Number(end), phoneme }));

test('phonemes map to visemes, with stress digits and in either case', () => {
  assert.equal(visemeOf('AH0'), 'aa');
  assert.equal(visemeOf('ey'), 'E');
  assert.equal(visemeOf('IY1'), 'ih');
  assert.equal(visemeOf('m'), 'PP');
  assert.equal(visemeOf('pau'), 'sil');
  assert.equal(visemeOf('kk'), 'kk');
  assert.equal(visemeOf('xx'), null);
  // Every ARPAbet symbol of the CMU dictionary has a mouth.
  for (const symbol of 'AA AE AH AO AW AY B CH D DH EH ER EY F G HH IH IY JH K L M N NG OW OY P R S SH T TH UH UW V W Y Z ZH'.split(' '))
    assert.ok(VISEMES.includes(visemeOf(symbol)), symbol);
});

test('a sound holds its viseme in full, and two neighbours share the mouth across their edge', () => {
  const clip = line([
    { time: 0.2, phoneme: 'aa' },
    { time: 0.6, phoneme: 'uw' },
    { time: 1, phoneme: 'sil' },
  ]);
  assert.deepEqual(visemesAt(clip, 0.4, 0.1), { aa: 1 });
  assert.deepEqual(visemesAt(clip, 0.1, 0.1), {});
  // On the edge each sound is half way in: reach is (t - from + half) / blend.
  const edge = visemesAt(clip, 0.6, 0.1);
  near(edge.aa, 0.5);
  near(edge.ou, 0.5);
  // A quarter of the way across the blend.
  const cross = visemesAt(clip, 0.575, 0.1);
  near(cross.aa, 0.75);
  near(cross.ou, 0.25);
  // Into silence the mouth closes by itself: what is left of 1 is rest.
  near(visemesAt(clip, 1, 0.1).ou, 0.5);
  assert.deepEqual(visemesAt(clip, 1.5, 0.1), {});
  // No blend: hard steps.
  assert.deepEqual(visemesAt(clip, 0.6, 0), { ou: 1 });
});

test('weights never sum past 1 and move without a jump', () => {
  const keys = 'hh ax l ow w er l d'.split(' ').map((phoneme, i) => ({ time: i * 0.11, phoneme }));
  const clip = line(keys);
  let last = null;
  for (let t = 0; t < 1.1; t += 0.001) {
    const weights = visemesAt(clip, t),
      total = Object.values(weights).reduce((sum, value) => sum + value, 0);
    assert.ok(total <= 1 + 1e-9, `total ${total} at ${t}`);
    if (last)
      for (const name of VISEMES) {
        // Each ramp is 1 / 0.06 per second, so a millisecond moves a weight by at most 1/60, twice for a crossing.
        const step = Math.abs((weights[name] ?? 0) - (last[name] ?? 0));
        assert.ok(step <= 2 / 60 + 1e-9, `${name} jumps ${step} at ${t}`);
      }
    last = weights;
  }
});

test('weight and gain scale the mouth, and end leaves a gap of rest', () => {
  const clip = line([{ time: 0, end: 0.5, phoneme: 'aa', weight: 0.5 }, { time: 1, phoneme: 'ih' }], { gain: 0.5 });
  assert.deepEqual(visemesAt(clip, 0.25), { aa: 0.25 });
  assert.deepEqual(visemesAt(clip, 0.75), {});
  assert.deepEqual(visemesAt(clip, 1.5), { ih: 0.5 });
});

test('a long sound starting early is still found, past shorter ones after it', () => {
  const clip = line([{ time: 0, end: 1.9, phoneme: 'aa' }, { time: 0.1, end: 0.2, phoneme: 'ih' }]);
  assert.deepEqual(visemesAt(clip, 1.5), { aa: 1 });
});

test('the track puts the mouth on the state, and scrubbing gives what playing gives', () => {
  const cutscene = build([track([line([{ time: 0, phoneme: 'aa' }, { time: 1, phoneme: 'uw' }], { start: 1 })], { blend: 0.2 })]);
  assert.deepEqual(mouthOf(cutscene.evaluate(0.5), 'ada'), {});
  assert.deepEqual(mouthOf(cutscene.evaluate(1.5), 'ada'), { aa: 1 });
  assert.deepEqual(mouthOf(cutscene.evaluate(1.5), 'bob'), {});
  const player = new CutscenePlayer(cutscene);
  void player.play();
  for (let i = 0; i < 123; i++) player.update(1 / 60);
  assert.deepEqual(player.state, cutscene.evaluate(player.time));
  assert.deepEqual(
    cutscene.instants.filter((event) => event.type === 'lipsync').map((event) => [event.kind, event.name, event.time]),
    [['enter', 'ada', 1], ['exit', 'ada', 3]],
  );
});

test('two tracks on one character add up, within 1', () => {
  const a = track([line([{ time: 0, phoneme: 'aa', weight: 0.75 }])], { id: 'a' }),
    b = track([line([{ time: 0, phoneme: 'aa', weight: 0.75 }])], { id: 'b' });
  assert.equal(mouthOf(build([a, b]).evaluate(1), 'ada').aa, 1);
});

test('a nested timeline carries dialogue', () => {
  const timelines = { scene: { duration: 2, tracks: [track([line([{ time: 0, phoneme: 'aa' }])])] } };
  const cutscene = build([{ type: 'timeline', id: 'act', clips: [{ start: 1, duration: 2, timeline: 'scene' }] }], { timelines });
  assert.deepEqual(mouthOf(cutscene.evaluate(2), 'ada'), { aa: 1 });
});

test('weights become the blend shapes of each set', () => {
  assert.deepEqual(mouthShapes({ aa: 0.5 }), { viseme_aa: 0.5 });
  assert.deepEqual(mouthShapes({ aa: 0.5 }, 'vrm'), { aa: 0.5 });
  assert.deepEqual(mouthShapes({ aa: 1 }, 'arkit'), { jawOpen: 0.7 });
  // Lips together in VRM is the mouth at rest, which no preset moves.
  assert.deepEqual(mouthShapes({ PP: 1 }, 'vrm'), {});
  for (const set of ['vrm', 'arkit'])
    for (const viseme of VISEMES)
      for (const value of Object.values(mouthShapes({ [viseme]: 1 }, set))) assert.ok(value > 0 && value <= 1);
  // Two visemes on one shape stay within 1.
  assert.equal(mouthShapes({ aa: 1, E: 1 }, 'arkit').jawOpen, 1);
});

test('every bad line is reported with its path', () => {
  const issues = (bad) =>
    validateCutscene(doc([bad]), new Set(), new Map([['lipsync', lipSyncTrack()]])).map((issue) => `${issue.path}: ${issue.message}`);
  const expect = (bad, pattern) => {
    const found = issues(bad);
    assert.ok(found.some((row) => pattern.test(row)), `${pattern} in ${found.join(' | ')}`);
  };
  assert.deepEqual(issues(track([line([{ time: 0, phoneme: 'aa' }])])), []);
  expect({ ...track([]), target: '' }, /target/);
  expect(track([], { blend: -1 }), /blend: must be seconds/);
  expect(track([line([{ time: 3, phoneme: 'aa' }])]), /phonemes\[0\]\.time: must be seconds inside the clip/);
  expect(track([line([{ time: 0, phoneme: 'qq' }])]), /phonemes\[0\]\.phoneme: unknown phoneme "qq"/);
  expect(track([line([{ time: 1, end: 0.5, phoneme: 'aa' }])]), /end: must not come before/);
  expect(track([line([{ time: 0, phoneme: 'aa', weight: 2 }])]), /weight: must be from 0 to 1/);
  expect(track([line([{ time: 1, phoneme: 'aa' }, { time: 0, phoneme: 'aa' }])]), /phonemes\[1\]\.time: is earlier/);
  expect(track([line(3)]), /phonemes: must be an array/);
});

test('real speech with real labels: phoneme data drives the mouth where the labels say', () => {
  const labels = readLabels('arctic_a0001.lab');
  let from = 0;
  const phonemes = labels.map(({ end, phoneme }) => {
    const key = { time: from, end, phoneme };
    from = end;
    return key;
  });
  const clip = { start: 0, duration: from, phonemes };
  phonemes.forEach((key, i) => {
    // Halfway through each sound of 70 ms or longer, past both blends, its viseme has the whole mouth.
    if (key.end - key.time < 0.07) return;
    const viseme = visemeOf(key.phoneme),
      weights = visemesAt(clip, (key.time + key.end) / 2);
    assert.deepEqual(weights, viseme === 'sil' ? {} : { [viseme]: 1 }, `sound ${i} ${key.phoneme}`);
  });
});

test('analyseSpeech on real speech: finds silence and speech, and beats always naming the commonest vowel', () => {
  const vowels = new Set(['aa', 'E', 'ih', 'oh', 'ou']),
    count = { silence: 0, silenceRight: 0, speech: 0, speechRight: 0, vowel: 0, vowelRight: 0, hiss: 0, hissRight: 0 },
    seen = {};
  for (const name of ['arctic_a0001', 'arctic_a0002']) {
    const { samples, rate } = readWAV(name),
      labels = readLabels(`${name}.lab`),
      keys = analyseSpeech(samples, rate);
    keys.forEach((key, i) => {
      assert.ok(key.end > key.time);
      if (i) assert.ok(key.time >= keys[i - 1].time);
      assert.ok(key.weight > 0 && key.weight <= 1);
      assert.notEqual(visemeOf(key.phoneme), null);
    });
    for (let t = 0.02; t < samples.length / rate; t += 0.01) {
      const want = visemeOf(labels.find((label) => label.end > t)?.phoneme ?? 'pau'),
        got = keys.find((key) => t >= key.time && t < key.end)?.phoneme ?? 'sil';
      if (want === 'sil') {
        count.silence++;
        if (got === 'sil') count.silenceRight++;
      } else {
        count.speech++;
        if (got !== 'sil') count.speechRight++;
      }
      if (vowels.has(want)) {
        seen[want] = (seen[want] ?? 0) + 1;
        count.vowel++;
        if (got === want) count.vowelRight++;
      }
      if (want === 'SS') {
        count.hiss++;
        if (got === 'SS') count.hissRight++;
      }
    }
  }
  // Labels are placed by people and tools, and a 30 ms frame straddles them, so these leave a margin for edges only.
  assert.ok(count.silenceRight / count.silence > 0.8, `silence ${count.silenceRight / count.silence}`);
  assert.ok(count.speechRight / count.speech > 0.9, `speech ${count.speechRight / count.speech}`);
  assert.ok(count.hissRight / count.hiss > 0.6, `hiss ${count.hissRight / count.hiss}`);
  // The honest yardstick for vowels: a reader that always answered with the commonest one.
  const always = Math.max(...Object.values(seen)) / count.vowel;
  assert.ok(count.vowelRight / count.vowel > always, `vowels ${count.vowelRight / count.vowel} against ${always}`);
});

test('analyseSpeech on silence and at another rate', () => {
  assert.deepEqual(analyseSpeech(new Float32Array(16_000), 16_000).map((key) => key.phoneme), ['sil']);
  assert.deepEqual(analyseSpeech(new Float32Array(10), 16_000), []);
  const { samples, rate } = readWAV('arctic_a0001');
  // The same recording at three times the rate, each sample repeated: the sounds should land in the same places.
  const up = new Float32Array(samples.length * 3);
  for (let i = 0; i < up.length; i++) up[i] = samples[Math.floor(i / 3)];
  const a = analyseSpeech(samples, rate),
    b = analyseSpeech(up, rate * 3);
  const silentAt = (keys, t) => keys.find((key) => t >= key.time && t < key.end)?.phoneme === 'sil';
  let agree = 0,
    total = 0;
  for (let t = 0.05; t < 3; t += 0.01, total++) if (silentAt(a, t) === silentAt(b, t)) agree++;
  assert.ok(agree / total > 0.95, `${agree} of ${total}`);
  assert.throws(() => analyseSpeech(samples, 100), /sampleRate/);
  assert.throws(() => analyseSpeech(samples, rate, { step: 0 }), /options/);
});

test('a line opens into its first sound and closes after its last, with no jump at the ends of the clip', () => {
  const blend = 0.1,
    cutscene = build([track([line([{ time: 0, phoneme: 'aa' }], { start: 1 })], { blend })]),
    open = (t) => mouthOf(cutscene.evaluate(t), 'ada').aa ?? 0;
  near(open(1 - blend), 0);
  near(open(1), 0.5);
  near(open(1 + blend / 2), 1);
  near(open(3 - blend / 2), 1);
  near(open(3), 0.5);
  near(open(3 + blend), 0);
  // The ramp is 1 / blend per second, so a millisecond moves the weight by at most 1 / 100.
  for (let t = 0.8; t < 3.2; t += 0.001) assert.ok(Math.abs(open(t + 0.001) - open(t)) <= 0.001 / blend + 1e-9, `at ${t}`);
});

test('real speech through a real document: the mouth is shut in the labelled pauses and open in the vowels', () => {
  const { samples, rate } = readWAV('arctic_a0001'),
    labels = readLabels('arctic_a0001.lab'),
    duration = samples.length / rate,
    document = { format: 'margo-cutscene', version: 1, duration, tracks: [track([{ start: 0, duration, phonemes: analyseSpeech(samples, rate) }])] },
    cutscene = new Cutscene(JSON.stringify(document), { tracks: [lipSyncTrack()] });
  let from = 0,
    shut = 0,
    pauses = 0,
    open = 0,
    vowels = 0;
  for (const { end, phoneme } of labels) {
    const viseme = visemeOf(phoneme),
      sum = Object.values(mouthOf(cutscene.evaluate((from + end) / 2), 'ada')).reduce((a, b) => a + b, 0);
    if (viseme === 'sil') {
      // A pause shorter than the 30 ms frame plus the 40 ms shortest sound cannot be kept: the sentence's 18 ms and 37 ms ones.
      if (end - from >= 0.07) {
        pauses++;
        if (sum === 0) shut++;
      }
    } else if (['aa', 'E', 'ih', 'oh', 'ou'].includes(viseme)) {
      vowels++;
      if (sum > 0) open++;
    }
    from = end;
  }
  assert.ok(pauses >= 2 && vowels >= 10, `${pauses} pauses, ${vowels} vowels`);
  assert.equal(shut, pauses, 'every pause long enough to keep, read at its middle');
  assert.equal(open, vowels, 'every vowel, read at its middle');
});

test('the shapes reach a real avatar and the face entry: Seed-san moves its own morph targets', () => {
  const avatar = readVRM(new Uint8Array(readFileSync(new URL('../../../examples/assets/vrm/Seed-san.vrm', import.meta.url)))),
    expressions = new VRMExpressions(avatar),
    { morphTargetBinds } = avatar.expressions.preset.aa,
    { samples, rate } = readWAV('arctic_a0002'),
    keys = analyseSpeech(samples, rate),
    clip = { start: 0, duration: samples.length / rate, phonemes: keys },
    bind = morphTargetBinds[0],
    weights = [];
  assert.ok(morphTargetBinds.length > 0, 'the avatar binds its aa mouth to morph targets');
  for (let t = 0; t < clip.duration; t += 1 / 30) {
    const shapes = mouthShapes(visemesAt(clip, t), 'vrm');
    for (const name of ['aa', 'ih', 'ou', 'ee', 'oh']) {
      assert.ok(expressions.names.includes(name), name);
      expressions.set(name, shapes[name] ?? 0);
    }
    const morph = expressions.evaluate().morphs.find(({ node, index }) => node === bind.node && index === bind.index);
    assert.ok(morph.weight >= 0 && morph.weight <= 1);
    weights.push(morph.weight);
  }
  assert.equal(weights[0], 0, 'the recording starts in silence');
  assert.ok(Math.max(...weights) > 0.5, `the mouth opens: ${Math.max(...weights)}`);
  assert.ok(weights.filter((weight) => weight > 0).length > weights.length / 4, 'on and off through the sentence');
  // Every ARKit shape is a name a tracker frame of @margoengine/rigging/face takes, so a frame can go straight to addFace.
  for (const viseme of VISEMES)
    for (const shape of Object.keys(mouthShapes({ [viseme]: 1 }, 'arkit'))) assert.ok(FACE_SHAPES.includes(shape), shape);
});
