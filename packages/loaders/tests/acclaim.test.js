// parseASF / parseAMC: Acclaim skeletons and motions (the CMU motion capture database's format), the axis and Euler
// conventions, coded errors, and real CMU trials that stand and walk on the floor only under the right convention.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAMC, parseASF } from '../dist/mocap.js';
import { LoaderError } from '../dist/common.js';
import { Skeleton, applyKeyframeClip, createKeyframeClip } from '../../animation/dist/index.js';

const fixture = (name) => readFileSync(new URL(`fixtures/cmu/${name}`, import.meta.url), 'utf8');
const CMU_METRES = 0.0254 / 0.45;

const ASF = `# test skeleton
:version 1.10
:name tiny
:units
  mass 1.0
  length 1
  angle deg
:root
  order TX TY TZ RX RY RZ
  axis XYZ
  position 0 1 0
  orientation 0 0 0
:bonedata
  begin
    id 1
    name spine
    direction 0 1 0
    length 2
    axis 0 0 90 XYZ
    dof rx
    limits (-180 180)
  end
  begin
    id 2
    name head
    direction 0 0 1
    length 1
    axis 0 0 0 XYZ
    dof rx ry
    limits (-180 180)
           (-180 180)
  end
  begin
    id 3
    name leg
    direction 0 -1 0
    length 3
    axis 0 0 0 XYZ
  end
:hierarchy
  begin
    root spine leg
    spine head
  end
`;
const AMC = `:FULLY-SPECIFIED
:DEGREES
1
root 0 0 0 0 0 0
spine 0
head 0 0
2
root 1 2 3 0 0 0
spine 90
head 90 90
`;

const near = (actual, expected, label, tolerance = 1e-9) => {
  assert.equal(actual.length, expected.length, label);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < tolerance, `${label}: ${actual} against ${expected}`));
};
const code = (fn, format, expected, pattern) =>
  assert.throws(fn, (e) => e instanceof LoaderError && e.code === expected && e.format === format && pattern.test(e.message));

test('bones become joints at each bone start, parents first, resting unrotated', () => {
  const s = parseASF(ASF);
  assert.equal(s.name, 'tiny');
  assert.equal(s.lengthUnit, 1);
  assert.deepEqual(
    s.bones.map((b) => [b.name, b.parent]),
    [
      ['root', -1],
      ['spine', 0],
      ['leg', 0],
      ['head', 1],
    ],
  );
  assert.deepEqual(s.bones[0].translation, [0, 1, 0]);
  assert.deepEqual(s.bones[1].translation, [0, 0, 0]); // the root has no length: its children start where it is
  assert.deepEqual(s.bones[3].translation, [0, 2, 0]); // head starts at the spine's end
  assert.deepEqual(s.bones[3].endSite, [0, 0, 1]);
  assert.deepEqual(s.bones[2].endSite, [0, -3, 0]);
  assert.equal(s.bones[1].endSite, undefined);
  for (const b of s.bones) assert.deepEqual(b.rotation, [0, 0, 0, 1]);
  near(parseASF(ASF, { scale: 0.5 }).bones[3].translation, [0, 1, 0], 'scale');
});

test('a motion turns a bone in its own axis frame, Euler axes applied first listed first', () => {
  const { clip, frames, frameTime } = parseAMC(AMC, parseASF(ASF), { frameTime: 0.25, name: 'tiny walk' });
  assert.equal(frames, 2);
  assert.equal(frameTime, 0.25);
  assert.equal(clip.name, 'tiny walk');
  assert.deepEqual(
    clip.tracks.map((t) => `${t.target}.${t.path}`),
    ['root.translation', 'root.rotation', 'spine.rotation', 'head.rotation'],
  );
  const h = Math.SQRT1_2;
  near(clip.tracks[0].keys[1].value, [1, 3, 3], 'root moves from its rest position');
  assert.equal(clip.tracks[0].keys[1].time, 0.25);
  // spine's axis frame is the rest frame turned 90 about z, so its x turn is a turn about the rest frame's y.
  near(clip.tracks[2].keys[1].value, [0, h, 0, h], 'rx 90 in a frame turned 90 about z');
  // rx 90 then ry 90, X applied first: Ry(90) Rx(90) as matrices on column vectors.
  near(clip.tracks[3].keys[1].value, [0.5, 0.5, -0.5, 0.5], 'X first, then Y');
  near(clip.tracks[3].keys[0].value, [0, 0, 0, 1], 'frame 1 rests');
});

test('the motion plays through the animation package', () => {
  const s = parseASF(ASF),
    { bones, clip } = parseAMC(AMC, s);
  const skeleton = new Skeleton(bones);
  const playable = createKeyframeClip(clip);
  assert.ok(Math.abs(playable.duration - 1 / 120) < 1e-12);
  applyKeyframeClip(playable, skeleton, 1 / 120);
  assert.equal(skeleton.index('head'), 3);
});

// World positions of every joint at one frame, composing the clip's local turns parent to child.
function world(bones, clip, frame) {
  const qm = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const turn = (q, v) => {
    const r = qm(qm(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
    return [r[0], r[1], r[2]];
  };
  const tracks = new Map(clip.tracks.map((t) => [`${t.target}.${t.path}`, t.keys]));
  const rotation = [],
    position = [];
  bones.forEach((b, i) => {
    const r = tracks.get(`${b.name}.rotation`)?.[frame].value ?? [0, 0, 0, 1],
      t = tracks.get(`${b.name}.translation`)?.[frame].value ?? b.translation;
    if (b.parent < 0) {
      rotation[i] = r;
      position[i] = t;
    } else {
      rotation[i] = qm(rotation[b.parent], r);
      const o = turn(rotation[b.parent], t);
      position[i] = position[b.parent].map((x, k) => x + o[k]);
    }
  });
  const end = (name) => {
    const i = bones.findIndex((b) => b.name === name),
      e = turn(rotation[i], bones[i].endSite ?? [0, 0, 0]);
    return position[i].map((x, k) => x + e[k]);
  };
  return { position, end, index: (name) => bones.findIndex((b) => b.name === name) };
}

test('a real CMU walk (subject 35) stays upright, keeps one foot on the floor and walks toward +z', () => {
  // The fixture keeps every 20th frame of the first second of trial 35_01 (120 fps), so one fixture frame is 1/6 s.
  const s = parseASF(fixture('35.asf'), { scale: CMU_METRES }),
    { bones, clip, frames, frameTime } = parseAMC(fixture('35_01-every-20th.amc'), s, { frameTime: 20 / 120 });
  assert.equal(frames, 7);
  assert.equal(bones.length, 31);
  assert.ok(Math.abs(frameTime * (frames - 1) - 1) < 1e-12);
  const lows = [];
  for (let f = 0; f < frames; f++) {
    const w = world(bones, clip, f),
      head = w.end('head');
    assert.ok(head[1] > 1.55 && head[1] < 1.85, `frame ${f}: head top at ${head[1]} m`);
    lows.push(Math.min(w.end('ltoes')[1], w.end('rtoes')[1], w.end('lfoot')[1], w.end('rfoot')[1]));
  }
  const mean = lows.reduce((a, b) => a + b) / lows.length,
    spread = Math.max(...lows) - Math.min(...lows);
  assert.ok(mean > -0.02 && mean < 0.08, `mean lowest foot point ${mean} m`);
  assert.ok(spread < 0.06, `lowest foot point moves ${spread} m over a second of walking`);
  const start = world(bones, clip, 0).position[0],
    stop = world(bones, clip, frames - 1).position[0];
  assert.ok(stop[2] - start[2] > 0.9, `walked ${stop[2] - start[2]} m along +z in a second`);
});

test('bad files and limits throw coded errors', () => {
  code(() => parseASF('nothing here'), 'ASF', 'header', /:root/);
  code(() => parseASF(':root\n:bonedata\n begin\n begin'), 'ASF', 'syntax', /inside another/);
  code(() => parseASF(':root\n:bonedata\n end'), 'ASF', 'syntax', /no bone to close/);
  code(() => parseASF(':root\n:bonedata\n name x'), 'ASF', 'syntax', /outside every bone/);
  code(() => parseASF(':root\n:bonedata\n begin\n name a\n'), 'ASF', 'truncated', /has no end/);
  code(() => parseASF(':root\n:bonedata\n begin\n end'), 'ASF', 'syntax', /no name/);
  code(() => parseASF(':root\n:bonedata\n begin\n name root\n end'), 'ASF', 'syntax', /named twice/);
  code(() => parseASF(':root\n:bonedata\n begin\n name a\n length -1\n end'), 'ASF', 'range', /negative length/);
  code(() => parseASF(':root\n:bonedata\n begin\n name a\n axis 0 0 0 XXY\n end'), 'ASF', 'syntax', /permutation/);
  code(() => parseASF(':root\n:bonedata\n begin\n name a\n dof rw\n end'), 'ASF', 'syntax', /unknown dof/);
  code(() => parseASF(':root\n:bonedata\n begin\n name a\n direction 0 x 0\n end'), 'ASF', 'syntax', /invalid number/);
  code(() => parseASF(':root\n order TX QQ\n:bonedata'), 'ASF', 'syntax', /unknown channel/);
  code(() => parseASF(':units\n angle grad\n:root'), 'ASF', 'syntax', /deg or rad/);
  code(() => parseASF(':units\n length 0\n:root'), 'ASF', 'range', /not positive/);
  code(() => parseASF(':root\n:bonedata\n begin\n name a\n end\n:hierarchy\n begin\n b a\n end'), 'ASF', 'syntax', /unknown bone "b"/);
  code(() => parseASF(':root\n:bonedata\n begin\n name a\n end\n:hierarchy\n begin\n root c\n end'), 'ASF', 'syntax', /unknown bone "c"/);
  code(() => parseASF(':root\n:bonedata\n begin\n name a\n end\n:hierarchy\n begin\n root a\n root a\n end'), 'ASF', 'syntax', /two parents/);
  code(() => parseASF(':root\n:bonedata\n begin\n name a\n end'), 'ASF', 'syntax', /not in the hierarchy/);
  code(() => parseASF(ASF, { maxJoints: 2 }), 'ASF', 'limit', /bone count/);
  code(() => parseASF(ASF, { scale: 0 }), 'ASF', 'range', /scale/);
  const s = parseASF(ASF);
  code(() => parseAMC(AMC, {}), 'AMC', 'range', /skeleton parseASF/);
  code(() => parseAMC(AMC, s, { frameTime: 0 }), 'AMC', 'range', /frame time/);
  code(() => parseAMC(AMC, s, { maxKeys: 4 }), 'AMC', 'limit', /keys/);
  code(() => parseAMC(AMC, s, { maxKeys: -1 }), 'AMC', 'range', /maxKeys/);
  code(() => parseAMC('junk\n1\n', s), 'AMC', 'header', /before the first frame/);
  code(() => parseAMC('1\nroot 0 0 0 0 0 0\nspine 0\n', s), 'AMC', 'syntax', /no line for bone "head"/);
  code(() => parseAMC('1\nneck 0\n', s), 'AMC', 'syntax', /unknown bone "neck"/);
  code(() => parseAMC('1\nspine 0 0\n', s), 'AMC', 'syntax', /2 values/);
  code(() => parseAMC('1\nspine x\n', s), 'AMC', 'syntax', /invalid number/);
  assert.deepEqual(parseAMC(':FULLY-SPECIFIED\n', s).clip.tracks, []);
  assert.equal(parseAMC(new TextEncoder().encode(AMC), s).frames, 2);
});
