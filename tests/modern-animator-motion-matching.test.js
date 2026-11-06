// Motion matching (@margoengine/animator/motion-matching): the database measures clips truly, the search is exact, a
// request picks the clip that fits it, steady requests stay put, jumps are smooth, and a table survives a round trip.
// The walk, run, strafe and idle here are stand-ins made to measure; Fox.glb runs the same path on a real file's clips,
// whose speeds are labelled by hand because they play in place. Neither is motion capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addMotionMatching, MotionDatabase, motionStates } from '../packages/animator/dist/motion-matching.js';
import { animatorDocument, animatorGLB, animatorRun, BIPED, bipedWalk, FOX, largestGap } from './support/animator-rig.js';

const CLIPS = {
  Idle: { duration: 1, tracks: { 'Hips.translation': (t) => [0, 1 + 0.003 * Math.sin(2 * Math.PI * t), 0] } },
  Walk: bipedWalk({ duration: 1, speed: 1 }),
  Run: bipedWalk({ duration: 0.3, speed: 3 }),
  Strafe: { duration: 1, tracks: { 'Hips.translation': (t) => [t, 1, 0] } },
};
const DT = 1 / 60;
async function rig() {
  const document = animatorDocument(BIPED, CLIPS),
    f = await animatorRun(document, { initial: 'Idle', states: { Idle: 'Idle', Walk: 'Walk', Run: 'Run', Strafe: 'Strafe' } }),
    i = (name) => f.index.get(name);
  f.options = { root: i('Hips'), bones: [i('LeftFoot'), i('RightFoot')] };
  f.database = MotionDatabase.build(f.animator, f.options);
  return f;
}
const row = (database, frame) => database.features.subarray(frame * database.width, (frame + 1) * database.width);
function bruteForce(database, query) {
  let best = -1,
    cost = Infinity;
  for (let r = 0; r < database.rows; r++) {
    if (!database.searchable[r]) continue;
    const c = database.cost(query, r);
    if (c < cost) (cost = c), (best = r);
  }
  return { best, cost };
}
const spread = (seed) => {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 6;
};

test('every row of a clip is a row of the table, with features centred and scaled', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const { database } = f;
  assert.equal(database.width, 2 * 6 + 3 + 3 * 4);
  assert.equal(database.rows, 30 + 30 + 9 + 30);
  assert.deepEqual(database.clips.map((block) => block.clip), ['Idle', 'Walk', 'Run', 'Strafe']);
  for (let i = 0; i < database.width; i++) {
    let sum = 0;
    for (let r = 0; r < database.rows; r++) sum += database.features[r * database.width + i];
    assert.ok(Math.abs(sum / database.rows) < 1e-3, `feature ${i} is centred`);
  }
});

test('the features measure the clip: a 3 m/s run is 3 m ahead in one second and an idle stays', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const { database } = f,
    path = database.trajectoryAt,
    real = (frame, i) => database.features[frame * database.width + i] / database.scales[i] + database.centres[i],
    run = database.frameAt('Run', 0.15),
    idle = database.frameAt('Idle', 0.5),
    strafe = database.frameAt('Strafe', 0.5);
  assert.ok(Math.abs(real(run, path + 5) - 3) < 0.01, `run z ${real(run, path + 5)}`);
  assert.ok(Math.abs(real(run, path + 4)) < 0.01, `run x ${real(run, path + 4)}`);
  assert.ok(Math.abs(real(idle, path + 5)) < 0.01, `idle z ${real(idle, path + 5)}`);
  assert.ok(Math.abs(real(strafe, path + 4) - 1) < 0.01, `strafe x ${real(strafe, path + 4)}`);
});

test('a loop reads straight over its seam', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const { database } = f,
    last = database.frameAt('Walk', 29 / 30),
    first = database.frameAt('Walk', 0),
    next = database.frameAt('Walk', 1 / 30);
  assert.equal(database.frameAt('Walk', 1), first);
  const path = database.trajectoryAt,
    real = (frame) => Array.from(row(database, frame), (v, i) => v / database.scales[i] + database.centres[i]);
  for (let i = path; i < database.width; i++) assert.ok(Math.abs(real(last)[i] - real(first)[i]) < 0.01, `path ${i} changes at the seam`);
  for (let i = 0; i < 6; i++) assert.ok(Math.abs(real(last)[i] - real(first)[i]) <= 0.04, `foot place ${i} changes at the seam`);
  assert.notEqual(last, next);
});

test('a row is its own best match, and the search equals comparing every row', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const { database } = f,
    random = spread(7);
  for (let r = 0; r < database.rows; r++) {
    const found = database.search(row(database, r));
    assert.ok(found.cost < 1e-9, `row ${r} cost ${found.cost}`);
  }
  for (let n = 0; n < 500; n++) {
    const query = Float32Array.from({ length: database.width }, random),
      found = database.search(query),
      expected = bruteForce(database, query);
    assert.equal(found.frame, expected.best);
    assert.equal(found.cost, expected.cost);
  }
});

test('the search skips boxes on a table large enough to have them', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const big = MotionDatabase.build(f.animator, { ...f.options, rate: 240 }),
    random = spread(11);
  assert.equal(big.rows, 240 * 3 + 72);
  for (let n = 0; n < 100; n++) {
    const query = Float32Array.from({ length: big.width }, random);
    assert.equal(big.search(query).frame, bruteForce(big, query).best);
  }
});

test('rows of a clip with no loop that run past its end are not landed on, and its last rows hold the end', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const database = MotionDatabase.build(f.animator, {
      ...f.options,
      clips: [{ clip: 'Idle', loop: true }, { clip: 'Walk', loop: false }],
      trajectory: [0.5],
    }),
    block = database.clips[1];
  assert.equal(block.count, 31);
  assert.equal(database.searchable[block.start + 15], 1);
  assert.equal(database.searchable[block.start + 16], 0);
  const found = database.search(row(database, block.start + 30));
  assert.ok(found.frame <= block.start + 15);
});

test('a clip told its speed gets the journey it does not have', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const database = MotionDatabase.build(f.animator, { ...f.options, clips: [{ clip: 'Idle', speed: 2 }, 'Walk'] }),
    path = database.trajectoryAt,
    real = database.features[(database.clips[0].start + 5) * database.width + path + 5] / database.scales[path + 5] + database.centres[path + 5];
  assert.ok(Math.abs(real - 2) < 0.01, `told 2, read ${real}`);
});

test('a request picks the clip that fits it', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const velocity = [0, 0, 0],
    matcher = addMotionMatching(f.animator, { database: f.database, velocity, facing: [0, 0, 1] });
  f.step(DT, 60);
  assert.equal(matcher.clip, 'Idle');
  velocity[2] = 1;
  f.step(DT, 120);
  assert.equal(matcher.clip, 'Walk');
  velocity[2] = 3;
  f.step(DT, 120);
  assert.equal(matcher.clip, 'Run');
  velocity[2] = 0;
  velocity[0] = 1;
  f.step(DT, 120);
  assert.equal(matcher.clip, 'Strafe');
  velocity[0] = 0;
  f.step(DT, 120);
  assert.equal(matcher.clip, 'Idle');
});

test('a steady request plays on without jumping, and the character covers the ground it was asked to', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const velocity = [0, 0, 1],
    matcher = addMotionMatching(f.animator, { database: f.database, velocity, facing: [0, 0, 1] });
  f.step(DT, 180);
  const jumps = matcher.jumps,
    before = f.world('Root');
  f.step(DT, 120);
  assert.equal(matcher.jumps, jumps);
  const after = f.world('Root');
  assert.ok(Math.abs(after[2] - before[2] - 2) < 0.02, `covered ${after[2] - before[2]}`);
  assert.ok(Math.abs(after[0] - before[0]) < 1e-6);
});

test('the clip plays in place: planted feet keep their ground as the character moves', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const velocity = [0, 0, 1];
  addMotionMatching(f.animator, { database: f.database, velocity, facing: [0, 0, 1] });
  f.step(DT, 240);
  let worst = Infinity,
    last = f.world('LeftFoot');
  for (let i = 0; i < 60; i++) {
    f.step(DT);
    const now = f.world('LeftFoot');
    worst = Math.min(worst, Math.hypot(now[0] - last[0], now[2] - last[2]));
    last = now;
  }
  assert.ok(worst < 0.002, `the slowest the foot went was ${worst} m a frame`);
  assert.ok(Math.abs(f.world('Hips')[2] - f.world('Root')[2]) < 0.15, 'the hips stay with the character');
});

test('jumps are smooth: no joint jumps more than a run allows in a frame', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const velocity = [0, 0, 0],
    matcher = addMotionMatching(f.animator, { database: f.database, velocity, facing: [0, 0, 1] }),
    joints = Object.keys(BIPED),
    local = () => {
      const root = f.world('Root');
      return joints.map((name) => f.world(name).map((v, c) => v - root[c]));
    };
  f.step(DT, 30);
  let worst = 0,
    last = local();
  for (const speed of [1, 3, 0, 3, 1, 0]) {
    velocity[2] = speed;
    for (let i = 0; i < 60; i++) {
      f.step(DT);
      const now = local();
      worst = Math.max(worst, largestGap(now, last));
      last = now;
    }
  }
  assert.ok(matcher.jumps >= 5, `${matcher.jumps} jumps`);
  assert.ok(worst < 0.15, `a joint moved ${worst} in one frame`);
});

test('the character turns to the way it is asked to go', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const velocity = [2, 0, 0];
  addMotionMatching(f.animator, { database: f.database, velocity, response: 0.3 });
  f.step(DT, 120);
  const m = f.node('Root').matrix;
  assert.ok(m[8] > 0.99, `facing ${m[8]} ${m[10]}`);
});

test('a model scaled by the game still reads world units', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  f.model.root.setScale([2, 2, 2]);
  const velocity = [0, 0, 2],
    matcher = addMotionMatching(f.animator, { database: f.database, velocity, facing: [0, 0, 1] });
  f.step(DT, 150);
  assert.equal(matcher.clip, 'Walk');
});

test('drive false leaves the character where the game has it', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const velocity = [0, 0, 1],
    matcher = addMotionMatching(f.animator, { database: f.database, velocity, drive: false, facing: [0, 0, 1] });
  f.step(DT, 120);
  assert.equal(matcher.clip, 'Walk');
  assert.equal(f.world('Root')[2], 0);
  assert.ok(Math.abs(matcher.velocity[2] - 1) < 0.01);
});

test('a table comes back from its bytes the same, and cut bytes are refused', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const bytes = f.database.toBinary(),
    copy = MotionDatabase.fromBinary(bytes);
  assert.deepEqual(copy.features, f.database.features);
  assert.deepEqual(copy.roots, f.database.roots);
  assert.deepEqual(copy.clips, f.database.clips);
  assert.deepEqual(copy.searchable, f.database.searchable);
  const velocity = [0, 0, 3],
    matcher = addMotionMatching(f.animator, { database: copy, velocity, facing: [0, 0, 1] });
  f.step(DT, 120);
  assert.equal(matcher.clip, 'Run');
  assert.throws(() => MotionDatabase.fromBinary(bytes.slice(0, bytes.byteLength - 1)), /cut short/);
  assert.throws(() => MotionDatabase.fromBinary(new ArrayBuffer(32)), /Not a motion database/);
});

test('bad settings name the fix, dispose stops it, and dispose twice is safe', async (t) => {
  const f = await rig();
  t.after(() => f.release());
  const { animator, options, database } = f;
  assert.throws(() => MotionDatabase.build(animator, { ...options, root: 99 }), /not one of/);
  assert.throws(() => MotionDatabase.build(animator, { ...options, bones: [] }), /1-8 bones/);
  assert.throws(() => MotionDatabase.build(animator, { ...options, rate: 0 }), /rate/);
  assert.throws(() => MotionDatabase.build(animator, { ...options, trajectory: [] }), /trajectory/);
  assert.throws(() => MotionDatabase.build(animator, { ...options, clips: ['Nope'] }), /Nope/);
  assert.throws(() => MotionDatabase.build(animator, { ...options, weights: { position: -1 } }), /weights/);
  assert.throws(() => database.search([1]), /numbers/);
  assert.throws(() => addMotionMatching(animator, { velocity: [0, 0, 0] }), /database/);
  assert.throws(() => addMotionMatching(animator, { database, velocity: [0, NaN, 0] }));
  assert.throws(() => addMotionMatching(animator, { database, velocity: [0, 0, 0], interval: 0 }), /interval/);
  const velocity = [0, 0, 3],
    matcher = addMotionMatching(animator, { database, velocity, facing: [0, 0, 1] });
  f.step(DT, 30);
  matcher.dispose();
  matcher.dispose();
  const clip = animator.state,
    place = f.world('Root');
  f.step(DT, 30);
  assert.equal(animator.state, clip);
  assert.deepEqual(f.world('Root'), place);
  assert.throws(() => matcher.search(), /disposed/);
});

test('an Animator without a state per clip is told how to get one', async (t) => {
  const document = animatorDocument(BIPED, CLIPS),
    f = await animatorRun(document, { initial: 'Idle', states: { Idle: 'Idle' } });
  t.after(() => f.release());
  const database = MotionDatabase.build(f.animator, { root: f.index.get('Hips'), bones: [f.index.get('LeftFoot')] });
  assert.throws(() => addMotionMatching(f.animator, { database, velocity: [0, 0, 0] }), /motionStates/);
  assert.deepEqual(Object.keys(motionStates(f.animation)), ['Idle', 'Walk', 'Run', 'Strafe']);
});

test('Fox.glb: its real Survey, Walk and Run clips are picked by speed, with speeds labelled by hand', async (t) => {
  const file = animatorGLB(FOX),
    f = await animatorRun(file, {
      initial: 'Survey',
      states: { Survey: 'Survey', Walk: 'Walk', Run: 'Run' },
    });
  t.after(() => f.release());
  const i = (name) => f.index.get(name),
    database = MotionDatabase.build(f.animator, {
      root: i('b_Hip_01'),
      bones: [i('b_LeftLeg01_015'), i('b_RightLeg01_019')],
      clips: [{ clip: 'Survey' }, { clip: 'Walk', speed: 60 }, { clip: 'Run', speed: 200 }],
    }),
    velocity = [0, 0, 0],
    matcher = addMotionMatching(f.animator, { database, velocity, facing: [0, 0, 1] });
  assert.ok(database.rows > 100, `${database.rows} rows`);
  f.step(DT, 60);
  assert.equal(matcher.clip, 'Survey');
  velocity[2] = 60;
  f.step(DT, 150);
  assert.equal(matcher.clip, 'Walk');
  velocity[2] = 200;
  f.step(DT, 150);
  assert.equal(matcher.clip, 'Run');
  for (let k = 0; k < 3; k++) assert.ok(Number.isFinite(f.world('b_Head_05')[k]));
});
