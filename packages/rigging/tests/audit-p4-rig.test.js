// Audit p4 regressions for IK, rest frames, retarget and skin checks (R1 to R9).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { solveFABRIK, solvePoseIK } from '../dist/ik.js';
import { prepareRetarget, humanoidBones } from '../dist/retarget.js';
import { checkSkin, rigJoints, WeightMap } from '../dist/index.js';

const point = (points, i) => Array.from(points.subarray(i * 3, i * 3 + 3));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const quarterZ = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
/** 10 local numbers: translation, rotation, scale. */
const bone = (t = [0, 0, 0], r = [0, 0, 0, 1], s = [1, 1, 1]) => [...t, ...r, ...s];

/** World positions by explicit 4x4 matrices (glTF 2.0 3.5.3: M = M_parent T R S), independent of the package. */
function matrixPositions(parents, local) {
  const world = [];
  const compose = (l) => {
    const [x, y, z, w] = Array.from(local.slice(l + 3, l + 7)),
      r = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
      ];
    return [0, 1, 2]
      .map((row) => [...[0, 1, 2].map((c) => r[row][c] * local[l + 7 + c]), local[l + row]])
      .concat([[0, 0, 0, 1]]);
  };
  const mul = (a, b) => a.map((row) => [0, 1, 2, 3].map((c) => row.reduce((s, v, k) => s + v * b[k][c], 0)));
  const at = (b) => (world[b] ??= parents[b] < 0 ? compose(b * 10) : mul(at(parents[b]), compose(b * 10)));
  return parents.map((_, b) => [at(b)[0][3], at(b)[1][3], at(b)[2][3]]);
}

test('R1: a pole on the root-target line still bends a straight chain to the target', () => {
  const points = new Float64Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    result = solveFABRIK(points, [1.5, 0, 0], { pole: [5, 0, 0] });
  assert.ok(result.reached, `stopped ${result.distance} away`);
  assert.ok(Math.abs(distance(point(points, 0), point(points, 1)) - 1) < 1e-9);
  assert.ok(Math.abs(distance(point(points, 1), point(points, 2)) - 1) < 1e-9);
});

test('R3: a target inside the inner reach ends on its side, as near as the chain allows', () => {
  const points = new Float64Array([0, 0, 0, 1, 0, 0, 1, 3, 0]),
    result = solveFABRIK(points, [0.5, 0, 0]);
  assert.ok(distance(point(points, 2), [2, 0, 0]) < 1e-9, `end at ${point(points, 2)}`);
  assert.ok(Math.abs(result.distance - 1.5) < 1e-9);
  assert.ok(Math.abs(distance(point(points, 0), point(points, 1)) - 1) < 1e-9);
  assert.ok(Math.abs(distance(point(points, 1), point(points, 2)) - 3) < 1e-9);
  // The longest bone in the middle of three: it points at the target, the others fold back.
  const three = new Float64Array([0, 0, 0, 0, 1, 0, 0, 5, 0, 0, 6, 0]);
  solveFABRIK(three, [0, 0, 1]);
  assert.ok(distance(point(three, 3), [0, 0, 2]) < 1e-9, `end at ${point(three, 3)}`);
});

test('R4: rest positions compose full matrices under an uneven parent scale and a turned child', () => {
  const parents = [-1, 0, 1],
    rest = Float64Array.from([
      ...bone([0, 0, 0], undefined, [1, 2, 1]),
      ...bone([0, 0, 0], quarterZ),
      ...bone([1, 0, 0]),
    ]);
  const joints = rigJoints({ names: ['a', 'b', 'c'], parents, rest });
  assert.ok(distance(joints[2].position, [0, 2, 0]) < 1e-12, `c at ${joints[2].position}`);
  assert.ok(distance(joints[2].position, matrixPositions(parents, rest)[2]) < 1e-12);
});

test('R4: retarget rest alignment aims bones by their true world positions', () => {
  // A leg chain: rest alignment aims limbs (the trunk keeps its own layout), so the upper leg stands in for the bone.
  const names = ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes'],
    parents = [-1, 0, 1, 2, 3],
    up = Float64Array.from(
      [bone([0, 1, 0]), bone([0, 0.1, 0]), bone([0.1, 0.1, 0]), bone([0, 0.1, 0]), bone([0, 0.1, 0])].flat(),
    ),
    // The source's lower leg sits up and to the side of its upper leg, along (1, 1, 0). The target's hips stretch y by 2
    // and its upper leg turns a quarter about z, so its lower leg sits along (0, 2, 1) from it; a per-axis scale product
    // puts it along (0, 1, 1), and a turn found from that is stretched off the source's direction.
    skewed = Float64Array.from(
      [
        bone([0, 1, 0], undefined, [1, 2, 1]),
        bone([0, 0.1, 0], quarterZ),
        bone([0.1, 0, 0.1]),
        bone([0.1, 0, 0]),
        bone([0.1, 0, 0]),
      ].flat(),
    );
  const prepared = prepareRetarget(
      { names, parents, rest: up },
      { names, parents, rest: skewed },
      { from: 'humanoid', to: 'humanoid' },
    ),
    world = matrixPositions(parents, prepared.target.rest),
    aim = [0, 1, 2].map((c) => world[2][c] - world[1][c]),
    length = Math.hypot(...aim);
  assert.ok(
    Math.abs(aim[0] / length - Math.SQRT1_2) < 1e-9 && Math.abs(aim[1] / length - Math.SQRT1_2) < 1e-9,
    `upper leg aims along ${aim}`,
  );
});

test('R5: solvePoseIK reports the posed skeleton, not the FABRIK points, under an uneven scale', () => {
  const parents = [-1, 0, 1],
    local = Float64Array.from([...bone([0, 0, 0], undefined, [1, 3, 1]), ...bone([0, 1, 0]), ...bone([0, 1, 0])]),
    target = [1, 1, 0],
    result = solvePoseIK({ parents, local }, { joints: [0, 1, 2], target });
  const end = matrixPositions(parents, local)[2];
  assert.ok(Math.abs(result.distance - distance(end, target)) < 1e-9, `${result.distance} vs ${distance(end, target)}`);
  assert.equal(result.reached, distance(end, target) <= 1e-4);
});

test('R7: cyclic parents are refused instead of looping', () => {
  const local = Float64Array.from([...bone(), ...bone([0, 1, 0]), ...bone([0, 1, 0]), ...bone([0, 1, 0])]);
  // Bones 2 and 3 parent each other: their ancestors never reach a root.
  assert.throws(() => solvePoseIK({ parents: [-1, 0, 3, 2], local }, { joints: [2, 3], target: [0, 1, 0] }), /cycle/);
  const names = ['hips', 'spine', 'chest', 'head'],
    rest = Float64Array.from([...bone(), ...bone([0, 1, 0]), ...bone([0, 1, 0]), ...bone([0, 1, 0])]),
    good = { names, parents: [-1, 0, 1, 2], rest };
  assert.throws(
    () => prepareRetarget(good, { names, parents: [-1, 3, 1, 2], rest }, { from: 'humanoid', to: 'humanoid' }),
    /cycle/,
  );
});

test('R6: Roblox UpperTorso is the spine VRM 1.0 requires', () => {
  const bones = humanoidBones(['HumanoidRootPart', 'LowerTorso', 'UpperTorso', 'Head'], 'roblox');
  assert.equal(bones.get('spine'), 2);
  assert.equal(bones.get('chest'), undefined);
});

test('R2: out-of-range joints are faults at any weight, and a joint twice with weight is a fault', () => {
  const report = checkSkin({
    weights: { joints: [0, 9, 0, 0, 1, 1, 0, 0], weights: [1, 0, 0, 0, 0.5, 0.5, 0, 0], influences: 4 },
    jointCount: 2,
  });
  const by = Object.fromEntries(report.issues.map((issue) => [issue.code, issue]));
  assert.deepEqual(by['invalid-joint']?.vertices, [0]);
  assert.deepEqual(by['invalid-joint']?.bones, [9]);
  assert.deepEqual(by['duplicate-joint']?.vertices, [1]);
  assert.deepEqual(by['duplicate-joint']?.bones, [1]);
  // Padding slots (joint 0, weight 0) repeating a weighted joint are fine.
  assert.ok(checkSkin({ weights: { joints: [0, 0, 0, 0], weights: [1, 0, 0, 0], influences: 4 }, jointCount: 1 }).ok);
});

test('R8: a bone found degenerate by both checks counts once', () => {
  const joints = [
      { name: 'a', parent: -1, position: [0, 0, 0] },
      { name: 'b', parent: 0, position: [0, 0, 0] },
    ],
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    flat = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const report = checkSkin({
    weights: new WeightMap(1, 2, [1, 0]),
    joints,
    inverseBindMatrices: [...identity, ...flat],
  });
  assert.equal(report.issues[0].count, 1);
  assert.match(report.issues[0].message, /^1 bone\(s\) \(1\)/);
});

test('R9: repeated bone names, which glTF allows, are refused with a message that says why', () => {
  assert.throws(
    () => rigJoints({ names: ['a', 'a'], parents: [-1, 0], rest: Float64Array.from([...bone(), ...bone([0, 1, 0])]) }),
    /repeats the name a; glTF allows that/,
  );
});
