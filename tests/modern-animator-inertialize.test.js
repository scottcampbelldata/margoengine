// Inertialization (@margoengine/animator/inertialize): a state change plays the new pose with no pop and no jump in
// speed, the offset ends on time and exactly, it never crosses the target, the new state alone is sampled, and everything
// a crossfade carries (positions, rotations, scales, morph weights) is carried. The last test runs Fox.glb, a real file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addInertialization } from '../packages/animator/dist/inertialize.js';
import { addRootMotion } from '../packages/animator/dist/index.js';
import { animatorDocument, animatorGLB, animatorRun, axisAngle, FOX } from './support/animator-rig.js';

const JOINTS = { Root: [null, 0, 0, 0], Bone: ['Root', 0, 1, 0], Tip: ['Bone', 0, 1, 0] };
const DT = 1 / 60;
// Up moves at +1 m/s, Down at -1 m/s from 2, Still stays at 0.5, Ramp starts at 3 moving at +2 m/s.
const CLIPS = {
  Up: { duration: 4, tracks: { 'Bone.translation': (t) => [t, 0, 0] } },
  Down: { duration: 4, tracks: { 'Bone.translation': (t) => [2 - t, 0, 0] } },
  Still: { duration: 4, tracks: { 'Bone.translation': () => [0.5, 0, 0] } },
  Ramp: { duration: 4, tracks: { 'Bone.translation': (t) => [3 + 2 * t, 0, 0] } },
  SpinA: { duration: 4, tracks: { 'Bone.rotation': (t) => axisAngle([0, 1, 0], t) } },
  SpinB: { duration: 4, tracks: { 'Bone.rotation': (t) => axisAngle([0, 1, 0], 1.5 - t) } },
  Grow: { duration: 4, tracks: { 'Bone.scale': () => [2, 2, 2] } },
};
const STATES = Object.fromEntries(Object.keys(CLIPS).map((name) => [name, name]));

async function rig(initial, options = {}) {
  const f = await animatorRun(animatorDocument(JOINTS, CLIPS), { initial, states: STATES, ...options });
  return f;
}
const x = (f) => f.translation('Bone')[0];

test('a switch makes no pop and no jump in speed, and the pose lands on the new clip on time', async (t) => {
  const f = await rig('Up');
  t.after(() => f.release());
  const inertia = addInertialization(f.animator, { duration: 0.5 });
  f.step(DT, 60);
  const samples = [x(f)];
  f.animator.transition('Still');
  assert.equal(inertia.active, true);
  for (let i = 0; i < 40; i++) {
    f.step(DT);
    samples.push(x(f));
  }
  // Up runs at 1 m/s: the first frames keep that speed, and every later change of speed is small.
  assert.ok(Math.abs((samples[1] - samples[0]) / DT - 1) < 1e-3, `first step ${(samples[1] - samples[0]) / DT}`);
  assert.ok(Math.abs((samples[2] - samples[1]) / DT - 1) < 1e-3, `second step ${(samples[2] - samples[1]) / DT}`);
  // The curve's strongest acceleration is its first, 20 x0 / t1^2 + 8 v0 / t1 = 56 m/s/s for 0.5 m at +1 m/s over 0.5 s.
  for (let i = 2; i < samples.length; i++) {
    const before = (samples[i - 1] - samples[i - 2]) / DT,
      after = (samples[i] - samples[i - 1]) / DT;
    assert.ok(Math.abs(after - before) < 56 * DT, `speed jumps ${before} to ${after} at frame ${i}`);
  }
  f.step(DT, 8);
  assert.equal(inertia.active, false);
  assert.equal(inertia.remaining, 0);
  assert.equal(x(f), 0.5, 'exact once faded');
});

test('an offset that is closing never crosses the target pose', async (t) => {
  const f = await rig('Up');
  t.after(() => f.release());
  addInertialization(f.animator, { duration: 2 });
  f.step(DT, 30); // at 0.5, moving +1
  f.animator.transition('Ramp'); // far ahead, the offset is negative and closing
  const gaps = [];
  for (let i = 0; i < 200; i++) {
    f.step(DT);
    gaps.push(3 + 2 * f.animator.time - x(f));
  }
  assert.ok(
    gaps.every((gap) => gap > -1e-6),
    'stayed on one side',
  );
  assert.ok(Math.abs(gaps.at(-1)) < 1e-5);
});

test('a second switch during a fade starts from the output, so there is still no pop', async (t) => {
  const f = await rig('Up');
  t.after(() => f.release());
  addInertialization(f.animator, { duration: 0.5 });
  f.step(DT, 30);
  f.animator.transition('Still');
  f.step(DT, 10);
  let last = x(f);
  f.animator.transition('Ramp');
  for (let i = 0; i < 20; i++) {
    f.step(DT);
    const now = x(f);
    // 2.7 m closing in 0.5 s peaks near 10 m/s on top of the clip's 2 m/s: a fifth of a metre a frame, not 2.7 m at once.
    assert.ok(Math.abs(now - last) < 0.25, `frame ${i} jumped from ${last} to ${now}`);
    last = now;
  }
});

test('rotations fade along their axis, keep their speed and end exactly', async (t) => {
  const f = await rig('SpinA');
  t.after(() => f.release());
  addInertialization(f.animator, { duration: 0.5 });
  const angle = () => {
    const q = f.rotation('Bone');
    return 2 * Math.atan2(q[1], q[3]);
  };
  f.step(DT, 30);
  const a = angle();
  f.animator.transition('SpinB');
  f.step(DT);
  const b = angle();
  f.step(DT);
  const c = angle();
  assert.ok(Math.abs((b - a) / DT - 1) < 1e-3, `first step turns at ${(b - a) / DT}`);
  assert.ok(Math.abs((c - b) / DT - 1) < 1e-3, `second step turns at ${(c - b) / DT}`);
  f.step(DT, 40);
  assert.ok(Math.abs(angle() - (1.5 - f.animator.time)) < 1e-5, 'on the new clip');
});

test('a jump in scale fades instead of popping, as a crossfade would', async (t) => {
  const f = await rig('Still');
  t.after(() => f.release());
  addInertialization(f.animator, { duration: 0.2 });
  f.step(DT, 5);
  f.animator.transition('Grow');
  const scale = () => f.store.transforms.sx[f.node('Bone').id];
  f.step(DT, 2);
  assert.equal(scale(), 1, 'the old motion carries on');
  f.step(DT, 6);
  assert.ok(scale() > 1 && scale() < 2, `mid fade ${scale()}`);
  f.step(DT, 8);
  assert.equal(scale(), 2);
});

test('a transition of 0 stays a hard cut unless a fixed duration is set; a graph keeps its own timing', async (t) => {
  const f = await rig('Up');
  t.after(() => f.release());
  const inertia = addInertialization(f.animator);
  f.step(DT, 30);
  f.animator.transition('Still', 0);
  assert.equal(inertia.active, false);
  f.step(DT);
  assert.equal(x(f), 0.5);
  f.animator.transition('Up', 0.3);
  assert.equal(inertia.active, true);
  assert.ok(Math.abs(inertia.remaining - 0.3) < 1e-12);
});

test('smooth() fades a jump the graph did not cause, and disposing returns to crossfades', async (t) => {
  const f = await rig('Up');
  t.after(() => f.release());
  const inertia = addInertialization(f.animator, { duration: 0.3 });
  f.step(DT, 30);
  const before = x(f);
  f.animator.time = 3;
  inertia.smooth();
  f.step(DT);
  assert.ok(Math.abs(x(f) - before - DT) < 1e-3, 'the jump did not show');
  f.step(DT, 30);
  assert.ok(Math.abs(x(f) - f.animator.time) < 1e-6, 'and then the clip plays');
  inertia.dispose();
  inertia.dispose();
  assert.throws(() => inertia.smooth(), /disposed/);
  f.animator.transition('Still', 0.1);
  f.step(0.05);
  const mid = x(f);
  assert.ok(mid > 0.5 && mid < f.animator.time + 3, `crossfading at ${mid}`);
});

test('the pose stays put while paused, mid fade', async (t) => {
  const f = await rig('Up');
  t.after(() => f.release());
  addInertialization(f.animator, { duration: 0.5 });
  f.step(DT, 30);
  f.animator.transition('Still');
  f.step(DT, 6);
  const held = x(f);
  f.animator.playing = false;
  f.step(DT, 5);
  assert.equal(x(f), held);
  f.animator.playing = true;
  f.step(DT);
  assert.ok(Math.abs(x(f) - held) < 0.1);
});

test('root motion keeps working: the character travels on while the bone fades', async (t) => {
  const f = await rig('Up');
  t.after(() => f.release());
  addInertialization(f.animator, { duration: 0.2 });
  const motion = addRootMotion(f.animator, { joint: f.index.get('Bone') });
  f.step(DT, 30);
  f.animator.transition('Down');
  f.step(DT, 30);
  assert.ok(Math.abs(motion.translation[0] + DT) < 1e-5, `travelling at ${motion.translation[0] / DT}`);
  assert.ok(Math.abs(x(f) - 2) < 1e-5, `bone holds the clip's start, ${x(f)}`);
});

test('invalid durations throw', async (t) => {
  const f = await rig('Up');
  t.after(() => f.release());
  assert.throws(() => addInertialization(f.animator, { duration: 0 }), RangeError);
  assert.throws(() => addInertialization(f.animator, { duration: Infinity }), RangeError);
  const inertia = addInertialization(f.animator);
  assert.throws(() => inertia.smooth(-1), RangeError);
});

test('Fox.glb: a Run to Survey switch moves bones less per frame than the hard cut, on real clips', async (t) => {
  const file = animatorGLB(FOX);
  const states = { Run: 'Run', Survey: 'Survey', Walk: 'Walk' };
  const worst = async (smooth) => {
    const f = await animatorRun(file, { initial: 'Run', states });
    t.after(() => f.release());
    if (smooth) addInertialization(f.animator, { duration: 0.3 });
    const bones = f.model.nodes.map((_, i) => i),
      snapshot = () => bones.map((i) => f.rotation(i));
    f.step(DT, 20);
    let last = snapshot(),
      largest = 0;
    f.animator.transition('Survey', smooth ? 0.3 : 0);
    for (let i = 0; i < 40; i++) {
      f.step(DT);
      const now = snapshot();
      for (let b = 0; b < now.length; b++) {
        const dot = Math.abs(now[b].reduce((sum, v, c) => sum + v * last[b][c], 0));
        largest = Math.max(largest, 2 * Math.acos(Math.min(1, dot)));
      }
      last = now;
    }
    return largest;
  };
  const cut = await worst(false),
    faded = await worst(true);
  assert.ok(cut > 0.3, `the hard cut pops, ${cut} radians in one frame`);
  assert.ok(faded < cut / 3, `inertialization turned at most ${faded} radians in a frame against ${cut}`);
});
