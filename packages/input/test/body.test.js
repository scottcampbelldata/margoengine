import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BodyDriver, handTargets, POSE_TARGETS } from '../dist/body.js';
import { landmarkStream } from '../dist/landmarks.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/body-landmarks.json', import.meta.url), 'utf8'));
const pose = (...layers) => {
  const named = Object.assign({}, ...layers);
  return Array.from({ length: 33 }, (_, i) => {
    const [x, y, z, visibility] = named[i] ?? [0, 0, 0, 0];
    return { x, y, z, visibility };
  });
};
const hand = (...layers) => {
  const named = Object.assign({}, ...layers);
  return Array.from({ length: 21 }, (_, i) => {
    const p = named[i];
    // Unlisted hand points sit on the wrist; no target in the test reads them.
    return p ? { x: p[0], y: p[1], z: p[2] } : { x: 0, y: 0, z: 0 };
  });
};
const frame = (time, { body, left } = {}) => ({
  time,
  faces: [],
  hands: left ? [{ landmarks: left, worldLandmarks: left, handedness: 'left' }] : [],
  poses: body ? [{ landmarks: body, worldLandmarks: body }] : [],
});

// A T-pose humanoid in model space (y up, facing +z, its left at +x), rest rotations identity: [name, parent, world position].
const BONES = [
  ['hips', null, [0, 0.95, 0]],
  ['spine', 'hips', [0, 1.05, 0]],
  ['upperChest', 'spine', [0, 1.29, 0]],
  ['neck', 'upperChest', [0, 1.45, 0]],
  ['head', 'neck', [0, 1.55, 0]],
  ...['left', 'right'].flatMap((s) => {
    const x = s === 'left' ? 1 : -1;
    return [
      [`${s}Shoulder`, 'upperChest', [0.05 * x, 1.4, 0]],
      [`${s}UpperArm`, `${s}Shoulder`, [0.17 * x, 1.4, 0]],
      [`${s}LowerArm`, `${s}UpperArm`, [0.44 * x, 1.4, 0]],
      [`${s}Hand`, `${s}LowerArm`, [0.69 * x, 1.4, 0]],
      [`${s}IndexProximal`, `${s}Hand`, [0.775 * x, 1.4, 0.02]],
      [`${s}IndexIntermediate`, `${s}IndexProximal`, [0.815 * x, 1.4, 0.02]],
      [`${s}IndexDistal`, `${s}IndexIntermediate`, [0.84 * x, 1.4, 0.02]],
      [`${s}MiddleProximal`, `${s}Hand`, [0.78 * x, 1.4, 0]],
      [`${s}LittleProximal`, `${s}Hand`, [0.765 * x, 1.4, -0.03]],
      [`${s}UpperLeg`, 'hips', [0.09 * x, 0.91, 0]],
      [`${s}LowerLeg`, `${s}UpperLeg`, [0.09 * x, 0.5, 0.01]],
      [`${s}Foot`, `${s}LowerLeg`, [0.09 * x, 0.08, 0]],
      [`${s}Toes`, `${s}Foot`, [0.09 * x, 0.02, 0.13]],
    ];
  }),
];
/** A minimal skeleton: local rotations written by setPose, translations fixed. */
const skeleton = (prefix = '') => {
  const names = BONES.map(([n]) => prefix + n),
    index = new Map(BONES.map(([n], i) => [n, i])),
    parents = BONES.map(([, p]) => (p ? index.get(p) : -1)),
    rotations = BONES.map(() => [0, 0, 0, 1]),
    translations = BONES.map(([, p, w]) => {
      const pw = p ? BONES[index.get(p)][2] : [0, 0, 0];
      return [w[0] - pw[0], w[1] - pw[1], w[2] - pw[2]];
    });
  return {
    names,
    parents,
    getPose: (i) => ({ translation: [...translations[i]], rotation: [...rotations[i]] }),
    setPose: (i, { rotation }) => (rotations[i] = [...rotation]),
    rotations,
    translations,
    index: (n) => index.get(n),
  };
};
const mul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
];
const rotate = (q, v) => mul(mul(q, [...v, 0]), [-q[0], -q[1], -q[2], q[3]]).slice(0, 3);
const worldRotation = (sk, i) => (i < 0 ? [0, 0, 0, 1] : mul(worldRotation(sk, sk.parents[i]), sk.rotations[i]));
/** Unit world direction from bone `name` to its child `child`. */
const direction = (sk, name, child) => {
  const c = sk.index(child),
    v = rotate(worldRotation(sk, sk.parents[c]), sk.translations[c]),
    l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const near = (a, b, tolerance = 1e-6) =>
  assert.ok(
    a.every((v, i) => Math.abs(v - b[i]) < tolerance),
    `${a.map((v) => v.toFixed(4))} != ${b}`,
  );

test('pose landmarks turn the arms onto the landmark directions, holding bones it cannot see', () => {
  const sk = skeleton();
  using driver = new BodyDriver(sk, { smoothing: false });
  assert.ok(driver.bones.includes('leftUpperArm') && driver.bones.includes('leftFoot'));
  driver.calibrate(frame(0, { body: pose(fixture.tpose) }));
  // The calibration pose reads as the rest pose.
  driver.update(frame(0, { body: pose(fixture.tpose) }));
  for (const r of sk.rotations) near(r.map(Math.abs), [0, 0, 0, 1]);
  const before = [...sk.rotations[sk.index('rightLowerLeg')]];
  const state = driver.update(frame(33, { body: pose(fixture.tpose, fixture.bent) }));
  assert.equal(state.tracked, true);
  near(direction(sk, 'leftUpperArm', 'leftLowerArm'), [0, -1, 0]);
  near(direction(sk, 'leftLowerArm', 'leftHand'), [0, 0, 1]);
  near(direction(sk, 'rightLowerArm', 'rightHand'), [0, -1, 0]);
  // The right knee is hidden (visibility 0.1): its bones keep their rotation.
  assert.deepEqual(sk.rotations[sk.index('rightLowerLeg')], before);
});

test('joint limits bound the turn from rest relative to the parent', () => {
  const sk = skeleton();
  const driver = new BodyDriver(sk, { smoothing: false, limits: { leftLowerArm: 0.5 } });
  driver.calibrate(frame(0, { body: pose(fixture.tpose) }));
  driver.update(frame(33, { body: pose(fixture.tpose, fixture.bent) }));
  const r = sk.rotations[sk.index('leftLowerArm')];
  assert.ok(Math.abs(2 * Math.acos(Math.min(1, Math.abs(r[3]))) - 0.5) < 1e-9);
});

test('hand landmarks drive the hand and fingers; an uncalibrated driver uses the skeleton rest directions', () => {
  const sk = skeleton();
  const driver = new BodyDriver(sk, { smoothing: false, parts: ['hands'] });
  assert.ok(!driver.bones.includes('leftUpperArm'));
  driver.update(frame(0, { left: hand(fixture.hand) }));
  // The flat hand matches the rest pose, so the hand stays put.
  near(direction(sk, 'leftHand', 'leftMiddleProximal'), [1, 0, 0], 1e-3);
  driver.update(frame(33, { left: hand(fixture.hand, fixture.curl) }));
  near(direction(sk, 'leftIndexProximal', 'leftIndexIntermediate'), [0, -1, 0]);
  // A mirrored picture reads the detector's right hand as the subject's left.
  const flipped = skeleton(),
    mirrored = new BodyDriver(flipped, { smoothing: false, parts: ['hands'], mirror: true });
  mirrored.update(frame(0, { left: hand(fixture.hand, fixture.curl) }));
  near(direction(flipped, 'rightIndexProximal', 'rightIndexIntermediate'), [0, -1, 0]);
  near(flipped.rotations[flipped.index('leftIndexProximal')], [0, 0, 0, 1]);
});

test('a bones map retargets onto other names; lost tracking returns to rest after hold', () => {
  const sk = skeleton('mixamorig:');
  const bones = Object.fromEntries(BONES.map(([n]) => [n, 'mixamorig:' + n]));
  const driver = new BodyDriver(sk, { smoothing: false, bones, hold: 0.25 }).calibrate(
    frame(0, { body: pose(fixture.tpose) }),
  );
  driver.update(frame(0, { body: pose(fixture.tpose, fixture.bent) }));
  assert.ok(Math.abs(sk.rotations[sk.index('leftUpperArm')][3]) < 0.99);
  assert.equal(driver.update(frame(200)).tracked, true);
  assert.equal(driver.update(frame(400)).tracked, false);
  near(sk.rotations[sk.index('leftUpperArm')], [0, 0, 0, 1]);
  assert.throws(() => new BodyDriver(skeleton('x_')), { code: 'state' });
  assert.ok(POSE_TARGETS.length >= 13 && handTargets('left').length === 16);
});

test('smoothing lags a step, drive() reads a source and dispose ends the driver', async () => {
  const sk = skeleton();
  const driver = new BodyDriver(sk).calibrate(frame(0, { body: pose(fixture.tpose) }));
  driver.update(frame(0, { body: pose(fixture.tpose) }));
  const source = landmarkStream({ buffer: 2 });
  source.push(frame(33, { body: pose(fixture.tpose, fixture.bent) }));
  source.close();
  const seen = [];
  await driver.drive(source, { onUpdate: (s) => seen.push(s.driven) });
  assert.ok(seen[0] > 0);
  const d = direction(sk, 'leftUpperArm', 'leftLowerArm');
  assert.ok(d[1] < 0 && d[1] > -0.999, `a smoothed step lands part way: ${d}`);
  // Without onUpdate the frames still pose the skeleton.
  const quiet = skeleton(),
    still = new BodyDriver(quiet, { smoothing: false }).calibrate(frame(0, { body: pose(fixture.tpose) })),
    replay = landmarkStream();
  replay.push(frame(33, { body: pose(fixture.tpose, fixture.bent) }));
  replay.close();
  await still.drive(replay);
  near(direction(quiet, 'leftUpperArm', 'leftLowerArm'), [0, -1, 0]);
  driver[Symbol.dispose]();
  assert.throws(() => driver.update(frame(66)), { code: 'disposed' });
  assert.throws(() => new BodyDriver(sk, { hold: -1 }), RangeError);
});

test('a skeleton whose parents are not a forest is refused before any walk', () => {
  const NAMES = ['hips', 'spine', 'leftUpperArm', 'leftLowerArm'];
  const rig = (parents, names = NAMES) => ({
    names,
    parents,
    getPose: () => ({ translation: [0.2, 0, 0], rotation: [0, 0, 0, 1] }),
    setPose() {},
  });
  const refused = { name: 'MargoError', code: 'state' };
  assert.throws(() => new BodyDriver(rig([-1, 0, 3, 2])), refused); // two-bone cycle
  assert.throws(() => new BodyDriver(rig([-1, 1, 1, 2])), refused); // self-parent
  assert.throws(() => new BodyDriver(rig([-1, 0, 7, 2])), refused); // out of range
  assert.throws(() => new BodyDriver(rig([-1, 0.5, 1, 2])), refused); // not an index
  assert.throws(() => new BodyDriver(rig([-1, 0, 1])), refused); // shorter than names
  // A valid rig still drives.
  const sk = skeleton(),
    driver = new BodyDriver(sk, { smoothing: false }).calibrate(frame(0, { body: pose(fixture.tpose) }));
  driver.update(frame(33, { body: pose(fixture.tpose, fixture.bent) }));
  near(direction(sk, 'leftUpperArm', 'leftLowerArm'), [0, -1, 0]);
});

test('a NaN or Infinity landmark leaves the bone as it was; a limit outside 0..pi is refused', () => {
  const sk = skeleton(),
    driver = new BodyDriver(sk).calibrate(frame(0, { body: pose(fixture.tpose) }));
  driver.update(frame(0, { body: pose(fixture.tpose, fixture.bent) }));
  const before = [...sk.rotations[sk.index('leftLowerArm')]];
  driver.update(frame(33, { body: pose(fixture.tpose, fixture.bent, { 15: [Number.NaN, 0, 0, 0.99] }) }));
  assert.deepEqual(sk.rotations[sk.index('leftLowerArm')], before);
  driver.update(
    frame(66, { body: pose(fixture.tpose, fixture.bent, { 15: [0.17, Number.POSITIVE_INFINITY, 0, 0.99] }) }),
  );
  assert.deepEqual(sk.rotations[sk.index('leftLowerArm')], before);
  for (const bad of [Number.NaN, -0.1, 4, Number.POSITIVE_INFINITY])
    assert.throws(() => new BodyDriver(skeleton(), { limits: { leftLowerArm: bad } }), RangeError);
});

test('calibrating on an empty frame says what frame to pass', () => {
  using driver = new BodyDriver(skeleton());
  assert.throws(() => driver.calibrate(frame(0)), {
    code: 'state',
    message: /; pass a frame with the person in view; see /,
  });
});
