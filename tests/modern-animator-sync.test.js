// Sync groups (@margoengine/animator/sync): a walk and a run of different lengths stay in phase in a blend tree, through
// a transition and through a crossfade; markers line up clips whose steps fall at different fractions; root motion and
// timed events follow the phase. The last test runs Fox.glb, a real file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addSyncGroup } from '../packages/animator/dist/sync.js';
import { addRootMotion } from '../packages/animator/dist/index.js';
import { animatorDocument, animatorGLB, animatorRun, axisAngle, FOX } from './support/animator-rig.js';

const JOINTS = { Root: [null, 0, 0, 0], Hips: ['Root', 0, 1, 0], Foot: ['Hips', 0, -1, 0] };
const DT = 1 / 120;
const TAU = 2 * Math.PI;
// The foot's turn about X reads the clip's phase directly: one full turn per cycle, in two half-turn steps.
const phaseOf = (duration, stepAt = 0.5) => (t) => {
  const u = (t / duration) % 1;
  return u < stepAt ? (u / stepAt) * 0.5 : 0.5 + ((u - stepAt) / (1 - stepAt)) * 0.5;
};
const clip = (duration, stepAt, travel = 0) => {
  const phase = phaseOf(duration, stepAt);
  return {
    duration,
    fps: 240,
    tracks: {
      'Foot.rotation': (t) => axisAngle([1, 0, 0], TAU * (t >= duration ? 1 : phase(t))),
      'Hips.translation': (t) => [0, 1, (travel * t) / duration],
    },
  };
};
const CLIPS = {
  Walk: clip(1, 0.5, 1),
  Run: clip(0.6, 0.5, 1.8),
  Limp: clip(1, 0.7, 1),
  Idle: { duration: 2, tracks: { 'Foot.rotation': () => [0, 0, 0, 1] } },
};
const BLEND = { parameter: 'speed', samples: [{ value: 0, clip: 'Walk' }, { value: 1, clip: 'Run' }] };
const options = (extra = {}) => ({
  initial: 'move',
  parameters: { speed: 0.5 },
  states: { move: BLEND, walk: 'Walk', run: 'Run', limp: 'Limp', idle: 'Idle' },
  ...extra,
});
const rig = (extra) => animatorRun(animatorDocument(JOINTS, CLIPS), options(extra));
// The foot's angle about X, 0 to 2 pi.
const footAngle = (f) => {
  const q = f.rotation('Foot'),
    a = 2 * Math.atan2(q[0], q[3]);
  return (a + 2 * TAU) % TAU;
};
const close = (a, b, tolerance, message) => {
  const gap = Math.abs(((a - b + TAU / 2 + 2 * TAU) % TAU) - TAU / 2);
  assert.ok(gap < tolerance, `${message ?? ''} ${a} is not ${b}`);
};

test('without a group, clips of different lengths drift apart; with one, a blend stays in phase', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  f.step(DT, 45); // 0.375 s: Walk at 0.375 of a turn, Run at 0.625, mixed half way round the short arc
  const adrift = footAngle(f);
  close(adrift, TAU * 0.5, 1e-2, 'free clips average');
  const g = await rig();
  t.after(() => g.release());
  const sync = addSyncGroup(g.animator, { states: ['move'] });
  for (let i = 0; i < 400; i++) {
    g.step(DT);
    close(footAngle(g), TAU * sync.phase, 2e-3, `frame ${i}`);
  }
});

test('the cycle takes the blended length, and each clip plays at its own speed inside it', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const sync = addSyncGroup(f.animator, { states: ['move'] });
  // 0.5 between 1 s and 0.6 s cycles takes 0.8 s.
  f.step(DT, 48);
  // Clip lengths are float32 in glTF, so 0.6 is 0.60000002.
  assert.ok(Math.abs(sync.phase - 0.5) < 1e-6, `phase ${sync.phase}`);
  assert.ok(Math.abs(f.animator.normalizedTime - 0.5) < 1e-6, 'normalized time reads phase');
  f.animator.parameters.speed = 1;
  f.step(DT, 36); // the rest at 0.6 s a cycle: 0.3 s
  assert.ok(Math.abs(f.animator.normalizedTime - 1) < 1e-6, `lap ${f.animator.normalizedTime}`);
});

test('a transition keeps the phase, and a crossfade keeps both clips in phase to its end', async (t) => {
  const f = await rig({ initial: 'walk' });
  t.after(() => f.release());
  const sync = addSyncGroup(f.animator, { states: ['walk', 'run'] });
  f.step(DT, 36); // 0.3 of a cycle
  const before = sync.phase;
  f.animator.transition('run', 0.25);
  assert.ok(Math.abs(sync.phase - before) < 1e-12);
  assert.ok(Math.abs(f.animator.time - before * 0.6) < 1e-6, 'run starts at the same phase');
  for (let i = 0; i < 40; i++) {
    f.step(DT);
    close(footAngle(f), TAU * sync.phase, 2e-3, `fade frame ${i}`);
  }
});

test('leaving the group starts the next state from 0, and coming back starts at phase 0', async (t) => {
  const f = await rig({ initial: 'walk' });
  t.after(() => f.release());
  const sync = addSyncGroup(f.animator, { states: ['walk', 'run'] });
  f.step(DT, 30);
  f.animator.transition('idle', 0);
  assert.equal(f.animator.time, 0);
  f.step(DT, 30);
  f.animator.transition('run', 0);
  assert.equal(f.animator.time, 0);
  assert.equal(sync.phase, 0);
});

test('markers line up clips whose steps fall at different fractions', async (t) => {
  const f = await rig({ states: { move: { parameter: 'speed', samples: [{ value: 0, clip: 'Walk' }, { value: 1, clip: 'Limp' }] } } });
  t.after(() => f.release());
  const sync = addSyncGroup(f.animator, {
    states: ['move'],
    markers: ['Left', 'Right'],
    clipMarkers: {
      Walk: [
        { time: 0, name: 'Left' },
        { time: 0.5, name: 'Right' },
      ],
      // Rotated in the list on purpose: the cycle is the same.
      Limp: [
        { time: 0.7, name: 'Right' },
        { time: 0, name: 'Left' },
      ],
    },
  });
  for (let i = 0; i < 300; i++) {
    f.step(DT);
    close(footAngle(f), TAU * sync.phase, 2e-3, `frame ${i}`);
  }
});

test('a clip whose first marker is not at its start wraps correctly', async (t) => {
  const f = await rig({ initial: 'walk' });
  t.after(() => f.release());
  addSyncGroup(f.animator, {
    states: ['walk'],
    markers: ['Left', 'Right'],
    clipMarkers: {
      Walk: [
        { time: 0.25, name: 'Left' },
        { time: 0.75, name: 'Right' },
      ],
    },
  });
  // Phase 0 is the first marker; a cycle ends one loop later and the clock keeps its pace.
  assert.equal(f.animator.clipTime('Walk', 0), 0.25);
  assert.ok(Math.abs(f.animator.clipTime('Walk', 0.5) - 0.75) < 1e-12);
  assert.ok(Math.abs(f.animator.clipTime('Walk', 1) - 1.25) < 1e-12);
  assert.ok(Math.abs(f.animator.clipTime('Walk', 2.25) - 2.5) < 1e-12);
});

test('root motion follows the phase: a blended cycle travels the blended stride, a mid-cycle entry adds no jump', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  addSyncGroup(f.animator, { states: ['move', 'run'] });
  const motion = addRootMotion(f.animator, { joint: f.index.get('Hips') }),
    z = () => f.translation(f.model.root.id === undefined ? 0 : 'Root')[2];
  let travelled = 0;
  for (let i = 0; i < 96; i++) {
    f.step(DT);
    travelled += motion.translation[2];
  }
  // One 0.8 s cycle of 1 m and 1.8 m strides at half weight: 1.4 m.
  assert.ok(Math.abs(travelled - 1.4) < 1e-4, `travelled ${travelled}`);
  f.step(DT, 30);
  f.animator.transition('run', 0);
  f.step(DT);
  // The first frame in Run is one step of it, not the distance from its start to where it entered.
  assert.ok(Math.abs(motion.translation[2] - 3 * DT) < 1e-5, `first step ${motion.translation[2]}`);
  assert.ok(Number.isFinite(z()));
});

test('a crossfade between synced states keeps the bone in place under root motion', async (t) => {
  const f = await rig({ initial: 'walk' });
  t.after(() => f.release());
  addSyncGroup(f.animator, { states: ['walk', 'run'] });
  addRootMotion(f.animator, { joint: f.index.get('Hips') });
  f.step(DT, 30);
  f.animator.transition('run', 0.2);
  for (let i = 0; i < 30; i++) {
    f.step(DT);
    assert.ok(Math.abs(f.translation('Hips')[2]) < 1e-4, `frame ${i} bone at ${f.translation('Hips')[2]}`);
  }
});

test('timed events fire at the phase, so a footstep event stays on the step at any blend', async (t) => {
  const f = await rig({ events: [{ state: 'move', time: 0.5, name: 'step' }] });
  t.after(() => f.release());
  const sync = addSyncGroup(f.animator, { states: ['move'] }),
    seen = [];
  f.animator.on('event', () => seen.push(sync.phase));
  f.step(DT, 200);
  assert.equal(seen.length, 2);
  // An event fires on the first frame past its moment: a frame is DT / 0.8 of a cycle.
  for (const phase of seen) assert.ok(phase >= 0.5 && phase - 0.5 <= DT / 0.8, `at ${phase}`);
});

test('disposing returns each clip to its own clock', async (t) => {
  const f = await rig({ initial: 'walk' });
  t.after(() => f.release());
  const sync = addSyncGroup(f.animator, { states: ['walk'] });
  f.step(DT, 30);
  sync.dispose();
  sync.dispose();
  assert.throws(() => sync.phase, /disposed/);
  assert.equal(f.animator.clipTime('Walk', 0.7), 0.7);
});

test('bad groups name the fix', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  assert.throws(() => addSyncGroup(f.animator, { states: [] }), /at least one/);
  assert.throws(() => addSyncGroup(f.animator, { states: ['nope'] }), /not one of/);
  assert.throws(() => addSyncGroup(f.animator, { states: ['walk'], markers: ['Left'] }), /clipMarkers/);
  assert.throws(
    () =>
      addSyncGroup(f.animator, {
        states: ['walk'],
        markers: ['A', 'B', 'C'],
        clipMarkers: {
          Walk: [
            { time: 0, name: 'A' },
            { time: 0.2, name: 'C' },
            { time: 0.4, name: 'B' },
          ],
        },
      }),
    /cycle order/,
  );
  assert.throws(
    () =>
      addSyncGroup(f.animator, {
        states: ['walk'],
        markers: ['A', 'B'],
        clipMarkers: {
          Walk: [
            { time: 0.2, name: 'A' },
            { time: 0.2, name: 'B' },
          ],
        },
      }),
    /one moment/,
  );
  addSyncGroup(f.animator, { states: ['walk'] });
  assert.throws(() => addSyncGroup(f.animator, { states: ['walk'] }), /already/);
});

test('Fox.glb: Walk and Run, real clips of different lengths, run a blended cycle in phase', async (t) => {
  const file = animatorGLB(FOX),
    f = await animatorRun(file, {
      initial: 'move',
      parameters: { speed: 0.5 },
      states: { move: { parameter: 'speed', samples: [{ value: 0, clip: 'Walk' }, { value: 1, clip: 'Run' }] } },
    });
  t.after(() => f.release());
  const durations = Object.fromEntries(f.animation.clips.map((c) => [c.name, c.duration]));
  assert.notEqual(durations.Walk, durations.Run);
  const sync = addSyncGroup(f.animator, { states: ['move'] }),
    blended = (durations.Walk + durations.Run) / 2;
  f.step(blended / 200, 100);
  assert.ok(Math.abs(sync.phase - 0.5) < 1e-6, `phase ${sync.phase}`);
  assert.ok(Math.abs(f.animator.clipTime('Walk', f.animator.time) - durations.Walk / 2) < 1e-6);
  assert.ok(Math.abs(f.animator.clipTime('Run', f.animator.time) - durations.Run / 2) < 1e-6);
});
