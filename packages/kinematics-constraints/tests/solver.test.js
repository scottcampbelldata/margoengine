import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AvoidanceSolver, CapsuleVolume, SphereVolume, SolveStatus, measureSegmentClearance } from '../dist/index.js';

const EPS = 5e-5;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const near = (actual, expected, tolerance = EPS) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
const surface = new Float32Array(3);
const normal = new Float32Array(3);

// Standalone analytical two-link IK callback, independent of any engine package.
// Its zero-angle bend is in the world +Y direction for an X-aligned reach.
function twoBoneIK(upper, lower) {
  return (root, target, angle, out) => {
    const dx = target[0] - root[0], dy = target[1] - root[1], dz = target[2] - root[2];
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-10) {
      out[0] = root[0]; out[1] = root[1] + upper; out[2] = root[2];
      return;
    }
    const x = dx / length, y = dy / length, z = dz / length;
    let px = -x * y, py = 1 - y * y, pz = -z * y;
    let pLength = Math.hypot(px, py, pz);
    if (pLength < 1e-8) { px = 1; py = 0; pz = 0; pLength = 1; }
    px /= pLength; py /= pLength; pz /= pLength;
    const qx = y * pz - z * py, qy = z * px - x * pz, qz = x * py - y * px;
    const along = (upper * upper - lower * lower + length * length) / (2 * length);
    const height = Math.sqrt(Math.max(0, upper * upper - along * along));
    const c = Math.cos(angle), s = Math.sin(angle);
    out[0] = root[0] + x * along + height * (c * px + s * qx);
    out[1] = root[1] + y * along + height * (c * py + s * qy);
    out[2] = root[2] + z * along + height * (c * pz + s * qz);
  };
}

function assertTargetClear(target, volumes, clearance, radius = 0) {
  for (const volume of volumes) assert.ok(volume.evaluate(target, surface, normal) - radius >= clearance - EPS);
}

// Independent bounded minimization, used to audit complete solved links without
// calling the package's segment or volume distance routines.
function referenceSegmentDistance(a, b, c, d) {
  const u = b.map((x, i) => x - a[i]), v = d.map((x, i) => x - c[i]), w = a.map((x, i) => x - c[i]);
  const dot = (x, y) => x.reduce((sum, value, i) => sum + value * y[i], 0);
  const uu = dot(u, u), vv = dot(v, v), uv = dot(u, v), uw = dot(u, w), vw = dot(v, w);
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const candidates = [[0, vv ? clamp(vw / vv) : 0], [1, vv ? clamp((vw + uv) / vv) : 0],
    [uu ? clamp(-uw / uu) : 0, 0], [uu ? clamp((uv - uw) / uu) : 0, 1]];
  const denominator = uu * vv - uv * uv;
  if (denominator > 1e-14) {
    const s = (uv * vw - vv * uw) / denominator, t = (uu * vw - uv * uw) / denominator;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) candidates.push([s, t]);
  }
  return Math.min(...candidates.map(([s, t]) => Math.hypot(...w.map((x, i) => x + s * u[i] - t * v[i]))));
}

function referenceLinkGap(start, end, radius, volume) {
  const a = [...start], b = [...end];
  const c = volume instanceof SphereVolume ? volume.center : volume.start;
  const d = volume instanceof SphereVolume ? volume.center : volume.end;
  return referenceSegmentDistance(a, b, [...c], [...d]) - volume.radius - radius;
}

test('target-only projection escapes a sphere center and capsule centerline', () => {
  for (const volume of [
    new SphereVolume({ center: [0, 0, 0], radius: 0.5 }),
    new CapsuleVolume({ start: [0, -1, 0], end: [0, 1, 0], radius: 0.5 }),
  ]) {
    const solver = new AvoidanceSolver([volume], { minClearance: 0.03, targetRadius: 0.04 });
    const target = solver.resolveTarget([0, 0, 0], 1 / 60);
    assert.ok(solver.targetResult.resolved);
    assertTargetClear(target, [volume], 0.03, 0.04);
    assert.ok([...target].every(Number.isFinite));
  }
});

test('hard target clearance is enforced after temporal damping crosses an obstacle', () => {
  const sphere = new SphereVolume({ center: [0, 0, 0], radius: 1 });
  const solver = new AvoidanceSolver([sphere], { damping: 0.15, minClearance: 0.025 });
  solver.resolveTarget([-2, 0, 0], 0.15);
  const target = solver.resolveTarget([2, 0, 0], 0.15);
  assert.ok(solver.targetResult.resolved);
  assertTargetClear(target, [sphere], 0.025);
  assert.ok(Math.abs(target[0] - 2) > 1e-3, 'damping should still affect a sudden target change');
});

test('reset clears target damping history', () => {
  const solver = new AvoidanceSolver([], { damping: 1 });
  solver.resolveTarget([-2, 0, 0], 1 / 60);
  solver.resolveTarget([2, 0, 0], 1 / 60);
  solver.reset();
  const target = solver.resolveTarget([2, 0, 0], 1 / 60);
  near(target[0], 2);
});

test('overlapping volumes are jointly verified after projection', () => {
  const volumes = [
    new SphereVolume({ center: [-0.4, 0, 0], radius: 0.8 }),
    new SphereVolume({ center: [0.4, 0, 0], radius: 0.8 }),
    new CapsuleVolume({ start: [0, -0.4, 0], end: [0, 0.4, 0], radius: 0.7 }),
  ];
  const solver = new AvoidanceSolver({ colliders: volumes, minClearance: 0.04, maxIterations: 64 });
  for (const raw of [[0, 0, 0], [0.3, 0, 0], [-0.3, 0.1, 0]]) {
    const target = solver.resolveTarget(raw, 1 / 60);
    if (solver.targetResult.resolved) assertTargetClear(target, volumes, 0.04);
    else assert.ok(solver.targetResult.clearance < 0.04 + EPS, 'unresolved status should report remaining target clearance');
  }
});

test('iteration exhaustion cannot report a target resolved after re-entering another volume', () => {
  const volumes = [
    new SphereVolume({ center: [-0.3, 0, 0], radius: 1 }),
    new SphereVolume({ center: [0.3, 0, 0], radius: 1 }),
  ];
  const solver = new AvoidanceSolver(volumes, { minClearance: 0.02, maxIterations: 1 });
  const target = solver.resolveTarget([0, 0, 0], 1 / 60);
  const actual = Math.min(...volumes.map((volume) => volume.evaluate(target, surface, normal)));
  assert.equal(solver.targetResult.resolved, actual >= 0.02 - 1e-6);
});

test('solve reports valid collision-free lengths within operational reach', () => {
  const solver = new AvoidanceSolver();
  const root = [0, 0, 0], upper = 1.2, lower = 0.5;
  const evaluate = twoBoneIK(upper, lower);
  for (const raw of [[1, 0.2, 0.1], [0.8, 0.1, 0.2]]) {
    const result = solver.solve(root, [1, 0, 0], raw, upper, lower, 0.02, 0.02, 1 / 60, evaluate);
    assert.ok(result.resolved);
    assert.equal(result.status, SolveStatus.Success);
    assert.ok(result.targetResolved);
    assert.ok(distance(root, result.target) <= upper + lower + EPS);
    assert.ok(distance(root, result.target) >= Math.abs(upper - lower) - EPS);
    near(distance(root, result.elbow), upper);
    near(distance(result.elbow, result.target), lower);
  }
});

test('extension and folding singularity bands clamp the target and report SingularDeadZone', () => {
  const root = [0, 0, 0], upper = 1.2, lower = 0.5;
  for (const raw of [[10, 0, 0], [0.01, 0, 0], [upper + lower, 0, 0], [upper - lower, 0, 0]]) {
    const solver = new AvoidanceSolver();
    const result = solver.solve(root, [1, 0, 0], raw, upper, lower, 0.02, 0.02, 1 / 60, twoBoneIK(upper, lower),
      { reachMargin: 0.01, foldMargin: 0.02 });
    assert.equal(result.status, SolveStatus.SingularDeadZone);
    assert.equal(result.resolved, false);
    assert.ok(distance(root, result.target) <= upper + lower - 0.01 + EPS);
    assert.ok(distance(root, result.target) >= Math.abs(upper - lower) + 0.02 - EPS);
    near(distance(root, result.elbow), upper);
    near(distance(result.elbow, result.target), lower);
    assert.ok(Number.isFinite(result.poleAngle));
  }
});

test('reach clamping cannot silently put the final target back inside an obstacle', () => {
  const sphere = new SphereVolume({ center: [1.95, 0, 0], radius: 0.5 });
  const solver = new AvoidanceSolver([sphere], { minClearance: 0.03 });
  const result = solver.solve([0, 0, 0], [0, 2, 0], [10, 0, 0], 1, 1, 0.02, 0.02, 1 / 60, twoBoneIK(1, 1));
  assert.ok(distance([0, 0, 0], result.target) <= 2 + EPS);
  const actual = sphere.evaluate(result.target, surface, normal);
  if (actual < 0.03 - EPS) {
    assert.equal(result.targetResolved, false);
    assert.equal(result.resolved, false);
  }
  if (result.resolved) assertTargetClear(result.target, [sphere], 0.03);
});

test('an obstacle enclosing the entire reachable workspace reports unresolved', () => {
  const sphere = new SphereVolume({ center: [0, 0, 0], radius: 3 });
  const solver = new AvoidanceSolver([sphere]);
  const result = solver.solve([0, 0, 0], [1, 0, 0], [1.5, 0, 0], 1, 1, 0.03, 0.03, 1 / 60, twoBoneIK(1, 1));
  assert.equal(result.resolved, false);
  assert.equal(result.targetResolved, false);
  assert.ok([...result.target, ...result.elbow].every(Number.isFinite));
  assert.ok(distance([0, 0, 0], result.target) <= 2 + EPS);
});

test('a clear elbow with a colliding forearm triggers swivel and validates the entire link', () => {
  const sphere = new SphereVolume({ center: [0.5, 0.5, 0], radius: 0.15 });
  const root = [-1, 0, 0], target = [1, 0, 0], length = Math.SQRT2;
  const evaluate = twoBoneIK(length, length);
  const initialElbow = new Float32Array(3);
  evaluate(root, target, 0, initialElbow);
  assert.ok(sphere.evaluate(initialElbow, surface, normal) > 0.04);
  assert.ok(measureSegmentClearance(initialElbow, target, 0.04, sphere) < 0);
  const solver = new AvoidanceSolver([sphere], { minClearance: 0.025 });
  const result = solver.solve(root, target, target, length, length, 0.04, 0.04, 1 / 60, evaluate);
  assert.ok(result.resolved);
  assert.ok(Math.abs(result.poleAngleOffset) > 1e-5);
  assert.ok(measureSegmentClearance(result.elbow, result.target, 0.04, sphere) >= 0.025 - EPS);
  assert.ok(measureSegmentClearance(root, result.elbow, 0.04, sphere) >= 0.025 - EPS);
  near(distance(root, result.elbow), length);
  near(distance(result.elbow, result.target), length);
});

test('a trapped proximal segment cannot report resolved merely because its elbow is clear', () => {
  const sphere = new SphereVolume({ center: [0, 0, 0], radius: 0.25 });
  const solver = new AvoidanceSolver([sphere], { minClearance: 0.02 });
  const result = solver.solve([0, 0, 0], [2, 0, 0], [2, 0, 0], 1.5, 1.5, 0.03, 0.03, 1 / 60, twoBoneIK(1.5, 1.5));
  assert.ok(result.targetResolved);
  assert.ok(sphere.evaluate(result.elbow, surface, normal) > 0);
  assert.equal(result.resolved, false);
});

test('explicit proximal exclusion and omission allow an attached root inside its own proxy', () => {
  const sphere = new SphereVolume({ center: [0, 0, 0], radius: 0.25 });
  for (const options of [{ rootExclusion: 0.4 }, { upperArmRadius: null }]) {
    const solver = new AvoidanceSolver([sphere], { minClearance: 0.02, ...options });
    const result = solver.solve([0, 0, 0], [2, 0, 0], [2, 0, 0], 1.5, 1.5, 0.03, 0.03, 1 / 60, twoBoneIK(1.5, 1.5));
    assert.ok(result.resolved);
    assert.ok(measureSegmentClearance(result.elbow, result.target, 0.03, sphere) >= 0.02 - EPS);
  }
});

test('solve verifies callback link lengths instead of accepting an arbitrary clear elbow', () => {
  const solver = new AvoidanceSolver();
  const result = solver.solve([0, 0, 0], [1, 0, 0], [1, 0, 0], 1, 1, 0.02, 0.02, 1 / 60,
    (_root, _target, _angle, out) => { out[0] = 100; out[1] = 100; out[2] = 100; });
  assert.equal(result.resolved, false);
});

test('pole-only correction preserves both link lengths and avoids a colliding forearm', () => {
  const root = [-1, 0, 0], elbow = [0, 1, 0], end = [1, 0, 0];
  const sphere = new SphereVolume({ center: [0.5, 0.5, 0], radius: 0.15 });
  const solver = new AvoidanceSolver([sphere], { minClearance: 0.025 });
  const result = solver.calculatePoleClearance(root, elbow, end, 0.04);
  assert.ok(result.resolved);
  near(distance(root, result.elbow), distance(root, elbow));
  near(distance(end, result.elbow), distance(end, elbow));
  assert.ok(measureSegmentClearance(result.elbow, end, 0.04, sphere) >= 0.025 - EPS);
  assert.ok([...result.pole].every(Number.isFinite));
});

test('pole-only correction reports a fully trapped swivel circle unresolved', () => {
  const sphere = new SphereVolume({ center: [0, 0, 0], radius: 1.1 });
  const solver = new AvoidanceSolver([sphere]);
  const result = solver.calculatePoleClearance([-1, 0, 0], [0, 1, 0], [1, 0, 0], 0.02);
  assert.equal(result.resolved, false);
  near(distance([-1, 0, 0], result.elbow), Math.SQRT2);
  near(distance([1, 0, 0], result.elbow), Math.SQRT2);
});

test('public hot-path outputs retain object and vector identity across calls', () => {
  const solver = new AvoidanceSolver();
  const evaluate = twoBoneIK(1, 1);
  const result = solver.solve([0, 0, 0], [1, 0, 0], [1, 0, 0], 1, 1, 0.02, 0.02, 1 / 60, evaluate);
  const target = result.target, elbow = result.elbow;
  assert.equal(solver.solve([0, 0, 0], [1, 0, 0], [0.8, 0.2, 0], 1, 1, 0.02, 0.02, 1 / 60, evaluate), result);
  assert.equal(result.target, target);
  assert.equal(result.elbow, elbow);
  const targetOutput = solver.resolveTarget([2, 0, 0], 1 / 60);
  const targetResult = solver.targetResult;
  assert.equal(solver.resolveTarget([3, 0, 0], 1 / 60), targetOutput);
  assert.equal(solver.targetResult, targetResult);
  const poleResult = solver.calculatePoleClearance([-1, 0, 0], [0, 1, 0], [1, 0, 0], 0.02);
  const poleElbow = poleResult.elbow, pole = poleResult.pole;
  assert.equal(solver.calculatePoleClearance([-1, 0, 0], [0, 0, 1], [1, 0, 0], 0.02), poleResult);
  assert.equal(poleResult.elbow, poleElbow);
  assert.equal(poleResult.pole, pole);
});

test('SolveStatus exposes stable machine-readable values', () => {
  assert.equal(SolveStatus.Success, 0);
  assert.equal(SolveStatus.SwivelRateLimitExceeded, 1);
  assert.equal(SolveStatus.SingularDeadZone, 2);
  assert.equal(SolveStatus.ObstacleOccluded, 3);
});

test('solve requires an explicit positive timestep and finite link radii', () => {
  const solver = new AvoidanceSolver();
  const root = [0, 0, 0], target = [1, 0, 0], evaluate = twoBoneIK(1, 1);
  for (const dt of [undefined, 0, -0.01, NaN, Infinity]) {
    assert.throws(() => solver.solve(root, target, target, 1, 1, 0.02, 0.04, dt, evaluate));
    assert.throws(() => solver.resolveTarget(target, dt));
  }
  for (const radius of [-0.1, NaN, Infinity]) {
    assert.throws(() => solver.solve(root, target, target, 1, 1, 0.02, radius, 1 / 60, evaluate));
  }
});

test('a larger explicit forearm radius is checked independently of the elbow radius', () => {
  const root = [-1, 0, 0], target = [1, 0, 0], length = Math.SQRT2;
  const sphere = new SphereVolume({ center: [0.5, 0.5, 0.12], radius: 0.03 });
  const solver = new AvoidanceSolver([sphere], { minClearance: 0.01 });
  const result = solver.solve(root, target, target, length, length, 0.01, 0.15, 1 / 60, twoBoneIK(length, length));
  assert.ok(result.resolved);
  assert.ok(Math.abs(result.poleAngle) > 1e-5);
  assert.ok(measureSegmentClearance(result.elbow, result.target, 0.15, sphere) >= 0.01 - EPS);
  near(result.poleAngle, result.poleAngleOffset);
});

test('a newly blocked previous swivel reports a rate limit instead of teleporting to a clear orientation', () => {
  const root = [-1, 0, 0], target = [1, 0, 0], length = Math.SQRT2;
  const sphere = new SphereVolume({ center: [0, -1, 0], radius: 0.3 });
  const solver = new AvoidanceSolver([sphere], { minClearance: 0.025 });
  const evaluate = twoBoneIK(length, length);
  const first = solver.solve(root, target, target, length, length, 0.04, 0.04, 0.01, evaluate, { swivelSpeedLimit: 0.1 });
  assert.equal(first.status, SolveStatus.Success);
  const initialAngle = first.poleAngle;
  sphere.set(first.elbow);
  const blocked = solver.solve(root, target, target, length, length, 0.04, 0.04, 0.01, evaluate, { swivelSpeedLimit: 0.1 });
  assert.equal(blocked.status, SolveStatus.SwivelRateLimitExceeded);
  assert.equal(blocked.resolved, false);
  assert.ok(Math.abs(blocked.poleAngle - initialAngle) <= 0.001 + EPS);
  const later = solver.solve(root, target, target, length, length, 0.04, 0.04, 1, evaluate, { swivelSpeedLimit: Math.PI });
  assert.equal(later.status, SolveStatus.Success);
  assertTargetClear(later.target, [sphere], 0.025);
  assert.ok(measureSegmentClearance(later.elbow, later.target, 0.04, sphere) >= 0.025 - EPS);
});

test('reset also clears swivel history so a new first pose may search the full circle', () => {
  const root = [-1, 0, 0], target = [1, 0, 0], length = Math.SQRT2;
  const sphere = new SphereVolume({ center: [0, -1, 0], radius: 0.3 });
  const solver = new AvoidanceSolver([sphere]);
  const evaluate = twoBoneIK(length, length);
  const first = solver.solve(root, target, target, length, length, 0.04, 0.04, 0.01, evaluate, { swivelSpeedLimit: 0 });
  assert.equal(first.status, SolveStatus.Success);
  sphere.set(first.elbow);
  solver.reset();
  const afterReset = solver.solve(root, target, target, length, length, 0.04, 0.04, 0.01, evaluate, { swivelSpeedLimit: 0 });
  assert.equal(afterReset.status, SolveStatus.Success);
  assert.ok(afterReset.resolved);
  assert.ok(measureSegmentClearance(afterReset.elbow, afterReset.target, 0.04, sphere) >= 0.025 - EPS);
});

test('successive swivel corrections remain bounded through angle wrap boundaries', () => {
  const root = [-1, 0, 0], target = [1, 0, 0], length = Math.SQRT2;
  const sphere = new SphereVolume({ center: [0, -1, 0], radius: 0.3 });
  const solver = new AvoidanceSolver([sphere]);
  const evaluate = twoBoneIK(length, length);
  let result = solver.solve(root, target, target, length, length, 0.04, 0.04, 0.5, evaluate, { swivelSpeedLimit: 1 });
  let previousAngle = result.poleAngle;
  let furthestAngle = Math.abs(previousAngle);
  for (let frame = 0; frame < 30; frame++) {
    sphere.set(result.elbow);
    result = solver.solve(root, target, target, length, length, 0.04, 0.04, 0.5, evaluate, { swivelSpeedLimit: 1 });
    assert.equal(result.status, SolveStatus.Success);
    assert.ok(Math.abs(result.poleAngle - previousAngle) <= 0.5 + EPS);
    assert.ok(measureSegmentClearance(result.elbow, result.target, 0.04, sphere) >= 0.025 - EPS);
    previousAngle = result.poleAngle;
    furthestAngle = Math.max(furthestAngle, Math.abs(previousAngle));
  }
  assert.ok(furthestAngle > Math.PI, 'the sequence should exercise an unwrapped angle beyond PI');
});

test('successful randomized poses satisfy independent invariants with two and four colliders', t => {
  const root = [-1, 0, 0], upper = 1.4, lower = 1.2;
  const solveOptions = {reachMargin: 0.02, foldMargin: 0.025, searchBudget: 64, swivelSpeedLimit: 2 * Math.PI};
  const evaluate = twoBoneIK(upper, lower);
  for (const colliderCount of [2, 4]) {
    // Retain the original two-volume seed and its 90 cases. The additional
    // scene places a sphere and two capsules on nominal links. Each must cause
    // a correction rather than acting as an inactive distant obstacle.
    let seed = colliderCount === 2 ? 1234567 : 7654321;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const cases = colliderCount === 2 ? 90 : 120;
    let successes = 0;
    const blockedDefault = new Uint32Array(colliderCount), corrected = new Uint32Array(colliderCount);
    for (let i = 0; i < cases; i++) {
      const sphere = new SphereVolume({ center: [random() - 0.25, random() * 1.4 - 0.7, random() - 0.5], radius: 0.08 + random() * 0.2 });
      const capsule = new CapsuleVolume({ start: [0.3, -0.8, -0.3], end: [0.3, -0.3, 0.2], radius: 0.08 });
      const volumes = [sphere, capsule];
      const target = [0.5 + random() * 0.5, random() - 0.5, random() - 0.5];
      const nominalElbow = new Float32Array(3);
      evaluate(root, target, 0, nominalElbow);
      if (colliderCount === 4) {
        const distalCenter = [...nominalElbow].map((value, j) => value + (target[j] - value) * 0.74);
        capsule.set([distalCenter[0], distalCenter[1], distalCenter[2] - 0.07],
          [distalCenter[0], distalCenter[1], distalCenter[2] + 0.07], 0.055);
        const lowerParameter = 0.35 + random() * 0.3;
        const center = [...nominalElbow].map((value, j) => value + (target[j] - value) * lowerParameter);
        volumes.push(new SphereVolume({center, radius: 0.06 + random() * 0.05}));
        const upperParameter = 0.35 + random() * 0.25;
        const axisCenter = root.map((value, j) => value + (nominalElbow[j] - value) * upperParameter);
        volumes.push(new CapsuleVolume({start: [axisCenter[0], axisCenter[1] - 0.1, axisCenter[2]],
          end: [axisCenter[0], axisCenter[1] + 0.1, axisCenter[2]], radius: 0.05 + random() * 0.03}));
      }
      const initiallyBlocked = volumes.map(volume => Math.min(referenceLinkGap(root, nominalElbow, 0.04, volume),
        referenceLinkGap(nominalElbow, target, 0.06, volume), referenceLinkGap(target, target, 0.03, volume)) < 0.015);
      initiallyBlocked.forEach((blocked, j) => {if (blocked) blockedDefault[j]++;});
      const solver = new AvoidanceSolver(volumes, { minClearance: 0.015, targetRadius: 0.03 });
      const result = solver.solve(root, [1, 0, 0], target, upper, lower, 0.04, 0.06, 1 / 60, evaluate, solveOptions);
      assert.equal(result.resolved, result.status === SolveStatus.Success);
      assert.ok([...result.target, ...result.elbow].every(Number.isFinite));
      if (!result.resolved) continue;
      successes++;
      assert.ok(distance(root, result.target) <= upper + lower - solveOptions.reachMargin);
      assert.ok(distance(root, result.target) >= Math.abs(upper - lower) + solveOptions.foldMargin);
      near(distance(root, result.elbow), upper, 1e-6);
      near(distance(result.elbow, result.target), lower, 1e-6);
      volumes.forEach((volume, j) => {
        assert.ok(referenceLinkGap(root, result.elbow, 0.04, volume) >= 0.015 - 1e-6);
        assert.ok(referenceLinkGap(result.elbow, result.target, 0.06, volume) >= 0.015 - 1e-6);
        assert.ok(referenceLinkGap(result.target, result.target, 0.03, volume) >= 0.015 - 1e-6);
        if (initiallyBlocked[j]) corrected[j]++;
      });
    }
    assert.ok(successes > (colliderCount === 2 ? 20 : 30), `${colliderCount} colliders: expected useful successes, got ${successes}`);
    if (colliderCount === 4) {
      assert.equal(blockedDefault[2], cases);
      assert.equal(blockedDefault[3], cases);
      for (let j = 0; j < colliderCount; j++) assert.ok(corrected[j] > 0, `collider ${j} never participated in a corrected successful pose`);
    }
    t.diagnostic(`${colliderCount} colliders: ${successes}/${cases} successes; initial collisions ${[...blockedDefault]}; corrected collisions ${[...corrected]}`);
  }
});

test('tiny chains retain meaningful relative callback length validation', () => {
  const root = [0, 0, 0], target = [1e-8, 0, 0];
  const options = { reachMargin: 1e-12, foldMargin: 1e-12 };
  const solver = new AvoidanceSolver();
  const invalid = solver.solve(root, target, target, 1e-8, 1e-8, 0, 0, 0.01,
    (r, _t, _a, out) => out.set(r), options);
  assert.equal(invalid.resolved, false, 'a zero-length proximal link is not a valid 1e-8 link');
  const valid = solver.solve(root, target, target, 1e-8, 1e-8, 0, 0, 0.01, twoBoneIK(1e-8, 1e-8), options);
  assert.equal(valid.status, SolveStatus.Success);
  near(distance(root, valid.elbow) / 1e-8, 1, 1e-5);
  near(distance(valid.elbow, valid.target) / 1e-8, 1, 1e-5);
});

test('Float32 output rounding cannot certify a target in the singular extension band', () => {
  const solver = new AvoidanceSolver();
  const root = [0, 0, 0], target = [1.99999998, 0, 0];
  const reachMargin = 1e-9, foldMargin = 1e-9;
  const result = solver.solve(root, [1, 0, 0], target, 1, 1, 0, 0, 0.01, twoBoneIK(1, 1), { reachMargin, foldMargin });
  const actualReach = distance(root, result.target);
  if (actualReach > 2 - reachMargin || actualReach < foldMargin) {
    assert.equal(result.targetResolved, false);
    assert.equal(result.resolved, false);
  }
  if (result.resolved) assert.ok(actualReach >= foldMargin && actualReach <= 2 - reachMargin);
});

test('callback mutation of its inputs cannot change the certified root or target', () => {
  const root = [0, 0, 0], target = [1, 0, 0];
  const evaluate = twoBoneIK(1, 1);
  const solver = new AvoidanceSolver();
  const result = solver.solve(root, target, target, 1, 1, 0.02, 0.02, 0.01, (r, t, a, out) => {
    evaluate(r, t, a, out);
    r[0] = 1000;
    t[0] = 2000;
  });
  assert.ok(result.resolved);
  assert.deepEqual(root, [0, 0, 0]);
  assert.deepEqual(target, [1, 0, 0]);
  near(result.target[0], 1);
  near(distance(root, result.elbow), 1);
  near(distance(result.elbow, result.target), 1);
});

test('caller writes to reused output buffers cannot corrupt private damping or swivel history', () => {
  const dampingSolver = new AvoidanceSolver([], { damping: 1 });
  const output = dampingSolver.resolveTarget([-2, 0, 0], 0.1);
  output[0] = 1000;
  const next = dampingSolver.resolveTarget([2, 0, 0], 0.1);
  near(next[0], -2 + 4 * -Math.expm1(-0.1));
  const solver = new AvoidanceSolver();
  const evaluate = twoBoneIK(1, 1);
  const result = solver.solve([0, 0, 0], [1, 0, 0], [1, 0, 0], 1, 1, 0.02, 0.02, 0.1, evaluate);
  result.poleAngle = result.poleAngleOffset = 1000;
  result.target.fill(1000);
  result.elbow.fill(1000);
  const repeated = solver.solve([0, 0, 0], [1, 0, 0], [1, 0, 0], 1, 1, 0.02, 0.02, 0.1, evaluate);
  assert.equal(repeated.status, SolveStatus.Success);
  near(repeated.poleAngle, 0);
  near(repeated.target[0], 1);
  near(distance([0, 0, 0], repeated.elbow), 1);
});

test('callback writes through an earlier returned target cannot bypass target-radius clearance', () => {
  const sphere = new SphereVolume({ center: [0, 1.3, 0], radius: 0.1 });
  const solver = new AvoidanceSolver([sphere], { targetRadius: 0.3 });
  const root = [0, 0, 0], target = [1, 0, 0];
  const previous = solver.solve(root, target, target, 1, 1, 0, 0, 0.1, twoBoneIK(1, 1));
  assert.ok(previous.resolved);
  const result = solver.solve(root, target, target, 1, 1, 0, 0, 0.1, (_r, _t, _a, out) => {
    previous.target.set([0, 1, 0]);
    out[0] = 0; out[1] = 0.5; out[2] = Math.sqrt(0.75);
  });
  if (result.resolved) {
    assertTargetClear(result.target, [sphere], 0.025, 0.3);
    near(distance(root, result.elbow), 1);
    near(distance(result.elbow, result.target), 1);
  }
});

test('an obstacle moved during the IK callback is rechecked against the final target radius', () => {
  const sphere = new SphereVolume({ center: [0, 5, 0], radius: 0.1 });
  const solver = new AvoidanceSolver([sphere], { targetRadius: 0.5 });
  const target = [1, 0, 0], evaluate = twoBoneIK(1, 1);
  const result = solver.solve([0, 0, 0], target, target, 1, 1, 0, 0, 0.1, (r, t, a, out) => {
    evaluate(r, t, a, out);
    sphere.set([t[0], t[1] + 0.4, t[2]]);
  });
  assert.equal(result.resolved, false);
  assert.equal(result.targetResolved, false);
  assert.ok(sphere.evaluate(result.target, surface, normal) - 0.5 < 0.025);
});

test('disabled or fully converged damping copies targets without catastrophic cancellation', () => {
  for (const damping of [0, 1e-10]) {
    const solver = new AvoidanceSolver([], { damping });
    const result = solver.solve([0, 0, 0], [1e20, 0, 0], [1, 0, 0], 1, 1, 0, 0, 0.1, twoBoneIK(1, 1));
    assert.equal(result.status, SolveStatus.Success);
    near(result.target[0], 1);
    near(distance([0, 0, 0], result.elbow), 1);
    near(distance(result.elbow, result.target), 1);
  }
});

test('identical input and timestep sequences replay exactly from fresh state', () => {
  const replay = () => {
    const sphere = new SphereVolume({ center: [0.5, 0.5, 0], radius: 0.15 });
    const solver = new AvoidanceSolver([sphere], { damping: 0.04 });
    const root = [-1, 0, 0], hand = new Float32Array([1, 0, 0]), length = Math.SQRT2;
    const evaluate = twoBoneIK(length, length);
    const frames = [];
    for (let i = 0; i < 24; i++) {
      sphere.set([0.5, 0.5, Math.sin(i * 0.3) * 0.1]);
      const raw = [1, Math.sin(i * 0.2) * 0.2, Math.cos(i * 0.2) * 0.1];
      const result = solver.solve(root, hand, raw, length, length, 0.04, 0.06, 0.01 + (i % 3) * 0.005, evaluate);
      frames.push({ status: result.status, target: [...result.target], elbow: [...result.elbow], pole: result.poleAngle, clearance: result.clearance });
      if (result.resolved) hand.set(result.target);
    }
    return frames;
  };
  assert.deepEqual(replay(), replay());
});
