// Warping and motion matching on real motion capture: takes of CMU subjects 2 and 16 as they came from the mocap lab,
// read by parseBVH. Nothing here is made to measure: the feet do not plant cleanly, the hips surge on every step, a take
// starts metres from the origin and stops at its end. Foot contacts are found from the data, speeds are measured, and
// the capture's own foot slide is the floor no warp can beat. See tests/fixtures/cmu-mocap/NOTICE.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBVH } from '../packages/loaders/dist/mocap.js';
import { addRootMotion } from '../packages/animator/dist/index.js';
import { addDistanceWarp, addWarping } from '../packages/animator/dist/warping.js';
import { addMotionMatching, MotionDatabase } from '../packages/animator/dist/motion-matching.js';
import { animatorDocument, animatorRun, CMU_SCALE, largestGap, mocapClip, mocapJoints } from './support/animator-rig.js';

const DT = 1 / 120;
const FEET = ['LeftFoot', 'RightFoot'];
const take = (name) => parseBVH(readFileSync(new URL(`fixtures/cmu-mocap/${name}.bvh`, import.meta.url)), { scale: CMU_SCALE });
const mm = (metres) => `${(metres * 1000).toFixed(1)} mm`;
const span = (points) => {
  const range = (c) => Math.max(...points.map((p) => p[c])) - Math.min(...points.map((p) => p[c]));
  return Math.hypot(range(0), range(2));
};

async function player(bvh) {
  const f = await animatorRun(animatorDocument(mocapJoints(bvh), { Take: mocapClip(bvh) }), {
      initial: 'take',
      states: { take: 'Take' },
    }),
    i = (name) => f.index.get(name);
  f.pelvis = i('Hips');
  f.spine = [i('Spine'), i('Spine1')];
  f.legs = ['Left', 'Right'].map((side) => ({ hip: i(`${side}UpLeg`), knee: i(`${side}Leg`), ankle: i(`${side}Foot`) }));
  return f;
}
// The ankle under 0.2 m/s for over 8 frames counts as planted: no label in the file says so.
function planted(track, times) {
  const speed = track.map((_, i) => {
      const a = track[Math.max(0, i - 1)],
        b = track[Math.min(track.length - 1, i + 1)];
      return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (2 * DT);
    }),
    windows = [];
  let start = -1;
  for (let i = 0; i <= track.length; i++) {
    const down = i < track.length && speed[i] < 0.2;
    if (down && start < 0) start = i;
    if (!down && start >= 0) {
      if (i - start > 8) windows.push({ from: times[start], to: times[i - 1], slid: span(track.slice(start, i)) });
      start = -1;
    }
  }
  return windows;
}
// The take as recorded, with no warp: when each foot is planted and how far it slid in the lab.
async function contacts(bvh) {
  const f = await player(bvh),
    tracks = { LeftFoot: [], RightFoot: [] },
    times = [];
  for (let frame = 0; frame < bvh.frames - 2; frame++) {
    f.step(DT);
    times.push(f.animator.time);
    for (const foot of FEET) tracks[foot].push(f.world(foot));
  }
  f.release();
  return Object.fromEntries(FEET.map((foot) => [foot, planted(tracks[foot], times)]));
}
const clipSpeed = ({ clip, frames, frameTime }) => {
  const { keys } = clip.tracks.find((track) => track.target === 'Hips' && track.path === 'translation'),
    a = keys[0].value,
    b = keys[keys.length - 1].value;
  return Math.hypot(b[0] - a[0], b[2] - a[2]) / ((frames - 1) * frameTime);
};
// Walks the character steadily through the take and returns the worst slide of any planted window, and the mean.
async function walked(bvh, plants, { speed, angle = 0, warped = true, smoothing = 0.5 }) {
  const f = await player(bvh),
    velocity = [Math.sin(angle) * speed, 0, Math.cos(angle) * speed],
    end = (bvh.frames - 1) * bvh.frameTime - 0.02;
  addRootMotion(f.animator, { joint: f.pelvis, apply: false, smoothing });
  if (warped) addWarping(f.animator, { pelvis: f.pelvis, legs: f.legs, spine: f.spine, velocity, turnTime: 0 });
  const place = [0, 0, 0],
    tracks = { LeftFoot: [], RightFoot: [] },
    times = [];
  while (f.animator.time <= end && times.length < 4000) {
    for (let c = 0; c < 3; c++) place[c] += velocity[c] * DT;
    f.model.root.setPosition(place);
    f.store.tick(false);
    f.step(DT);
    times.push(f.animator.time);
    for (const foot of FEET) tracks[foot].push(f.world(foot));
  }
  f.release();
  const slides = [];
  for (const foot of FEET)
    for (const { from, to } of plants[foot]) {
      const points = tracks[foot].filter((_, i) => times[i] >= from && times[i] <= to);
      if (points.length > 2) slides.push(span(points));
    }
  return { worst: Math.max(...slides), mean: slides.reduce((a, b) => a + b, 0) / slides.length };
}

const walk = take('16_47'),
  otherWalker = take('02_01');
const walkPlants = await contacts(walk),
  otherPlants = await contacts(otherWalker);
const ownSlide = (plants) => Math.max(...FEET.flatMap((foot) => plants[foot].map((w) => w.slid)));

test('the takes are what the lab says: a person in metres, walking on real feet', () => {
  assert.ok(Math.abs(clipSpeed(walk) - 1.31) < 0.01, `walk ${clipSpeed(walk)} m/s`);
  assert.ok(Math.abs(clipSpeed(otherWalker) - 1.18) < 0.01, `other walker ${clipSpeed(otherWalker)} m/s`);
  for (const foot of FEET) assert.ok(walkPlants[foot].length >= 3, `${foot} planted ${walkPlants[foot].length} times`);
  const own = ownSlide(walkPlants);
  assert.ok(own > 0.01 && own < 0.025, `the capture's own foot slide is ${mm(own)}: real feet do not hold still`);
});

for (const [speed, limit] of [[0.7, 0.03], [1, 0.03], [1.4, 0.03], [1.8, 0.045], [3, 0.055]]) {
  test(`a real walk at ${speed} m/s keeps its planted feet near the capture's own slide, and without the warp does not`, async () => {
    const warped = await walked(walk, walkPlants, { speed }),
      bare = await walked(walk, walkPlants, { speed, warped: false });
    assert.ok(warped.worst < limit, `slid ${mm(warped.worst)}`);
    assert.ok(warped.worst < bare.worst, `slid ${mm(warped.worst)} against ${mm(bare.worst)} bare`);
  });
}

for (const [degrees, limit] of [[45, 0.04], [90, 0.055]]) {
  test(`a real walk ${degrees} degrees off the facing holds its feet`, async () => {
    const { worst } = await walked(walk, walkPlants, { speed: 1.3, angle: (degrees * Math.PI) / 180 });
    assert.ok(worst < limit, `slid ${mm(worst)}`);
  });
}

test('a second person: subject 2 walks at speeds it was not recorded at', async () => {
  for (const speed of [0.8, 1.6]) {
    const warped = await walked(otherWalker, otherPlants, { speed }),
      bare = await walked(otherWalker, otherPlants, { speed, warped: false });
    assert.ok(warped.worst < 0.065, `at ${speed} slid ${mm(warped.worst)}`);
    assert.ok(bare.worst > 3 * warped.worst, `at ${speed} slid ${mm(bare.worst)} bare`);
  }
});

test("root motion's smoothing keeps the hips' surge in the pose: at the take's own speed the feet hold better with it", async () => {
  const speed = clipSpeed(walk),
    kept = await walked(walk, walkPlants, { speed }),
    lost = await walked(walk, walkPlants, { speed, smoothing: 0 });
  assert.ok(kept.worst < 0.03, `slid ${mm(kept.worst)}`);
  assert.ok(lost.worst > 0.04, `slid ${mm(lost.worst)} with the surge taken out`);
});

test('a real stop, driven by distance, follows the distance left to its mark', async () => {
  const bvh = take('16_57'),
    f = await player(bvh);
  const { keys } = bvh.clip.tracks.find((track) => track.target === 'Hips' && track.path === 'translation'),
    start = keys[0].value,
    last = keys[keys.length - 1].value,
    whole = Math.hypot(last[0] - start[0], last[2] - start[2]),
    stop = { state: 'take', joint: f.pelvis, distance: whole },
    handle = addDistanceWarp(f.animator, stop);
  assert.ok(Math.abs(handle.length - whole) < 0.2, `travel ${handle.length} of ${whole}`);
  let worst = 0;
  for (let left = handle.length; left >= 0; left -= 0.05) {
    stop.distance = left;
    f.step(DT);
    const key = keys[Math.min(keys.length - 1, Math.round(f.animator.time / bvh.frameTime))].value,
      remaining = handle.length - Math.hypot(key[0] - start[0], key[2] - start[2]);
    worst = Math.max(worst, Math.abs(remaining - left));
  }
  f.release();
  assert.ok(worst < 0.02, `${mm(worst)} from the distance asked for`);
});

// Motion matching on the same lab's clips, with no speed labelled by hand.
const TAKES = { Slow: '16_15', Walk: '16_47', Fast: '16_21', Jog: '16_36', Run: '16_45', Veer: '16_11', Begin: '16_32', Stop: '16_57' };
const takes = Object.fromEntries(Object.entries(TAKES).map(([clip, file]) => [clip, take(file)]));
const clipPlants = {};
for (const [clip, bvh] of Object.entries(takes)) clipPlants[clip] = await contacts(bvh);
async function library(options) {
  const clips = Object.fromEntries(Object.entries(takes).map(([clip, bvh]) => [clip, mocapClip(bvh)])),
    f = await animatorRun(animatorDocument(mocapJoints(takes.Walk), clips), {
      initial: 'Begin',
      states: Object.fromEntries(Object.keys(clips).map((clip) => [clip, clip])),
    }),
    i = (name) => f.index.get(name);
  f.database = MotionDatabase.build(f.animator, {
    root: i('Hips'),
    bones: FEET.map(i),
    clips: Object.keys(clips).map((clip) => ({ clip, loop: false })),
    ...options,
  });
  return f;
}
const rowOf = (database, frame) => database.features.subarray(frame * database.width, (frame + 1) * database.width);

test('the table measures the takes: a row of the jog is about 2.7 m ahead a second on', async (t) => {
  const f = await library();
  t.after(() => f.release());
  const { database } = f,
    path = database.trajectoryAt,
    ahead = (frame) => database.features[frame * database.width + path + 5] / database.scales[path + 5] + database.centres[path + 5];
  for (const [clip, time, speed] of [['Slow', 1, 1.1], ['Walk', 1, 1.3], ['Fast', 1, 1.7], ['Jog', 0.3, 2.7]]) {
    const measured = ahead(database.frameAt(clip, time));
    assert.ok(Math.abs(measured - speed) < 0.15, `${clip} ${measured}`);
  }
});

test('the search on the real table equals comparing every row', async (t) => {
  const f = await library();
  t.after(() => f.release());
  const { database } = f;
  let seed = 5;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 6;
  for (let n = 0; n < 300; n++) {
    const query = Float32Array.from({ length: database.width }, random);
    let best = -1,
      cost = Infinity;
    for (let r = 0; r < database.rows; r++) {
      if (!database.searchable[r]) continue;
      const c = database.cost(query, r);
      if (c < cost) (cost = c), (best = r);
    }
    const found = database.search(query);
    assert.equal(found.frame, best);
    assert.equal(found.cost, cost);
  }
  for (let r = 0; r < database.rows; r++)
    if (database.searchable[r]) assert.ok(database.search(rowOf(database, r)).cost < 1e-9, `row ${r}`);
});

// A steady request for four seconds, after two to settle.
async function steady(velocity, stickiness) {
  const f = await library(),
    matcher = addMotionMatching(f.animator, { database: f.database, velocity, facing: [0, 0, 1], stickiness });
  f.step(DT, 240);
  const jumps = matcher.jumps,
    from = f.world('Root'),
    played = {},
    slides = [],
    runs = { LeftFoot: null, RightFoot: null };
  const close = (foot) => {
    if (runs[foot] && runs[foot].points.length > 8) slides.push(span(runs[foot].points));
    runs[foot] = null;
  };
  for (let frame = 0; frame < 480; frame++) {
    f.step(DT);
    played[matcher.clip] = (played[matcher.clip] ?? 0) + 1;
    for (const foot of FEET) {
      const plant = clipPlants[matcher.clip][foot].find((w) => f.animator.time >= w.from && f.animator.time <= w.to);
      if (runs[foot] && runs[foot].plant !== plant) close(foot);
      if (plant) (runs[foot] ??= { plant, points: [] }).points.push(f.world(foot));
    }
  }
  for (const foot of FEET) close(foot);
  const to = f.world('Root'),
    result = {
      played,
      jumps: matcher.jumps - jumps,
      covered: [to[0] - from[0], to[2] - from[2]],
      worst: Math.max(...slides, 0),
      mean: slides.reduce((a, b) => a + b, 0) / (slides.length || 1),
      count: slides.length,
    };
  f.release();
  return result;
}

for (const [speed, clip] of [[1.1, 'Slow'], [1.3, 'Walk'], [1.7, 'Fast'], [2.7, 'Jog'], [4, 'Run']]) {
  test(`a request for ${speed} m/s plays the take recorded at that speed and covers the ground`, async () => {
    const result = await steady([0, 0, speed]);
    assert.ok(result.played[clip] >= 300, `${JSON.stringify(result.played)}`);
    assert.ok(Math.abs(result.covered[1] - 4 * speed) < 0.02, `covered ${result.covered[1]}`);
    assert.ok(Math.abs(result.covered[0]) < 1e-6);
    // The ankle rule finds no plant at a jog or run: the foot rolls through its stance too fast.
    if (speed < 2) assert.ok(result.worst < 0.045, `a planted foot slid ${mm(result.worst)}`);
    if (speed < 2) assert.ok(result.jumps <= 7, `${result.jumps} jumps`);
  });
}

test('a real table needs a jump to pay for itself: a stickiness of 0.05 keeps jumping and the feet pay for it', async () => {
  const kept = await steady([0, 0, 1.3]),
    restless = await steady([0, 0, 1.3], 0.05);
  assert.equal(kept.jumps, 4);
  assert.ok(restless.jumps >= 3 * kept.jumps, `${restless.jumps} jumps`);
  assert.ok(restless.worst > 2 * kept.worst, `slid ${mm(restless.worst)} against ${mm(kept.worst)}`);
});

test('a standing request plays the standing part of a take', async () => {
  const result = await steady([0, 0, 0]);
  assert.equal(result.played.Begin, 480);
  assert.equal(result.covered[1], 0);
});

test('across six speed changes no joint moves over 70 mm a frame, and with no blend one does', async () => {
  const worstStep = async (blend) => {
    const f = await library(),
      velocity = [0, 0, 0],
      matcher = addMotionMatching(f.animator, { database: f.database, velocity, facing: [0, 0, 1], blend }),
      joints = Object.keys(mocapJoints(takes.Walk)),
      local = () => {
        const root = f.world('Root');
        return joints.map((name) => f.world(name).map((v, c) => v - root[c]));
      };
    f.step(DT, 60);
    let worst = 0,
      last = local();
    for (const speed of [1.3, 4, 0, 2.7, 1.1, 0]) {
      velocity[2] = speed;
      for (let i = 0; i < 120; i++) {
        f.step(DT);
        const now = local();
        worst = Math.max(worst, largestGap(now, last));
        last = now;
      }
    }
    const { jumps } = matcher;
    f.release();
    return { worst, jumps };
  };
  const blended = await worstStep(0.2),
    bare = await worstStep(1e-4);
  assert.ok(blended.jumps >= 6, `${blended.jumps} jumps`);
  assert.ok(blended.worst < 0.07, `a joint moved ${mm(blended.worst)} in a frame`);
  assert.ok(bare.worst > 0.5, `${mm(bare.worst)} with no blend`);
});

test('a request off to the side turns the character', async () => {
  const f = await library(),
    angle = (35 * Math.PI) / 180,
    velocity = [Math.sin(angle), 0, Math.cos(angle)],
    matcher = addMotionMatching(f.animator, { database: f.database, velocity });
  f.step(DT, 360);
  assert.ok(matcher.jumps > 0);
  const m = f.node('Root').matrix;
  assert.ok(Math.abs(Math.atan2(m[8], m[10]) - angle) < 0.02, `facing ${Math.atan2(m[8], m[10])}`);
  f.release();
});
