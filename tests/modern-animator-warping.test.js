// Warping (@margoengine/animator/warping): a planted foot stays planted in the world at speeds and angles the clip was
// not made for, the upper body keeps facing front, the pelvis drops when legs would not reach, the clip's rate takes over
// past the stride limits, and a stop clip driven by distance lands on its mark.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDistanceWarp, addWarping } from '../packages/animator/dist/warping.js';
import { addRootMotion } from '../packages/animator/dist/index.js';
import { animatorDocument, animatorRun, axisAngle, BIPED, bipedWalk } from './support/animator-rig.js';

const DT = 1 / 120;
const CLIPS = {
  Walk: bipedWalk({ duration: 1, speed: 1 }),
  // In place: the feet step but the hips do not travel.
  March: { ...bipedWalk({ duration: 1, speed: 1 }), tracks: withoutTravel(bipedWalk({ duration: 1, speed: 1 }).tracks) },
  // Covers 1.5 m in 1 s, slowing to a stop.
  Stop: { duration: 1, tracks: { 'Hips.translation': (t) => [0, 1, 1.5 * (1 - (1 - t) ** 2)] } },
  Start: { duration: 1, tracks: { 'Hips.translation': (t) => [0, 1, 2 * t * t] } },
};
function withoutTravel(tracks) {
  const { 'Hips.translation': _, ...rest } = tracks;
  return rest;
}
const states = { walk: 'Walk', march: 'March', stop: 'Stop', start: 'Start' };
async function rig(initial = 'walk') {
  const f = await animatorRun(animatorDocument(BIPED, CLIPS), { initial, states }),
    i = (name) => f.index.get(name);
  f.legs = ['Left', 'Right'].map((side) => ({
    hip: i(`${side}UpLeg`),
    knee: i(`${side}Leg`),
    ankle: i(`${side}Foot`),
  }));
  f.pelvis = i('Hips');
  f.spine = [i('Spine'), i('Chest')];
  return f;
}
// Moves the character at `velocity` for `frames`, calling `each` with the left foot's cycle phase, 0 to 1.
function walk(f, velocity, frames, each) {
  const at = [0, 0, 0];
  for (let frame = 0; frame < frames; frame++) {
    for (let c = 0; c < 3; c++) at[c] += velocity[c] * DT;
    f.model.root.setPosition(at);
    f.store.tick(false);
    f.step(DT);
    each?.(f.animator.time % 1);
  }
}
// How far the left foot moves on the ground through the middle of its stance, the largest over a few cycles.
function slide(f, velocity) {
  let spots = [],
    worst = 0;
  const close = () => {
    if (spots.length > 3) {
      const span = (c) => Math.max(...spots.map((p) => p[c])) - Math.min(...spots.map((p) => p[c]));
      worst = Math.max(worst, Math.hypot(span(0), span(2)));
    }
    spots = [];
  };
  walk(f, velocity, 120);
  const cycles = 3 * Math.max(1, Math.round(120 / (f.animator.clipRate || 1)));
  walk(f, velocity, cycles, (phase) => {
    if (phase > 0.06 && phase < 0.44) spots.push(f.world('LeftFoot'));
    else close();
  });
  close();
  return worst;
}

for (const speed of [0.7, 1, 1.4]) {
  test(`a planted foot stays planted at ${speed} m/s on a 1 m/s clip, by stride alone`, async (t) => {
    const f = await rig();
    t.after(() => f.release());
    addRootMotion(f.animator, { joint: f.pelvis, apply: false });
    const warp = addWarping(f.animator, { pelvis: f.pelvis, legs: f.legs, velocity: [0, 0, speed] }),
      slid = slide(f, [0, 0, speed]);
    assert.ok(slid < 2e-3, `slid ${slid}`);
    assert.ok(Math.abs(warp.stride - speed) < 1e-5, `stride ${warp.stride}`);
    assert.equal(warp.rate, 1);
  });
}

test('a clip that starts away from the origin warps about the hips, as a real take does', async (t) => {
  const walkAt = bipedWalk({ duration: 1, speed: 1 }),
    tracks = { ...walkAt.tracks, 'Hips.translation': (time) => [0.5, 1, time - 3] },
    f = await animatorRun(animatorDocument(BIPED, { Walk: { ...walkAt, tracks } }), { initial: 'walk', states: { walk: 'Walk' } }),
    i = (name) => f.index.get(name);
  t.after(() => f.release());
  f.pelvis = i('Hips');
  f.legs = ['Left', 'Right'].map((side) => ({ hip: i(`${side}UpLeg`), knee: i(`${side}Leg`), ankle: i(`${side}Foot`) }));
  addRootMotion(f.animator, { joint: f.pelvis, apply: false });
  addWarping(f.animator, { pelvis: f.pelvis, legs: f.legs, velocity: [0, 0, 0.7] });
  const slid = slide(f, [0, 0, 0.7]);
  assert.ok(slid < 2e-3, `slid ${slid}`);
});

test('without the warp the same foot slides by the speed difference', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  addRootMotion(f.animator, { joint: f.pelvis, apply: false });
  const slid = slide(f, [0, 0, 1.4]);
  assert.ok(slid > 0.1, `slid ${slid}`);
});

for (const angle of [Math.PI / 4, -Math.PI / 3, Math.PI / 2]) {
  test(`a planted foot stays planted travelling ${angle.toFixed(2)} radians off the facing`, async (t) => {
    const f = await rig();
    t.after(() => f.release());
    addRootMotion(f.animator, { joint: f.pelvis, apply: false });
    const velocity = [Math.sin(angle) * 1.2, 0, Math.cos(angle) * 1.2],
      warp = addWarping(f.animator, { pelvis: f.pelvis, legs: f.legs, velocity, spine: f.spine }),
      slid = slide(f, velocity);
    assert.ok(slid < 2e-3, `slid ${slid}`);
    assert.ok(Math.abs(warp.turn - angle) < 1e-3, `turned ${warp.turn}`);
    // The chest and head still face +Z, and the hips do not.
    const m = f.node('Chest').matrix,
      h = f.node('Hips').matrix;
    assert.ok(m[10] > 0.999, `chest z ${m[10]}`);
    assert.ok(Math.abs(Math.atan2(h[8], h[10]) - angle) < 1e-3, 'hips face the travel');
  });
}

test('past maxStride the clip speeds up, and the foot still stays planted', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  addRootMotion(f.animator, { joint: f.pelvis, apply: false });
  const warp = addWarping(f.animator, { pelvis: f.pelvis, legs: f.legs, velocity: [0, 0, 3] }),
    slid = slide(f, [0, 0, 3]);
  assert.ok(Math.abs(warp.stride - 1.6) < 1e-6);
  assert.ok(Math.abs(warp.rate - 3 / 1.6) < 1e-6, `rate ${warp.rate}`);
  let dropped = 0;
  walk(f, [0, 0, 3], 60, () => (dropped = Math.max(dropped, warp.pelvisDrop)));
  assert.ok(dropped > 0.02, `the pelvis dropped ${dropped} so the longer stride reaches`);
  assert.ok(slid < 6e-3, `slid ${slid}`);
});

test('below minStride the clip slows down, and a stopped character stops stepping', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  addRootMotion(f.animator, { joint: f.pelvis, apply: false });
  const velocity = [0, 0, 0.3],
    warp = addWarping(f.animator, { pelvis: f.pelvis, legs: f.legs, velocity });
  assert.ok(slide(f, velocity) < 2e-3);
  assert.ok(Math.abs(warp.rate - 0.6) < 1e-6);
  velocity[2] = 0;
  f.step(DT, 2);
  assert.equal(warp.rate, 0);
  const time = f.animator.time;
  f.step(DT, 30);
  assert.equal(f.animator.time, time);
});

test('in-place clips need clipSpeed, and then warp the same', async (t) => {
  const f = await rig('march');
  t.after(() => f.release());
  const velocity = [0, 0, 1.3],
    warp = addWarping(f.animator, { pelvis: f.pelvis, legs: f.legs, velocity, clipSpeed: 1 });
  assert.ok(slide(f, velocity) < 2e-3);
  assert.ok(Math.abs(warp.stride - 1.3) < 1e-5);
});

test('weight 0 leaves the pose as animated; disposing restores the clip rate', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const options = { pelvis: f.pelvis, legs: f.legs, velocity: [0.5, 0, 3], weight: 0 },
    warp = addWarping(f.animator, options);
  f.step(DT, 10);
  const plain = f.rotation('LeftUpLeg');
  f.step(0);
  assert.deepEqual(f.rotation('LeftUpLeg'), plain);
  assert.equal(warp.stride, 1);
  assert.equal(warp.turn, 0);
  options.weight = 1;
  f.step(DT, 5);
  assert.ok(f.animator.clipRate > 1);
  warp.dispose();
  warp.dispose();
  assert.equal(f.animator.clipRate, 1);
});

test('a stop clip driven by distance lands on its mark from a speed it was not made for', async (t) => {
  const f = await rig('stop');
  t.after(() => f.release());
  const warp = { state: 'stop', joint: f.pelvis, distance: 1 },
    handle = addDistanceWarp(f.animator, warp),
    covered = (time) => 1.5 * (1 - (1 - time) ** 2);
  assert.ok(Math.abs(handle.length - 1.5) < 1e-3, `length ${handle.length}`);
  f.step(DT);
  // 1 m left of 1.5 m: the clip stands where it has covered 0.5 m.
  assert.ok(Math.abs(covered(f.animator.time) - 0.5) < 1e-3, `at ${f.animator.time}`);
  const speed = 0.8;
  while (warp.distance > 0) {
    warp.distance = Math.max(0, warp.distance - speed * DT);
    f.step(DT);
    assert.ok(Math.abs(handle.length - covered(f.animator.time) - warp.distance) < 2e-3, `left ${warp.distance}`);
  }
  assert.ok(Math.abs(f.animator.time - 1) < 1e-6, 'and ends on the last frame');
});

test('further out than the clip travels, a stop holds its first frame, and time never runs back', async (t) => {
  const f = await rig('stop');
  t.after(() => f.release());
  const warp = { state: 'stop', joint: f.pelvis, distance: 5 };
  addDistanceWarp(f.animator, warp);
  f.step(DT, 5);
  assert.equal(f.animator.time, 0);
  warp.distance = 0.5;
  f.step(DT);
  const time = f.animator.time;
  warp.distance = 1;
  f.step(DT);
  assert.equal(f.animator.time, time);
});

test('a start clip driven by distance follows the distance covered', async (t) => {
  const f = await rig('start');
  t.after(() => f.release());
  const warp = { state: 'start', joint: f.pelvis, mode: 'start', distance: 0.5 };
  addDistanceWarp(f.animator, warp);
  f.step(DT);
  assert.ok(Math.abs(2 * f.animator.time ** 2 - 0.5) < 1e-3, `at ${f.animator.time}`);
});

test('bad settings name the fix', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const ok = { pelvis: f.pelvis, legs: f.legs, velocity: [0, 0, 1] };
  assert.throws(() => addWarping(f.animator, { ...ok, pelvis: 99 }), /not one of/);
  assert.throws(() => addWarping(f.animator, { ...ok, legs: [] }), /1-8 legs/);
  assert.throws(
    () => addWarping(f.animator, { ...ok, legs: [{ hip: f.legs[0].hip, knee: f.legs[1].knee, ankle: f.legs[0].ankle }] }),
    /not a direct chain/,
  );
  assert.throws(() => addWarping(f.animator, { ...ok, velocity: [0, 0] }), TypeError);
  assert.throws(() => addWarping(f.animator, { ...ok, minStride: 0 }), /minStride/);
  assert.throws(() => addWarping(f.animator, { ...ok, spine: [f.index.get('LeftHand'), f.index.get('Head')] }), /spine 1/);
  assert.throws(() => addDistanceWarp(f.animator, { state: 'nope', joint: f.pelvis, distance: 1 }), /not one of/);
  assert.throws(() => addDistanceWarp(f.animator, { state: 'march', joint: f.pelvis, distance: 1 }), /no translation/);
  addDistanceWarp(f.animator, { state: 'stop', joint: f.pelvis, distance: 1 });
  assert.throws(() => addDistanceWarp(f.animator, { state: 'stop', joint: f.pelvis, distance: 1 }), /already/);
});

test('foot placement still works through the shared pose tools', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const { addFootPlacement } = await import('../packages/animator/dist/index.js'),
    placement = addFootPlacement(f.animator, {
      pelvis: f.pelvis,
      legs: f.legs.map((leg) => ({ ...leg, pole: [0, 0.5, 2] })),
      raycast: (origin) => ({ position: [origin[0], -0.1, origin[2]] }),
    });
  f.step(DT, 5);
  assert.ok(Math.abs(placement.pelvisOffset + 0.1) < 1e-6);
  void axisAngle;
});
