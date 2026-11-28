// Stepping (@margoengine/animator/stepping): a biped walking planned footfalls holds its knees near straight under load,
// swings them about as far as people do, and its pelvis rises and falls about as much as a person's centre of mass.
// Before this entry the stepping-stones demo planned its own pelvis 4.2 cm below standing and 3.1 cm short of the leg's
// length, then subtracted the smoothing filter's worst-case rise everywhere: the walker stood with knees near 50 degrees,
// bent them past 100 degrees and bobbed about 15 cm on level ground (KB-STEP-CROUCH1).
//
// Reference values: Perry and Burnfield, Gait Analysis: Normal and Pathological Function, 2nd ed., 2010 (knee about 5
// degrees at initial contact and midstance, 15 to 20 at loading response, near 60 in initial swing); Saunders, Inman and
// Eberhart, The major determinants in normal and pathological gait, J Bone Joint Surg 1953, and Gard, Miff and Kuo,
// Comparison of kinematic and kinetic methods for computing the vertical motion of the body center of mass during
// walking, Hum Mov Sci 2004 (vertical centre of mass travel about 4 to 5 cm); Riener, Rabuffetti and Frigo, Stair ascent
// and descent at different inclinations, Gait Posture 2002 (swing knee near 90 degrees stepping up a stair).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStepper, kneeFlexionAt, legReach, upperBodyMotion } from '../packages/animator/dist/stepping.js';

const DEG = Math.PI / 180;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// An adult leg (hip height 0.95 m, thigh 0.41 m, shin 0.47 m), the stepping-stones walker's own proportions.
const legs = [1, -1].map((side) => ({ hip: [side * 0.1134, 0.9462, -0.0046], thigh: 0.4104, shin: 0.4687 }));

function walk(options) {
  const stepper = createStepper({ legs, ...options });
  const frames = [];
  const record = () => {
    const { list } = stepper.motion;
    frames.push({
      root: [...stepper.root],
      step: stepper.step,
      feet: stepper.feet.map((foot) => ({ ...foot, ankle: [...foot.ankle] })),
      knees: legs.map((leg, i) => {
        const [x, y, z] = leg.hip;
        const hip = [
          stepper.root[0] + x,
          stepper.root[1] + y + (i ? -0.5 : 0.5) * 0.2268 * Math.sin(list),
          stepper.root[2] + z,
        ];
        return {
          flexion: kneeFlexionAt(leg, distance(hip, stepper.feet[i].ankle)) / DEG,
          stretch: distance(hip, stepper.feet[i].ankle) - (leg.thigh + leg.shin),
        };
      }),
    });
  };
  record();
  stepper.start();
  while (stepper.moving) {
    stepper.update(1 / 60);
    record();
  }
  return { stepper, frames };
}

const median = (values) => values.sort((a, b) => a - b)[values.length >> 1];
const singleSupport = (frames) =>
  frames
    .filter((f) => (f.feet[0].pin === null) !== (f.feet[1].pin === null))
    .map((f) => f.knees[f.feet[0].pin ? 0 : 1].flexion);
const swing = (frames) => frames.flatMap((f) => f.knees.filter((_, i) => f.feet[i].pin === null).map((k) => k.flexion));

const level = {
  start: [
    [0.1, 0, 0],
    [-0.1, 0, 0.31],
  ],
  routes: [[...Array.from({ length: 9 }, (_, i) => [i % 2 ? -0.1 : 0.1, 0, 0.31 + 0.62 * (i + 1)]), [-0.1, 0, 5.89]]],
};

test('level walking: knees and pelvis travel match published human gait', () => {
  const { frames } = walk(level);
  const first = frames[0],
    last = frames.at(-1);
  for (const knee of [...first.knees, ...last.knees]) assert.ok(knee.flexion < 15, `standing knee ${knee.flexion}`);
  const loaded = median(singleSupport(frames));
  assert.ok(loaded >= 5 && loaded <= 22, `single-support knee median ${loaded}`);
  const swingPeak = Math.max(...swing(frames));
  assert.ok(swingPeak >= 45 && swingPeak <= 72, `swing knee peak ${swingPeak}`);
  const middle = frames.slice(Math.floor(frames.length * 0.3), Math.floor(frames.length * 0.7)).map((f) => f.root[1]);
  const travel = Math.max(...middle) - Math.min(...middle);
  assert.ok(travel >= 0.025 && travel <= 0.06, `vertical pelvis travel ${travel} m`);
  // Every planted leg reaches its foot: the pelvis never stands higher than the legs are long (to within a millimetre,
  // the plan being sampled every 18 ms).
  for (const f of frames)
    f.knees.forEach((knee, i) => {
      if (f.feet[i].pin) assert.ok(knee.stretch <= 1e-3, `planted leg stretched ${knee.stretch} m`);
    });
});

test('stepping stones: knees stay in the range people use on stones and stairs', () => {
  const stones = [
    [0.21, 0.16, -1.33],
    [-0.13, 0.21, -0.78],
    [0.23, 0.29, -0.18],
    [-0.18, 0.17, 0.43],
    [0.18, 0.22, 1.02],
    [-0.17, 0.11, 1.54],
    [0.23, 0.082, 1.94],
    [-0.2, 0.079, 2.19],
  ];
  const routes = [-0.14, 0, 0.14].map((offset) => stones.map((s, i) => (i === 2 ? [s[0] + offset, s[1], s[2]] : s)));
  const { frames } = walk({
    start: [
      [0.174, 0.081, -2.15],
      [-0.17, 0.075, -1.94],
    ],
    routes,
  });
  for (const knee of [...frames[0].knees, ...frames.at(-1).knees])
    assert.ok(knee.flexion < 20, `standing knee ${knee.flexion}`);
  const loaded = median(singleSupport(frames));
  assert.ok(loaded <= 25, `single-support knee median ${loaded}`);
  const peak = Math.max(...frames.flatMap((f) => f.knees.map((k) => k.flexion)));
  assert.ok(peak <= 85, `peak knee ${peak}`);
  // Never bent backwards: a planted leg's hip stays within its length of the ankle.
  for (const f of frames) f.knees.forEach((k, i) => f.feet[i].pin && assert.ok(k.stretch <= 1e-3));
});

test('planted contacts hold still and the swing foot moves continuously', () => {
  const { frames } = walk(level);
  for (let n = 1; n < frames.length; n++) {
    for (let i = 0; i < 2; i++) {
      const a = frames[n - 1].feet[i],
        b = frames[n].feet[i];
      assert.ok(distance(a.ankle, b.ankle) < 0.08, `ankle jump ${distance(a.ankle, b.ankle)} m at frame ${n}`);
      // 8 cm a frame at 60 frames a second: a swing foot peaks near 4 m/s in brisk walking.
      if (a.pin && b.pin && a.pin === b.pin) assert.ok(distance(a.reference, b.reference) < 1e-9, 'planted pin slid');
    }
    assert.ok(
      Math.abs(frames[n].root[1] - frames[n - 1].root[1]) < 0.64 / 60 + 1e-3,
      'pelvis faster than its lift rate',
    );
  }
});

test('standing on uneven ground lists the pelvis instead of crouching', () => {
  const start = [
    [0.15, 0.03, 0],
    [-0.15, 0, 0.25],
  ];
  const { stepper, frames } = walk({
    start,
    routes: [
      [
        [0.15, 0, 0.9],
        [-0.15, 0, 1.15],
      ],
    ],
  });
  assert.ok(
    frames[0].knees.every((k) => k.flexion < 15),
    `standing knees ${frames[0].knees.map((k) => k.flexion)}`,
  );
  stepper.reset();
  const listed = stepper.motion.list;
  assert.ok(listed > 0.1 && listed <= 0.12, `list ${listed}`);
  const body = upperBodyMotion(stepper.motion);
  assert.ok(Math.abs(body.pelvisRoll - listed) < 1e-9 && Math.abs(body.chestRoll + listed) < 1e-9);
});

test('leg reach and knee flexion are inverse', () => {
  for (const angle of [0, 5, 30, 60, 89]) {
    const reach = legReach(legs[0], angle * DEG);
    assert.ok(Math.abs(kneeFlexionAt(legs[0], reach) / DEG - angle) < 1e-6);
  }
});

test('bad options are rejected with a fix', () => {
  assert.throws(() => createStepper({ legs, start: level.start, routes: [] }), RangeError);
  assert.throws(
    () =>
      createStepper({
        legs,
        start: level.start,
        routes: [
          [[0, 0, 1]],
          [
            [0, 0, 1],
            [0, 0, 2],
          ],
        ],
      }),
    RangeError,
  );
  assert.throws(
    () => createStepper({ legs: [legs[1], legs[0]], start: level.start, routes: level.routes }),
    RangeError,
  );
  assert.throws(() => createStepper({ legs, start: level.start, routes: level.routes, kneeFlexion: 2 }), RangeError);
  const stepper = createStepper({ legs, start: level.start, routes: level.routes });
  assert.throws(() => stepper.update(-1), RangeError);
});
