// Spline IK (@margoengine/animator/spline-ik): a chain follows a curve. Joints land on the curve, bones keep their lengths,
// a curl past half a turn does not flip, and the last test bends Fox.glb's real tail while its real walk plays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addSplineIK } from '../packages/animator/dist/spline-ik.js';
import { Spline } from '../packages/splines/dist/index.js';
import { animatorDocument, animatorGLB, animatorRun, axisAngle, FOX, largestGap } from './support/animator-rig.js';

const BONE = 0.2,
  JOINTS = ['B0', 'B1', 'B2', 'B3', 'B4', 'B5'];
const TABLE = {
  Root: [null, 0, 0, 0],
  B0: ['Root', 0, 1, 0],
  ...Object.fromEntries(JOINTS.slice(1).map((name, i) => [name, [JOINTS[i], 0, BONE, 0]])),
};
const CLIPS = { Rest: { duration: 1, tracks: { 'B0.translation': () => [0, 1, 0] } } };
async function rig(curve, extra = {}) {
  const f = await animatorRun(animatorDocument(TABLE, CLIPS), { initial: 'rest', states: { rest: 'Rest' } });
  f.chain = { joints: JOINTS.map((name) => f.index.get(name)), curve, ...extra };
  f.ik = addSplineIK(f.animator, f.chain);
  f.places = () => JOINTS.map((name) => f.world(name));
  return f;
}
const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function nearest(spline, point) {
  let best = Infinity;
  for (let i = 0; i <= 4000; i++) best = Math.min(best, gap(Array.from(spline.atDistance((i / 4000) * spline.length)), point));
  return best;
}
const arc = (angle, radius = 0.5, count = 33) =>
  Array.from({ length: count }, (_, i) => {
    const a = (i / (count - 1)) * angle;
    return [radius * (1 - Math.cos(a)), 1 + radius * Math.sin(a), 0];
  });
const lengthsKept = (places, bone = BONE) =>
  places.slice(1).forEach((place, i) => assert.ok(Math.abs(gap(place, places[i]) - bone) < 1e-4, `bone ${i}`));

test('a curve along the chain leaves the chain as it is', async (t) => {
  const f = await rig([[0, 1, 0], [0, 1.6, 0], [0, 2.2, 0]]);
  t.after(() => f.release());
  f.step();
  JOINTS.forEach((name, i) => assert.ok(gap(f.world(name), [0, 1 + i * BONE, 0]) < 1e-5, name));
  assert.equal(f.ik.overrun, 0);
  for (const name of JOINTS) assert.ok(1 - Math.abs(f.rotation(name)[3]) < 1e-9, `${name} did not turn`);
});

test('every joint lands on the curve and bones keep their lengths', async (t) => {
  const points = [[0, 1, 0], [0.4, 1.3, 0.1], [0.3, 1.7, 0.4], [-0.1, 1.9, 0.3], [-0.5, 2.1, 0]],
    f = await rig(points),
    spline = new Spline(points);
  t.after(() => f.release());
  f.step();
  for (const place of f.places()) assert.ok(nearest(spline, place) < 1e-3, `${place} is off the curve`);
  lengthsKept(f.places());
});

test('a Spline of any kind is taken as it is', async (t) => {
  const spline = new Spline([[0, 1, 0], [0.6, 1.2, 0], [0.6, 1.8, 0], [0, 2.2, 0]], { kind: 'bezier' }),
    f = await rig(spline);
  t.after(() => f.release());
  f.step();
  for (const place of f.places()) assert.ok(nearest(spline, place) < 1e-3);
  lengthsKept(f.places());
});

test('a curl past half a turn does not flip the chain: every frame of a growing curl moves each bone a little', async (t) => {
  const f = await rig(arc(0.01));
  t.after(() => f.release());
  f.step();
  let last = null,
    worst = 0;
  const axes = () => JOINTS.map((name) => Array.from(f.node(name).matrix.slice(0, 3)));
  for (let i = 1; i <= 120; i++) {
    f.chain.curve = arc((i / 120) * 1.75 * Math.PI, 0.25);
    f.step();
    const now = axes();
    if (last) worst = Math.max(worst, largestGap(now, last));
    last = now;
    lengthsKept(f.places());
  }
  assert.ok(worst < 0.2, `a bone's side axis jumped ${worst} in a frame`);
  const places = f.places();
  assert.ok(Math.abs(places[5][1] - places[0][1]) < 0.5);
  for (const axis of last) assert.ok(Math.abs(axis[2]) < 1e-4 || Math.abs(axis[2]) > 0.999, 'the side axis stays in or across the curl');
});

test('a hairpin: a joint takes the first place along the curve, though the curve comes back near it', async (t) => {
  const points = [[0, 1, 0], [0, 1.6, 0], [0.05, 1.7, 0], [0.1, 1.6, 0], [0.1, 1, 0]],
    f = await rig(points),
    spline = new Spline(points);
  t.after(() => f.release());
  f.step();
  const places = f.places();
  assert.ok(places[1][1] > 1.15 && places[2][1] > places[1][1], `${places}`);
  for (const place of places) assert.ok(nearest(spline, place) < 1e-3);
});

test('past the end of the curve the chain carries on straight and says how far', async (t) => {
  const f = await rig([[0, 1, 0], [0.5, 1, 0]]);
  t.after(() => f.release());
  f.step();
  const places = f.places();
  lengthsKept(places);
  assert.ok(gap(places[5], [1, 1, 0]) < 1e-4, `${places[5]}`);
  assert.ok(Math.abs(f.ik.overrun - 0.5) < 1e-4, `${f.ik.overrun}`);
});

test("anchor 'root' keeps the first joint where it was and moves the curve to it", async (t) => {
  const f = await rig([[3, 0, 0], [3.5, 0.2, 0], [4, 0, 0]], { anchor: 'root' });
  t.after(() => f.release());
  f.step();
  assert.ok(gap(f.world('B0'), [0, 1, 0]) < 1e-5);
  assert.ok(f.world('B5')[0] > 0.8);
  lengthsKept(f.places());
});

test("anchor 'curve' moves the first joint to the curve, and offset slides the chain along it", async (t) => {
  const points = [[1, 0, 0], [1, 1, 0], [1, 2, 0]],
    f = await rig(points, { offset: 0.5 });
  t.after(() => f.release());
  f.step();
  assert.ok(gap(f.world('B0'), [1, 0.5, 0]) < 2e-3, `${f.world('B0')}`);
  f.chain.offset = 0.7;
  f.step();
  assert.ok(gap(f.world('B0'), [1, 0.7, 0]) < 2e-3, `${f.world('B0')}`);
  assert.ok(gap(f.world('B5'), [1, 1.7, 0]) < 2e-3);
});

test('twist turns the chain about itself from the first joint to the last, leaving the places alone', async (t) => {
  const straight = [[0, 1, 0], [0, 2.2, 0]],
    f = await rig(straight, { twist: [0, 1] });
  t.after(() => f.release());
  f.step();
  JOINTS.forEach((name, i) => assert.ok(gap(f.world(name), [0, 1 + i * BONE, 0]) < 1e-5, name));
  const turn = (name) => Math.atan2(-f.node(name).matrix[2], f.node(name).matrix[0]);
  assert.ok(Math.abs(turn('B0')) < 1e-5);
  assert.ok(Math.abs(turn('B4') - 1) < 1e-4, `last bone turned ${turn('B4')}`);
  assert.ok(Math.abs(turn('B2') - 0.5) < 1e-4, `middle bone turned ${turn('B2')}`);
});

test('weight blends from the animated chain, and 0 is the animated chain', async (t) => {
  const f = await rig(arc(1.5), { weight: 0 });
  t.after(() => f.release());
  f.step();
  JOINTS.forEach((name, i) => assert.ok(gap(f.world(name), [0, 1 + i * BONE, 0]) < 1e-6, name));
  f.chain.weight = 1;
  f.step();
  const full = f.world('B5');
  f.chain.weight = 0.5;
  f.step();
  const half = f.world('B5');
  assert.ok(half[0] > 0.1 * full[0] && half[0] < 0.9 * full[0], `${half} against ${full}`);
  lengthsKept(f.places());
});

test('a curve in a node\'s space travels with the node', async (t) => {
  const f = await rig([[0, 0, 0], [0.5, 0.5, 0], [0.5, 1.2, 0]], {}),
    space = f.node('Root');
  t.after(() => f.release());
  f.chain.space = space;
  f.step();
  const before = f.world('B5');
  f.model.root.setPosition([2, 0, 1]);
  f.step();
  const after = f.world('B5');
  assert.ok(gap(after, [before[0] + 2, before[1], before[2] + 1]) < 1e-4, `${after} from ${before}`);
});

test('a curve of points may be rewritten every frame', async (t) => {
  const points = [[0, 1, 0], [0.5, 1.5, 0], [0.5, 2, 0]],
    f = await rig(points);
  t.after(() => f.release());
  f.step();
  const before = f.world('B5');
  points[2][0] = -0.5;
  f.step();
  assert.ok(gap(f.world('B5'), before) > 0.1);
});

test('dispose gives the chain back, and bad settings name the fix', async (t) => {
  const f = await rig(arc(1));
  t.after(() => f.release());
  f.step();
  f.ik.dispose();
  f.ik.dispose();
  f.step();
  JOINTS.forEach((name, i) => assert.ok(gap(f.world(name), [0, 1 + i * BONE, 0]) < 1e-5, name));
  const { joints, curve } = f.chain,
    add = (chain) => addSplineIK(f.animator, chain);
  assert.throws(() => add({ joints: [joints[0]], curve }), /2-256/);
  assert.throws(() => add({ joints: [joints[0], joints[2]], curve }), /child/);
  assert.throws(() => add({ joints, curve: [[0, 0, 0]] }), /2 or more points/);
  assert.throws(() => add({ joints, curve, weight: 2 }), /weight/);
  assert.throws(() => add({ joints, curve, offset: -1 }), /offset/);
  assert.throws(() => add({ joints, curve, anchor: 'tip' }), /anchor/);
  assert.throws(() => add({ joints, curve, twist: [1] }), /twist/);
  assert.throws(() => add({ joints, curve, samples: 1 }), /samples/);
  assert.throws(() => add({ joints, curve, space: {} }), /space/);
});

test('Fox.glb: the real tail lies along a curve while the real walk plays', async (t) => {
  const f = await animatorRun(animatorGLB(FOX), { initial: 'walk', states: { walk: 'Walk' } }),
    names = ['b_Tail01_012', 'b_Tail02_013', 'b_Tail03_014'];
  t.after(() => f.release());
  f.step(1 / 30, 3);
  const start = f.world(names[0]),
    points = [
      start,
      [start[0] + 8, start[1] + 12, start[2] - 10],
      [start[0] + 20, start[1] + 22, start[2] - 12],
      [start[0] + 34, start[1] + 26, start[2] - 8],
    ],
    spline = new Spline(points),
    lengths = [gap(f.world(names[1]), f.world(names[0])), gap(f.world(names[2]), f.world(names[1]))],
    ik = addSplineIK(f.animator, { joints: names.map((name) => f.index.get(name)), curve: spline, anchor: 'root' });
  for (let frame = 0; frame < 20; frame++) {
    f.step(1 / 30);
    const places = names.map((name) => f.world(name)),
      shift = places[0].map((v, c) => v - points[0][c]);
    assert.equal(ik.overrun, 0);
    assert.ok(Math.abs(gap(places[1], places[0]) - lengths[0]) < 1e-3, `frame ${frame} bone 0`);
    assert.ok(Math.abs(gap(places[2], places[1]) - lengths[1]) < 1e-3, `frame ${frame} bone 1`);
    for (const place of places)
      assert.ok(nearest(spline, place.map((v, c) => v - shift[c])) < 0.02, `frame ${frame}: ${place} is off the curve`);
  }
});
