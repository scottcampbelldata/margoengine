// Cyclic Coordinate Descent IK (@margoengine/animator CCDSolver and addCCDChain): reachable targets within
// tolerance, unreachable targets stretched toward, joint limits respected, convergence counts, orientation and pole
// targets, parent frames, no allocation per solve, and chains on an animated skinned skeleton.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GCProfiler, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../packages/gltf-pro/dist/index.js';
import { Animation } from '../packages/animation/dist/index.js';
import { Animator, CCDSolver, addCCDChain } from '../packages/animator/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// A random unit quaternion turning by at most `angle` radians.
const randomRotation = (next, angle = Math.PI) => {
  const axis = [next() * 2 - 1, next() * 2 - 1, next() * 2 - 1],
    l = Math.hypot(...axis) || 1,
    a = (next() * 2 - 1) * angle,
    s = Math.sin(a / 2);
  return [(axis[0] / l) * s, (axis[1] / l) * s, (axis[2] / l) * s, Math.cos(a / 2)];
};
// One solve with the given settings (the solver keeps them as fields).
const solveWith = (solver, target, o = {}) => {
  solver.iterations = o.iterations ?? 16;
  solver.tolerance = o.tolerance ?? 1e-3;
  solver.angleTolerance = o.angleTolerance ?? 1e-3;
  solver.maxAngle = o.maxAngle ?? Math.PI;
  solver.reach = o.reach ?? true;
  return solver.solve(target, o.rotation ?? null, o.pole ?? null);
};
const effector = (solver) => Array.from(solver.positions.subarray(solver.joints * 3));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const identity = (solver) => {
  solver.rotations.fill(0);
  for (let i = 0; i < solver.joints; i++) solver.rotations[i * 4 + 3] = 1;
};
// conj(a) * b
const relative = (a, b) => {
  const [ax, ay, az, aw] = [-a[0], -a[1], -a[2], a[3]];
  return [
    aw * b[0] + ax * b[3] + ay * b[2] - az * b[1],
    aw * b[1] - ax * b[2] + ay * b[3] + az * b[0],
    aw * b[2] + ax * b[1] - ay * b[0] + az * b[3],
    aw * b[3] - ax * b[0] - ay * b[1] - az * b[2],
  ];
};
const joint = (solver, i, array = solver.rotations) => Array.from(array.subarray(i * 4, i * 4 + 4));
// A chain standing along +Y with one joint per bone: joint 0 at the origin, each bone ending at the next joint and the
// last one at the tip.
const chainOf = (lengths) =>
  new CCDSolver(
    lengths.map((l, i) => (i === 0 ? [0, 0, 0] : [0, lengths[i - 1], 0])),
    [0, lengths.at(-1), 0],
  );
const randomChain = (next, joints) => {
  const lengths = Array.from({ length: joints }, () => 0.3 + 0.7 * next());
  return { solver: chainOf(lengths), length: lengths.reduce((a, b) => a + b, 0) };
};
// A target the chain reaches in a random pose, at most `edge` of its full length from the root.
const reachable = (next, solver, length, edge = 0.95) => {
  let target;
  do {
    for (let i = 0; i < solver.joints; i++) solver.rotations.set(randomRotation(next), i * 4);
    solver.update();
    target = effector(solver);
  } while (Math.hypot(...target) > edge * length);
  identity(solver);
  return target;
};

test('CCD reaches reachable targets within tolerance and reports its convergence counts', () => {
  const next = random(1991),
    report = {};
  for (const joints of [2, 3, 4, 6, 8, 12]) {
    const counts = [];
    for (let trial = 0; trial < 60; trial++) {
      const { solver, length } = randomChain(next, joints),
        target = reachable(next, solver, length),
        result = solveWith(solver, target, { iterations: 200 });
      assert.ok(result.reached, `${joints} joints, trial ${trial}: ${result.distance} after ${result.iterations}`);
      assert.ok(result.distance <= 1e-3);
      assert.ok(distance(effector(solver), target) <= 1e-3, 'positions are the solved pose');
      counts.push(result.iterations);
    }
    counts.sort((a, b) => a - b);
    report[joints] = { median: counts[30], p90: counts[54], max: counts[59] };
  }
  console.log('CCD sweeps to 1 mm (60 random reachable targets per chain length):', JSON.stringify(report));
  // With the reach step a reachable target is met in one sweep, as a rule (measured: every median 1).
  for (const { median } of Object.values(report)) assert.ok(median <= 2, JSON.stringify(report));
});

test('CCD stretches the chain straight toward an unreachable target', () => {
  const next = random(7);
  for (let trial = 0; trial < 20; trial++) {
    const { solver, length } = randomChain(next, 2 + (trial % 5)),
      direction = randomRotation(next).slice(0, 3),
      l = Math.hypot(...direction),
      root = Array.from(solver.positions.subarray(0, 3)),
      target = direction.map((v, i) => root[i] + (v / l) * length * (1.5 + next()));
    const result = solveWith(solver, target, { iterations: 4 });
    assert.equal(result.reached, false);
    const end = effector(solver),
      toTarget = distance(target, root);
    assert.ok(Math.abs(distance(end, root) - length) < 1e-3 * length, 'fully extended');
    assert.ok(Math.abs(result.distance - (toTarget - length)) < 1e-3 * length, 'as close as the chain allows');
    // Every joint lies on the line from the root to the target.
    for (let j = 0; j <= solver.joints; j++) {
      const p = Array.from(solver.positions.subarray(j * 3, j * 3 + 3)),
        along = p.map((v, i) => v - root[i]),
        t = along.reduce((s, v, i) => s + v * (target[i] - root[i]), 0) / toTarget;
      assert.ok(
        distance(
          along,
          target.map((v, i) => ((v - root[i]) * t) / toTarget),
        ) <
          2e-3 * length,
      );
    }
  }
});

test('plain CCD never ends farther away with more sweeps, and tighter tolerances take it more sweeps', () => {
  const solver = chainOf([1, 1, 1]),
    target = [1.5, 1.2, 0.4],
    sweeps = [];
  for (let k = 0; k <= 12; k++) {
    identity(solver);
    sweeps.push(solveWith(solver, target, { iterations: k, tolerance: 0, reach: false }).distance);
  }
  for (let k = 1; k < sweeps.length; k++) assert.ok(sweeps[k] <= sweeps[k - 1] + 1e-12, `sweep ${k}: ${sweeps}`);
  identity(solver);
  const none = solveWith(solver, target, { iterations: 0 });
  assert.equal(none.iterations, 0);
  assert.equal(none.distance, sweeps[0], 'zero sweeps only measure');
  const counts = (reach) =>
    [1e-1, 1e-3, 1e-6].map((tolerance) => {
      identity(solver);
      const result = solveWith(solver, target, { tolerance, iterations: 500, reach });
      assert.ok(result.reached && result.distance <= tolerance);
      return result.iterations;
    });
  const plain = counts(false),
    reached = counts(true);
  assert.ok(plain[0] <= plain[1] && plain[1] <= plain[2] && plain[2] > plain[0], JSON.stringify(plain));
  assert.deepEqual(reached, [1, 1, 1], 'the reach step meets each tolerance in one sweep');
  console.log(
    'CCD sweeps for a 3-joint chain at 10 cm, 1 mm, 1 um: plain',
    JSON.stringify(plain),
    'reach step',
    JSON.stringify(reached),
  );
  // Already there: no sweep.
  const again = solveWith(solver, target, { tolerance: 1e-3 });
  assert.equal(again.iterations, 0);
  assert.equal(again.reached, true);
});

test('CCD hinge limits keep each joint turning about its axis within its range', () => {
  const next = random(3),
    solver = chainOf([1, 0.8, 0.6]);
  for (let i = 0; i < 3; i++)
    solver.setLimit(i, { type: 'hinge', axis: [0, 0, 1], min: i ? -2.4 : -Math.PI, max: i ? 0 : Math.PI });
  let reached = 0;
  for (let trial = 0; trial < 40; trial++) {
    const target = [next() * 4 - 2, next() * 4 - 2, 0];
    identity(solver);
    const result = solveWith(solver, target, { iterations: 64 });
    if (result.reached) reached++;
    for (let i = 0; i < 3; i++) {
      const q = joint(solver, i),
        angle = 2 * Math.atan2(q[2], q[3]);
      assert.ok(Math.hypot(q[0], q[1]) < 1e-9, 'turns about z only');
      if (i) assert.ok(angle >= -2.4 - 1e-9 && angle <= 1e-9, `joint ${i} at ${angle}`);
    }
    for (let j = 0; j <= 3; j++) assert.ok(Math.abs(solver.positions[j * 3 + 2]) < 1e-9, 'a planar arm stays planar');
  }
  assert.ok(reached >= 20, `in-plane targets reached: ${reached} of 40`);
  // Root held near upright and elbows bending only toward +x: a target on the -x side is missed, with the elbows
  // stopped at their limit.
  solver.setLimit(0, { type: 'hinge', axis: [0, 0, 1], min: -0.2, max: 0.2 });
  identity(solver);
  const result = solveWith(solver, [-1.5, 1, 0], { iterations: 64 });
  assert.equal(result.reached, false);
  for (let i = 0; i < 3; i++) {
    const angle = 2 * Math.atan2(solver.rotations[i * 4 + 2], solver.rotations[i * 4 + 3]);
    assert.ok(angle >= (i ? 0 : 0.2) - 1e-9, `joint ${i} at its limit: ${angle}`);
  }
});

test('CCD Euler and cone limits hold on every joint, and the solve still gets as close as they allow', () => {
  const next = random(11),
    min = [-0.3, -0.5, -1],
    max = [0.3, 0.5, 1],
    plainErrors = [],
    reachErrors = [];
  for (const kind of ['euler', 'cone']) {
    const solver = chainOf([1, 1, 1, 1]);
    for (let i = 0; i < 4; i++)
      solver.setLimit(
        i,
        kind === 'euler' ? { type: 'euler', min, max } : { type: 'cone', angle: 0.6, twist: [-0.2, 0.25] },
      );
    for (let trial = 0; trial < 30; trial++) {
      identity(solver);
      const target = [next() * 6 - 3, next() * 6 - 3, next() * 6 - 3],
        start = distance(effector(solver), target),
        limited = solveWith(solver, target, { iterations: 48 });
      assert.ok(limited.distance <= start + 1e-9, 'the limited solve still gets closer');
      const reached = limited.distance,
        rotations = solver.rotations.slice();
      identity(solver);
      plainErrors.push(solveWith(solver, target, { iterations: 48, reach: false }).distance);
      reachErrors.push(reached);
      solver.rotations.set(rotations);
      solver.update();
      for (let i = 0; i < 4; i++) {
        const [x, y, z, w] = relative(joint(solver, i, solver.rest), joint(solver, i));
        if (kind === 'euler') {
          const angles = [
            Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y)),
            Math.asin(Math.max(-1, Math.min(1, 2 * (x * z + w * y)))),
            Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z)),
          ];
          angles.forEach((a, k) => assert.ok(a >= min[k] - 1e-9 && a <= max[k] + 1e-9, `axis ${k}: ${a}`));
        } else {
          // Bone axis +Y: swing = angle between +Y and the rotated +Y; twist = rotation about +Y.
          const ry = 1 - 2 * (x * x + z * z),
            swing = Math.acos(Math.max(-1, Math.min(1, ry))),
            twist = Math.atan2(y, w) * 2,
            wrapped = twist > Math.PI ? twist - 2 * Math.PI : twist < -Math.PI ? twist + 2 * Math.PI : twist;
          assert.ok(swing <= 0.6 + 1e-9, `swing ${swing}`);
          assert.ok(wrapped >= -0.2 - 1e-9 && wrapped <= 0.25 + 1e-9, `twist ${wrapped}`);
        }
      }
    }
  }
  // Limits can undo a reach step (it is then dropped); over these targets it still ends no worse than plain CCD.
  const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
  console.log(
    'CCD with Euler/cone limits, median final distance: plain',
    median(plainErrors).toFixed(4),
    'reach step',
    median(reachErrors).toFixed(4),
  );
  assert.ok(median(reachErrors) <= median(plainErrors) + 1e-9);
});

test('limits are measured from the rest rotations, and joints start inside their limits', () => {
  const solver = chainOf([1, 1]),
    rest = [0, 0, Math.sin(0.4), Math.cos(0.4)];
  solver.rest.set(rest, 4);
  solver.setLimit(1, { type: 'euler', min: [0, 0, 0], max: [0, 0, 0] });
  solver.rotations.set([0, 0, Math.sin(-0.5), Math.cos(-0.5)], 4);
  solveWith(solver, [0, 2, 0], { iterations: 0 });
  assert.deepEqual(
    joint(solver, 1).map((v) => +v.toFixed(12)),
    rest.map((v) => +v.toFixed(12)),
    'a locked joint sits at its rest rotation',
  );
  solver.captureRest();
  assert.deepEqual(Array.from(solver.rest), Array.from(solver.rotations));
});

test('CCD meets an end-effector orientation target as well as its position', () => {
  const next = random(5);
  let total = 0;
  for (let trial = 0; trial < 40; trial++) {
    const solver = new CCDSolver([
        [0, 0, 0],
        [0, 1, 0],
        [0, 0.9, 0],
        [0, 0.7, 0],
      ]),
      lengths = 1 + 0.9 + 0.7;
    // A reachable pose within 95% of full reach (CCD converges slowly at the very edge; see the next test).
    do {
      for (let i = 0; i < 4; i++) solver.rotations.set(randomRotation(next, 1.2), i * 4);
      solver.update();
    } while (Math.hypot(...effector(solver)) > 0.95 * lengths);
    const target = effector(solver),
      rotation = joint(solver, 3, solver.worldRotations);
    identity(solver);
    const result = solveWith(solver, target, { rotation, iterations: 200 });
    assert.ok(result.reached, `trial ${trial}: ${result.distance} m, ${result.angle} rad`);
    assert.ok(result.angle <= 1e-3 && result.distance <= 1e-3);
    const end = joint(solver, 3, solver.worldRotations),
      dot = Math.abs(end.reduce((s, v, k) => s + v * rotation[k], 0));
    assert.ok(2 * Math.acos(Math.min(1, dot)) <= 1e-3);
    total += result.iterations;
  }
  console.log('CCD sweeps with an orientation target, mean of 40:', total / 40);
  assert.throws(() => new CCDSolver([[0, 0, 0]]).solve([0, 0, 0], [0, 0, 0, 0]), RangeError);
});

test('targets at the very edge of reach converge in one sweep with the reach step, where plain CCD stays short', () => {
  // Plain CCD (Wang and Chen's sweep alone) needs many small turns to straighten a chain; the reach step scales the
  // chain's bends to the target's distance instead.
  const next = random(23),
    plain = [],
    reach = [];
  for (let trial = 0; trial < 20; trial++) {
    const joints = [2, 3, 6, 12][trial % 4],
      { solver, length } = randomChain(next, joints),
      direction = randomRotation(next).slice(0, 3),
      l = Math.hypot(...direction),
      target = direction.map((v) => (v / l) * length * (trial % 2 ? 0.995 : 0.9999));
    let previous = Infinity;
    plain.push(
      [16, 64, 256].map((iterations) => {
        identity(solver);
        const { distance: error } = solveWith(solver, target, { iterations, tolerance: 0, reach: false });
        assert.ok(error <= previous + 1e-12, 'more plain sweeps never end farther away');
        previous = error;
        return error;
      }),
    );
    identity(solver);
    const result = solveWith(solver, target, { iterations: 16 });
    assert.ok(
      result.reached && result.iterations === 1,
      `${joints} joints: ${result.distance} after ${result.iterations}`,
    );
    identity(solver);
    reach.push(solveWith(solver, target, { iterations: 16, tolerance: 0 }).distance);
  }
  const median = (values) => [...values].sort((a, b) => a - b)[10];
  console.log(
    'CCD at 99.5-99.99% of full reach (2-12 joints, chains about 1-8 m), median error: plain after 16 / 64 / 256 sweeps',
    [0, 1, 2].map((k) => median(plain.map((r) => r[k])).toExponential(2)).join(' / '),
    'm; with the reach step after 16',
    median(reach).toExponential(2),
    'm',
  );
  assert.ok(reach.every((error) => error < 1e-9));
  assert.ok(median(plain.map((r) => r[0])) > 1e-3, 'plain CCD is still short after 16 sweeps');
});

test('a pole decides which way the chain bends without moving the reached effector', () => {
  for (const side of [1, -1]) {
    // Shoulder, elbow, wrist (tip at the wrist): the elbow is the bend point.
    const arm = new CCDSolver([
      [0, 0, 0],
      [0, 1, 0],
      [0, 1, 0],
    ]);
    const result = solveWith(arm, [1.2, 0.8, 0], { pole: [0.5, 1, 2 * side], iterations: 64 });
    assert.ok(result.reached);
    assert.ok(Math.sign(arm.positions[5]) === side && Math.abs(arm.positions[5]) > 0.3, `elbow z ${arm.positions[5]}`);
  }
});

test('the parent frame (a bone matrix with rotation and uniform scale) carries the chain into world space', () => {
  const solver = chainOf([1, 1, 0.5]),
    angle = 0.7,
    scale = 2,
    c = Math.cos(angle) * scale,
    s = Math.sin(angle) * scale;
  // Column-major: rotation about z by 0.7, scale 2, translation (3, -1, 0.5).
  solver.setParentMatrix([c, s, 0, 0, -s, c, 0, 0, 0, 0, scale, 0, 3, -1, 0.5, 1]);
  assert.ok(Math.abs(solver.parentScale[0] - scale) < 1e-12);
  assert.ok(Math.abs(solver.parentRotation[2] - Math.sin(angle / 2)) < 1e-12);
  solver.update();
  assert.deepEqual(Array.from(solver.positions.subarray(0, 3)), [3, -1, 0.5]);
  // Fully straight the chain spans 2 * (1 + 1 + 0.5) = 5 world units.
  assert.ok(Math.abs(distance(effector(solver), [3, -1, 0.5]) - 5) < 1e-12);
  const result = solver.solve([4, 1, 1.5]);
  assert.ok(result.reached);
  assert.throws(() => solver.setParentMatrix([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), RangeError);
  assert.throws(() => solver.setParentMatrix([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), RangeError);
});

test('CCD validates its inputs with typed errors that name the fix', () => {
  assert.throws(() => new CCDSolver([]), RangeError);
  assert.throws(() => new CCDSolver([[0, NaN, 0]]), TypeError);
  assert.throws(() => new CCDSolver([[0, 0, 0]], [0, 1]), TypeError);
  const solver = chainOf([1, 1]);
  assert.throws(() => solver.solve([0, Infinity, 0]), /target must be 3 finite numbers/);
  assert.throws(() => solveWith(solver, [0, 1, 0], { iterations: 1.5 }), RangeError);
  assert.throws(() => solveWith(solver, [0, 1, 0], { tolerance: -1 }), RangeError);
  assert.throws(() => solveWith(solver, [0, 1, 0], { maxAngle: 0 }), RangeError);
  assert.throws(() => solveWith(solver, [0, 1, 0], { pole: [0, 1] }), TypeError);
  assert.throws(() => solver.setLimit(2, null), RangeError);
  assert.throws(() => solver.setLimit(0, { type: 'hinge', axis: [0, 0, 0] }), TypeError);
  assert.throws(() => solver.setLimit(0, { type: 'hinge', axis: [0, 0, 1], min: 1, max: 0 }), RangeError);
  assert.throws(() => solver.setLimit(0, { type: 'euler', min: [0, 0, 0], max: [0, 0, 4] }), RangeError);
  assert.throws(() => solver.setLimit(0, { type: 'cone', angle: 4 }), RangeError);
  assert.throws(() => solver.setLimit(0, { type: 'cone', angle: 1, twist: [1, -1] }), RangeError);
  assert.throws(() => solver.setLimit(0, { type: 'ball' }), TypeError);
  solver.iterations = 2.5;
  assert.throws(() => solver.solve([0, 1, 0]), /iterations must be an integer/);
  solver.iterations = 16;
  solver.reach = 'yes';
  assert.throws(() => solver.solve([0, 1, 0]), /reach must be a boolean/);
  solver.reach = true;
  solver.scales[1] = 0;
  assert.throws(() => solver.solve([0, 1, 0]), /scale must be finite and > 0/);
});

test('CCD solves allocate nothing', () => {
  const next = random(17),
    { solver } = randomChain(next, 6),
    targets = Array.from({ length: 64 }, () => [next() * 3 - 1.5, next() * 3, next() * 3 - 1.5]),
    rotation = [0, 0, 0, 1],
    pole = [0, 1, 2];
  solver.iterations = 24;
  solver.maxAngle = 0.5;
  solver.setLimit(2, { type: 'hinge', axis: [1, 0, 0], min: -2, max: 0.2 });
  solver.setLimit(3, { type: 'cone', angle: 0.8, twist: [-0.3, 0.3] });
  solver.setLimit(4, { type: 'euler', min: [-1, -1, -1], max: [1, 1, 1] });
  for (let i = 0; i < 10000; i++) solver.solve(targets[i & 63], rotation, pole);
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc'),
    windows = [];
  // Each window starts from an empty young generation: a solve that allocates even 16 bytes grows the heap by 320 KB
  // over 20,000 solves (or collects). The optimizing compiler can still be finishing in a busy test run, so a window
  // may see its allocations; the solver passes when one of five windows is clean.
  for (let attempt = 0; attempt < 5; attempt++) {
    gc();
    const profiler = new GCProfiler(),
      before = process.memoryUsage().heapUsed;
    profiler.start();
    for (let i = 0; i < 20000; i++) solver.solve(targets[i & 63], rotation, pole);
    const { statistics } = profiler.stop(),
      grown = process.memoryUsage().heapUsed - before;
    windows.push({ collections: statistics.length, grown });
    if (statistics.length === 0 && grown < 64 * 1024) return;
  }
  assert.fail(`every window of 20,000 solves allocated: ${JSON.stringify(windows)}`);
});

// A skinned chain on the animatedTriangle fixture: Joint (node 1) -> Upper -> Lower -> Hand, with a Wave clip turning
// Upper about z, so every frame's pose is animated before the chain overrides it.
function skeleton() {
  const result = animatedTriangle(),
    { doc, buffers } = result;
  const add = (values, type) => {
    const data = new Float32Array(values);
    buffers.push(data);
    doc.buffers.push({ byteLength: data.byteLength });
    doc.bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
    doc.accessors.push({
      bufferView: doc.bufferViews.length - 1,
      componentType: 5126,
      count: data.length / { SCALAR: 1, VEC4: 4 }[type],
      type,
    });
    return doc.accessors.length - 1;
  };
  doc.nodes[1].children = [2];
  doc.nodes.push(
    { name: 'Upper', translation: [0, 0.2, 0], children: [3] },
    { name: 'Lower', translation: [0, 1, 0], children: [4] },
    { name: 'Hand', translation: [0, 1, 0] },
  );
  doc.skins[0].joints = [1, 2, 3, 4];
  doc.animations.push({
    name: 'Wave',
    channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }],
    samplers: [
      {
        input: add([0, 1], 'SCALAR'),
        output: add([0, 0, 0, 1, 0, 0, Math.sin(0.3), Math.cos(0.3)], 'VEC4'),
        interpolation: 'LINEAR',
      },
    ],
  });
  return result;
}
async function animated(options = {}) {
  const store = await TransformStore.create(16),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    f = skeleton(),
    model = new PBRModel(engine, new GLTFAsset(f.doc, f.buffers)),
    animation = new Animation(model),
    animator = new Animator(animation, { initial: 'wave', states: { wave: 'Wave' }, ...options });
  // CPU fixture: satisfy the attachment registry without executing GPU deformation.
  engine.use({ name: animation.name, setup() {} });
  engine.use(animator);
  const world = (node) => {
    store.tick(false);
    return Array.from(model.nodes[node].matrix.subarray(12, 15));
  };
  return {
    store,
    engine,
    model,
    animator,
    world,
    release() {
      animator.dispose();
      animation.dispose();
      model.dispose();
      engine.dispose();
    },
  };
}

test('Animator CCD chains reach a moving target on an animated skinned skeleton every frame', async (t) => {
  const f = await animated();
  t.after(() => f.release());
  f.model.root.setPosition([1, 0.5, -2]);
  f.model.root.setScale([1.5, 1.5, 1.5]);
  f.model.root.setRotation([0, 0.6, 0]);
  f.animator.onPreUpdate(0.25);
  const animatedHand = f.world(4),
    results = [];
  const chain = {
    joints: [2, 3, 4],
    target: [2.2, 2.9, -1.4],
    tip: [0, 0.3, 0],
    onSolve: (result) => results.push({ ...result }),
  };
  const remove = addCCDChain(f.animator, chain);
  for (let frame = 0; frame < 30; frame++) {
    chain.target[0] = 2.2 + 0.3 * Math.sin(frame / 5);
    f.animator.onPreUpdate(1 / 60);
    // The tip is 0.3 along the hand's local +Y, scaled by the model's 1.5.
    f.store.tick(false);
    const m = f.model.nodes[4].matrix,
      tip = [0, 1, 2].map((k) => m[12 + k] + m[4 + k] * 0.3);
    assert.ok(distance(tip, chain.target) <= 1.5e-3, `frame ${frame}: ${distance(tip, chain.target)}`);
    assert.equal(results.at(-1).reached, true);
  }
  assert.equal(results.length, 30, 'onSolve once per frame');
  assert.ok(distance(animatedHand, chain.target) > 0.5, 'the chain moved the hand');
  remove();
  f.animator.onPreUpdate(0);
  // Back to the Wave clip at 0.75 s: Upper turned 0.45 rad about z.
  const store = f.store.transforms,
    upper = f.model.nodes[2].id;
  assert.deepEqual(
    [store.qx[upper], store.qy[upper], store.qz[upper], store.qw[upper]].map((v) => +v.toFixed(5)),
    [0, 0, Math.sin(0.225), Math.cos(0.225)].map((v) => +v.toFixed(5)),
    'removing the chain hands the pose back to the animation',
  );
});

test('Animator CCD chains blend by weight, respect rest-relative limits and commit through writeRotation', async (t) => {
  const written = [];
  const f = await animated({
    writeRotation(node, q) {
      written.push(node);
      node.setQuaternion(q);
    },
  });
  t.after(() => f.release());
  f.animator.onPreUpdate(0.5);
  const posed = f.world(4),
    target = [1.1, 1.4, 0.3];
  const chain = {
    joints: [2, 3, 4],
    target,
    weight: 1,
    limits: [null, { type: 'hinge', axis: [0, 0, 1], min: 0, max: 0 }],
  };
  addCCDChain(f.animator, chain);
  written.length = 0;
  f.animator.onPreUpdate(0);
  const solved = f.world(4),
    lower = f.model.nodes[3],
    t3 = f.store.transforms;
  assert.ok(written.includes(f.model.nodes[2]) && written.includes(lower), 'chain rotations pass through the writer');
  // Lower's rest rotation is identity and its hinge range is [0, 0]: it stays locked.
  assert.deepEqual(
    [t3.qx[lower.id], t3.qy[lower.id], t3.qz[lower.id], t3.qw[lower.id]].map((v) => Math.abs(+v.toFixed(6))),
    [0, 0, 0, 1],
  );
  // A straight 2-unit arm from Upper reaches the target when it lies within reach.
  assert.ok(distance(solved, target) < 1e-3 || Math.abs(distance(solved, f.world(2)) - 2) < 1e-3);
  chain.weight = 0.5;
  f.animator.onPreUpdate(0);
  const half = f.world(4);
  assert.ok(distance(half, target) < distance(posed, target), 'half weight moves toward the target');
  assert.ok(distance(half, solved) > 1e-3, 'but not all the way');
  chain.weight = 0;
  f.animator.onPreUpdate(0);
  assert.ok(distance(f.world(4), posed) < 1e-6, 'zero weight leaves the animated pose');
  chain.weight = 2;
  assert.throws(() => f.animator.onPreUpdate(0), /weight must be from 0 to 1/);
});

test('addCCDChain validates the chain before it reaches the frame loop', async (t) => {
  const f = await animated();
  t.after(() => f.release());
  assert.throws(() => addCCDChain(f.animator, { joints: [], target: [0, 0, 0] }), TypeError);
  assert.throws(() => addCCDChain(f.animator, { joints: [2, 4], target: [0, 0, 0] }), /child of the joint before/);
  assert.throws(() => addCCDChain(f.animator, { joints: [2, 99], target: [0, 0, 0] }), TypeError);
  assert.throws(() => addCCDChain(f.animator, { joints: [2, 3], target: [0, NaN, 0] }), /target/);
  assert.throws(() => addCCDChain(f.animator, { joints: [2, 3], target: [0, 1, 0], weight: -1 }), RangeError);
  assert.throws(
    () => addCCDChain(f.animator, { joints: [2, 3], target: [0, 1, 0], limits: [null, null, null] }),
    /one entry per joint/,
  );
  assert.throws(
    () => addCCDChain(f.animator, { joints: [2, 3], target: [0, 1, 0], limits: [{ type: 'cone', angle: 9 }] }),
    RangeError,
  );
  f.animator.dispose();
  assert.throws(
    () => addCCDChain(f.animator, { joints: [2, 3], target: [0, 1, 0] }),
    (error) => error.name === 'MargoError' && error.code === 'disposed',
  );
});
