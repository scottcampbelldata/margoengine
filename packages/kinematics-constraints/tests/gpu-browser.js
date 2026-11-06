// Real GPU checks of @margoengine/kinematics-constraints/gpu, run by scripts/test-kinematics-constraints-gpu.js: every gap
// is compared with the f64 CPU answer of Robot.clearance.
//
// How near f32 can come, from what each step rounds (u = 2^-24, about 6e-8):
// - forward kinematics: each of n joints adds about 3u of a frame's size to the positions below it, so n * 3u * reach;
// - GJK ends when the new support gains less than 1e-6 d^2 + 4e-7 d E on d^2, with d the distance and E the size of the
//   difference, and that leaves |v| - d below 1e-6 d + 4e-7 E.
import { MeshBVH } from '../../bvh/dist/index.js';
import { bakeSDF } from '../../bvh/dist/sdf.js';
import { CapsuleVolume, ConvexHullVolume, SphereVolume } from '../dist/index.js';
import { GPUClearance } from '../dist/gpu.js';
import { Roadmap } from '../dist/plan.js';
import { Robot } from '../dist/robot.js';
import { SDFVolume } from '../dist/sdf.js';
import { loadURDF } from '../dist/urdf.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const U = 2 ** -24;
/** The most f32 can be off on a true distance `d`, for `joints` joints, a reach of `reach` and a difference of size `size`. */
function bound(d, joints, reach, size) {
  return joints * 3 * U * reach + 1e-6 * d + 4e-7 * size;
}

function generator(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** `count` poses inside the robot's ranges. */
function randomPoses(robot, count, seed) {
  const random = generator(seed),
    poses = new Float64Array(count * robot.dof);
  for (let i = 0; i < count; i++)
    for (let k = 0; k < robot.dof; k++) {
      const low = Math.max(robot.lower[k], -Math.PI),
        high = Math.min(robot.upper[k], Math.PI);
      poses[i * robot.dof + k] = low + (high - low) * random();
    }
  return poses;
}

/** Compares a batch with the CPU; returns the worst error beyond the bound's share, and how many read clear. */
function compare(label, robot, poses, gaps, colliders, selfCollision, allowed) {
  const n = robot.dof,
    count = poses.length / n;
  assert(gaps.length === count, `${label}: ${gaps.length} gaps for ${count} poses`);
  let worst = 0,
    clear = 0,
    overlaps = 0;
  for (let i = 0; i < count; i++) {
    const want = robot.clearance(poses.subarray(i * n, (i + 1) * n), colliders, selfCollision),
      got = gaps[i],
      limit = allowed(Math.abs(want));
    if (want > 0) {
      clear++;
      worst = Math.max(worst, Math.abs(got - want));
      assert(Math.abs(got - want) <= limit, `${label} pose ${i}: GPU ${got}, CPU ${want}, allowed ${limit}`);
    } else {
      // No expanding polytope on the GPU: an overlap reads zero or less, whatever its depth.
      overlaps++;
      assert(got <= limit, `${label} pose ${i}: GPU ${got} on an overlap of ${want}, allowed ${limit}`);
    }
  }
  assert(clear > 0 && overlaps > 0, `${label}: a batch must hold both kinds of pose, got ${clear} and ${overlaps}`);
  return { worst, clear, overlaps };
}

function box(min, max) {
  const points = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) points.push(x, y, z);
  return points;
}

/** Four joints of every kind and every shape kind, on a moved base. */
function mixedRobot() {
  const along = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
    tilt = 0.4,
    base = [Math.cos(tilt), Math.sin(tilt), 0, 0, -Math.sin(tilt), Math.cos(tilt), 0, 0, 0, 0, 1, 0, 0.1, -0.2, 0.3, 1];
  return new Robot({
    base,
    joints: [
      { name: 'turn', axis: [0, 0, 1], lower: -3, upper: 3 },
      { name: 'slide', type: 'prismatic', axis: [1, 0, 0], lower: -0.3, upper: 0.6, origin: along(0, 0, 0.4) },
      { name: 'bend', axis: [0, 1, 1], lower: -2, upper: 2, origin: along(0.5, 0, 0) },
      { name: 'copy', axis: [1, 0, 0], origin: along(0, 0, 0.5), mimic: { joint: 'bend', multiplier: -0.5, offset: 0.2 } },
      { name: 'grip', type: 'fixed', origin: along(0.3, 0, 0) },
    ],
    shapes: [
      { joint: null, end: [0, 0, 0.4], radius: 0.06 },
      { joint: 'turn', start: [0, 0, 0.4], radius: 0.09 },
      { joint: 'slide', points: box([0, -0.05, -0.05], [0.5, 0.05, 0.05]), matrix: along(0, 0, 0.02) },
      { joint: 'bend', start: [0, 0, 0], end: [0, 0, 0.5], radius: 0.04 },
      { joint: 'copy', points: box([-0.02, -0.08, -0.08], [0.3, 0.08, 0.08]) },
      { joint: 'grip', radius: 0.05 },
    ],
  });
}

function sphereMesh(segments, rings, radius) {
  const positions = [],
    indices = [];
  for (let r = 0; r <= rings; r++)
    for (let s = 0; s <= segments; s++) {
      const phi = (Math.PI * r) / rings,
        theta = (2 * Math.PI * (s % segments)) / segments;
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        -radius * Math.sin(phi) * Math.sin(theta),
      );
    }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s,
        b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return { positions, indices };
}

async function loadPanda() {
  const folder = '/packages/kinematics-constraints/tests/fixtures/panda/',
    home = 'https://robots.test/data/robots/panda_description/';
  return loadURDF(`${home}urdf/panda.urdf`, {
    packages: { 'example-robot-data': 'https://robots.test/data/' },
    fetch: (url) => fetch(folder + url.slice(home.length)),
  });
}

/** Runs every check and returns lines for the log. */
export async function gpuChecks() {
  const adapter = await navigator.gpu.requestAdapter();
  assert(adapter, 'no WebGPU adapter');
  const device = await adapter.requestDevice(),
    report = [`adapter: ${adapter.info?.description || adapter.info?.vendor || 'unknown'}`];
  device.pushErrorScope('validation');

  // Every joint kind, every shape kind and every collider kind.
  const mixed = mixedRobot(),
    colliders = [
      new SphereVolume({ center: [0.7, 0.2, 0.9], radius: 0.2 }),
      new CapsuleVolume({ start: [-0.6, -0.7, 0.2], end: [-0.5, 0.7, 1.1], radius: 0.07 }),
      new ConvexHullVolume({
        points: box([-0.2, 0.5, 0.2], [0.3, 0.9, 0.7]),
        matrix: [0.8, 0.6, 0, 0, -0.6, 0.8, 0, 0, 0, 0, 1, 0, 0.1, 0.05, 0.2, 1],
      }),
    ],
    poses = randomPoses(mixed, 4096, 85),
    gaps = await new GPUClearance(device, mixed, colliders).evaluate(poses);
  const first = compare('mixed', mixed, poses, gaps, colliders, false, (d) => bound(d, 4, 2, 3));
  report.push(`mixed: ${first.clear} clear, ${first.overlaps} overlapping, worst error ${first.worst.toExponential(2)}`);
  const selfGaps = await new GPUClearance(device, mixed, colliders, { selfCollision: true }).evaluate(poses),
    self = compare('mixed self', mixed, poses, selfGaps, colliders, true, (d) => bound(d, 4, 2, 3));
  report.push(`mixed with a self check: worst error ${self.worst.toExponential(2)}`);

  // Batches: split or whole, one answer, and the order is kept.
  const split = await new GPUClearance(device, mixed, colliders, { batch: 100 }).evaluate(poses);
  assert(
    split.every((gap, i) => gap === gaps[i]),
    'a split batch must read the same as a whole one',
  );

  // A pose stops at its first pair at or below minClearance: it still lands on the right side of it.
  const stop = 0.05,
    early = await new GPUClearance(device, mixed, colliders, { minClearance: stop }).evaluate(poses);
  let blocked = 0;
  gaps.forEach((gap, i) => {
    assert(gap <= stop === early[i] <= stop, `pose ${i}: full ${gap}, early ${early[i]}`);
    if (early[i] <= stop) {
      blocked++;
      assert(early[i] >= gap, `pose ${i}: early ${early[i]} below the smallest ${gap}`);
    } else assert(early[i] === gap, `pose ${i}: a pose that stays in reads its smallest gap`);
  });
  assert(blocked > 0 && blocked < gaps.length, 'minClearance must split the batch');
  // Stopping is what the option is for: some pose must read the first pair at or below the stop, above its smallest.
  assert(
    early.some((gap, i) => gap <= stop && gap > gaps[i]),
    'minClearance must stop at the first pair, not walk them all',
  );

  // Nothing to test reads Infinity, as on the CPU.
  const none = await new GPUClearance(device, mixed, []).evaluate(poses.subarray(0, mixed.dof * 3));
  assert(none.every((gap) => gap === Infinity), 'no collider must read Infinity');

  // A real arm: the Panda's hulls from its own STL files, with its self check.
  const { robot: panda, home } = await loadPanda(),
    post = new ConvexHullVolume({ points: box([0.2, -0.15, 0], [0.5, 0.15, 0.7]) }),
    ball = new SphereVolume({ center: [-0.2, 0.4, 0.5], radius: 0.15 }),
    scene = [post, ball];
  panda.ignoreContactsAt(home, 0.005);
  const armPoses = randomPoses(panda, 2048, 12),
    arm = new GPUClearance(device, panda, scene, { selfCollision: true }),
    armGaps = await arm.evaluate(armPoses);
  const real = compare('Panda', panda, armPoses, armGaps, scene, true, (d) => bound(d, 8, 1.2, 2.4));
  report.push(`Panda: ${real.clear} clear, ${real.overlaps} overlapping, worst error ${real.worst.toExponential(2)}`);

  // A baked field, read by the same branch and bound. CPU and GPU each stop within `precision` of the lowest reading.
  const field = bakeSDF(MeshBVH.build(sphereMesh(48, 32, 0.5)), { resolution: 40 }),
    volume = new SDFVolume({ field, matrix: [0.8, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0.8, 0, 0.8, 0.5, 0.8, 1], maxCells: 1 << 20 }),
    fieldPoses = randomPoses(mixed, 512, 7),
    fieldGaps = await new GPUClearance(device, mixed, [volume]).evaluate(fieldPoses),
    fieldCheck = compare('field', mixed, fieldPoses, fieldGaps, [volume], false, (d) => 2 * volume.precision + bound(d, 4, 2, 3));
  report.push(`field: ${fieldCheck.clear} clear, worst error ${fieldCheck.worst.toExponential(2)}, precision ${volume.precision.toFixed(4)}`);

  // The README's scene, as written there.
  const small = new Robot({
      joints: [{ lower: -3, upper: 3 }],
      shapes: [{ joint: 0, end: [1, 0, 0], radius: 0.05 }],
    }),
    wall = [new CapsuleVolume({ start: [0, 1, -1], end: [0, 1, 1], radius: 0.05 })];
  {
    using clearance = new GPUClearance(device, small, wall, { minClearance: 0.01 });
    const map = new Roadmap(small, { colliders: wall }),
      candidates = map.samplePoses(4096);
    map.addPoses(candidates, await clearance.evaluate(candidates));
    assert(map.size > 0 && map.size < 4096, `README roadmap has ${map.size} nodes`);
    assert(map.query([-1], [1]).status === 'found', 'README query');
  }

  // A field that is a plain function has no grid to upload.
  const plain = new SDFVolume({ field: { distance: () => 1 } });
  let refused = false;
  try {
    new GPUClearance(device, mixed, [plain]);
  } catch (error) {
    refused = /bake/.test(error.message);
  }
  assert(refused, 'a function field must be refused');

  // The planner path: sample a batch, sort it on the GPU, and the survivors build a roadmap that plans.
  const roadmap = new Roadmap(panda, { colliders: scene, selfCollision: true, seed: 3 }),
    candidates = roadmap.samplePoses(2000),
    sorted = await arm.evaluate(candidates);
  let open = 0;
  for (const gap of sorted) if (gap > 0.01) open++;
  roadmap.addPoses(candidates, sorted);
  assert(open > 0 && open < 2000, `the scene must block some poses, ${open} of 2000 clear`);
  assert(roadmap.size > 0 && roadmap.size <= open, `${roadmap.size} nodes of ${open} clear`);
  report.push(`roadmap: ${open} of 2000 candidates clear, ${roadmap.size} joined`);

  // Diagnostic only: other work shares this GPU.
  const timed = randomPoses(panda, 16384, 21),
    begun = performance.now();
  await arm.evaluate(timed);
  const gpuTime = performance.now() - begun,
    cpuBegun = performance.now();
  for (let i = 0; i < 1024; i++) panda.clearance(timed.subarray(i * panda.dof, (i + 1) * panda.dof), scene, true);
  const cpuTime = ((performance.now() - cpuBegun) / 1024) * 16384;
  report.push(`diagnostic: 16,384 Panda poses, GPU ${gpuTime.toFixed(0)} ms, CPU about ${cpuTime.toFixed(0)} ms`);

  // An abort stops a long run between dispatches, and a disposed object refuses.
  const stopper = new AbortController();
  stopper.abort();
  let stopped = false;
  await arm.evaluate(timed, { signal: stopper.signal }).catch((error) => {
    stopped = error.name === 'AbortError';
  });
  assert(stopped, 'an aborted evaluate must reject with the reason');
  arm.dispose();
  let gone = false;
  await arm.evaluate(timed).catch((error) => {
    gone = /disposed/.test(error.message);
  });
  assert(gone, 'a disposed GPUClearance must refuse');

  const failure = await device.popErrorScope();
  assert(!failure, `validation: ${failure?.message}`);
  device.destroy();
  return report;
}
