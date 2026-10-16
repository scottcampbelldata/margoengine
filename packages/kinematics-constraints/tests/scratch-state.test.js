import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AvoidanceSolver, SphereVolume, SolveStatus } from '../dist/index.js';

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const root = [-1, 0, 0],
  hand = [1, 0, 0],
  length = Math.SQRT2;
function ik(upper, lower) {
  return (base, target, angle, out) => {
    let x = target[0] - base[0],
      y = target[1] - base[1],
      z = target[2] - base[2];
    const reach = Math.hypot(x, y, z);
    x /= reach;
    y /= reach;
    z /= reach;
    let px = -x * y,
      py = 1 - y * y,
      pz = -z * y,
      p = Math.hypot(px, py, pz);
    if (p < 1e-8) {
      px = 1;
      py = pz = 0;
      p = 1;
    }
    px /= p;
    py /= p;
    pz /= p;
    const qx = y * pz - z * py,
      qy = z * px - x * pz,
      qz = x * py - y * px;
    const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
    const height = Math.sqrt(Math.max(0, upper * upper - along * along)),
      c = Math.cos(angle),
      s = Math.sin(angle);
    out[0] = base[0] + x * along + height * (px * c + qx * s);
    out[1] = base[1] + y * along + height * (py * c + qy * s);
    out[2] = base[2] + z * along + height * (pz * c + qz * s);
  };
}
const evaluate = ik(length, length);
function arm(solver, options, dt = 1 / 60, callback = evaluate) {
  return solver.solve(root, hand, hand, length, length, 0.04, 0.04, dt, callback, options);
}

test('solve state matches a control when interleaved with target-only and geometric pole queries', () => {
  const volumeA = new SphereVolume({ center: [0.5, 0.5, 0], radius: 0.15 });
  const volumeB = new SphereVolume({ center: [0.5, 0.5, 0], radius: 0.15 });
  const solver = new AvoidanceSolver([volumeA]),
    control = new AvoidanceSolver([volumeB]);
  assert.deepEqual(arm(solver), arm(control));
  assert.notEqual(arm(solver).poleAngle, 0, 'the saved reference pole should be nonzero');
  for (let i = 0; i < 24; i++) {
    const target = [30 + i, 4, -3];
    assert.deepEqual(
      [...solver.resolveTarget(target, 0.001 + i * 0.002)],
      target,
      'target-only query must ignore earlier reach bounds',
    );
    const pole = solver.calculatePoleClearance([10, 0, 0], [10.5, 1, 0], [11, 0, 0], 0.02);
    assert.ok(pole.resolved);
    const options = {
      searchBudget: i % 2 ? 0 : 32,
      swivelSpeedLimit: 0,
      reachMargin: i % 3 ? 0.01 : 0.2,
      foldMargin: 0.03,
    };
    const dt = [0.001, 1 / 120, 0.05][i % 3];
    const actual = arm(solver, options, dt),
      expected = arm(control, options, dt);
    assert.deepEqual(actual, expected, `interleaved solve ${i}`);
    assert.equal(actual.status, SolveStatus.Success);
  }
});

test('pole-only search resets its full geometric span after a zero-speed solve', () => {
  const volume = new SphereVolume({ center: [0.5, 0.5, 0], radius: 0.15 });
  const solver = new AvoidanceSolver([volume]);
  const accepted = arm(solver);
  assert.ok(accepted.resolved);
  const angle = accepted.poleAngle;
  assert.ok(arm(solver, { swivelSpeedLimit: 0, searchBudget: 0 }).resolved);
  const correction = solver.calculatePoleClearance(root, [0, 1, 0], hand, 0.04);
  assert.ok(correction.resolved);
  assert.ok(Math.abs(correction.poleAngleOffset) > 0);
  const after = arm(solver, { swivelSpeedLimit: 0, searchBudget: 0 });
  assert.equal(after.status, SolveStatus.Success);
  assert.equal(after.poleAngle, angle, 'geometric helper must not replace the saved solve pole');
});

test('a global diagnostic search cannot leak its span into later zero-speed solves', () => {
  const volume = new SphereVolume({ center: [0, -1, 0], radius: 0.3 });
  const solver = new AvoidanceSolver([volume]);
  const first = arm(solver);
  assert.equal(first.status, SolveStatus.Success);
  const initialAngle = first.poleAngle;
  volume.set(first.elbow);
  const limited = arm(solver, { swivelSpeedLimit: 0.1, searchBudget: 64 }, 0.001);
  assert.equal(limited.status, SolveStatus.SwivelRateLimitExceeded);
  for (const dt of [0.001, 0.02, 0.2]) {
    solver.calculatePoleClearance([10, 0, 0], [10.5, 1, 0], [11, 0, 0], 0.02);
    solver.resolveTarget([20, -3, 0], dt);
    const repeated = arm(solver, { swivelSpeedLimit: 0, searchBudget: 64 }, dt);
    assert.equal(repeated.status, SolveStatus.SwivelRateLimitExceeded);
    assert.equal(repeated.poleAngle, initialAngle);
  }
  volume.set([0, -1, 0]);
  const recovered = arm(solver, { swivelSpeedLimit: 0, searchBudget: 0 }, 0.001);
  assert.equal(recovered.status, SolveStatus.Success);
  assert.equal(recovered.poleAngle, initialAngle);
});

test('zero search budget checks only the configured center and recovers with a new budget', () => {
  const solver = new AvoidanceSolver([new SphereVolume({ center: [0.5, 0.5, 0], radius: 0.15 })]);
  assert.equal(arm(solver, { searchBudget: 0, swivelSpeedLimit: 0 }).status, SolveStatus.ObstacleOccluded);
  solver.resolveTarget([20, 0, 0], 0.02);
  const found = arm(solver, { searchBudget: 64, swivelSpeedLimit: 0 }, 0.005);
  assert.equal(found.status, SolveStatus.Success, 'the first successful pose may search the whole circle');
  const angle = found.poleAngle;
  assert.equal(arm(solver, { searchBudget: 0, swivelSpeedLimit: 0 }, 0.03).poleAngle, angle);
  solver.reset();
  assert.equal(arm(solver, { searchBudget: 0, swivelSpeedLimit: 0 }).status, SolveStatus.ObstacleOccluded);
});

test('reach bounds refresh across lengths, margins, unbounded target queries, and resets', () => {
  const solver = new AvoidanceSolver();
  const base = [7, -2, 0.5];
  for (const [upper, lower, reachMargin, foldMargin] of [
    [1, 0.4, 0.02, 0.03],
    [0.25, 0.22, 0.01, 0.015],
    [2, 0.8, 0.2, 0.1],
  ]) {
    const current = [base[0] + upper, base[1], base[2]],
      options = { reachMargin, foldMargin, searchBudget: 0, swivelSpeedLimit: 0 };
    const minimum = Math.abs(upper - lower) + foldMargin,
      maximum = upper + lower - reachMargin;
    for (const raw of [[base[0] + 20, base[1], base[2]], [...base]]) {
      const result = solver.solve(base, current, raw, upper, lower, 0, 0, 0.03, ik(upper, lower), options);
      assert.equal(result.status, SolveStatus.SingularDeadZone);
      assert.ok(distance(base, result.target) >= minimum);
      assert.ok(distance(base, result.target) <= maximum);
      assert.ok(Math.abs(distance(base, result.elbow) - upper) < 1e-6);
      assert.ok(Math.abs(distance(result.elbow, result.target) - lower) < 1e-6);
      assert.deepEqual([...solver.resolveTarget([100, 2, -3], 0.01)], [100, 2, -3]);
      solver.calculatePoleClearance([10, 0, 0], [10.5, 1, 0], [11, 0, 0], 0);
      solver.reset();
    }
  }
});

test('invalid options and throwing callbacks cannot poison later scratch or successful history', () => {
  const solver = new AvoidanceSolver([new SphereVolume({ center: [0.5, 0.5, 0], radius: 0.15 })]);
  const control = new AvoidanceSolver([new SphereVolume({ center: [0.5, 0.5, 0], radius: 0.15 })]);
  assert.deepEqual(arm(solver), arm(control));
  for (const options of [
    { searchBudget: -1 },
    { searchBudget: 1.5 },
    { swivelSpeedLimit: -1 },
    { reachMargin: 0 },
    { foldMargin: NaN },
    { reachMargin: 3 },
  ]) {
    assert.throws(() => arm(solver, options));
    assert.deepEqual(
      arm(solver, { swivelSpeedLimit: 0, searchBudget: 0 }),
      arm(control, { swivelSpeedLimit: 0, searchBudget: 0 }),
    );
  }
  for (const dt of [0, -1, NaN, Infinity]) {
    assert.throws(() => arm(solver, {}, dt));
    assert.deepEqual(
      arm(solver, { swivelSpeedLimit: 0, searchBudget: 0 }),
      arm(control, { swivelSpeedLimit: 0, searchBudget: 0 }),
    );
  }
  assert.throws(
    () =>
      arm(solver, {}, 0.05, () => {
        throw new Error('callback interrupted');
      }),
    /callback interrupted/,
  );
  assert.deepEqual([...solver.resolveTarget([20, 3, -1], 0.01)], [20, 3, -1]);
  assert.deepEqual(
    arm(solver, { swivelSpeedLimit: 0, searchBudget: 0 }),
    arm(control, { swivelSpeedLimit: 0, searchBudget: 0 }),
  );
  solver.reset();
  control.reset();
  assert.deepEqual(arm(solver, { swivelSpeedLimit: 0 }), arm(control, { swivelSpeedLimit: 0 }));
});

test('returned bounded elbow and angle stay paired while failed searches preserve the accepted pole', () => {
  const volume = new SphereVolume({ center: [0, -1, 0], radius: 0.3 });
  const solver = new AvoidanceSolver([volume]);
  const expectedElbow = new Float32Array(3);
  function checkPair(result) {
    evaluate(root, result.target, result.poleAngle, expectedElbow);
    assert.deepEqual(result.elbow, expectedElbow);
    assert.equal(result.poleAngleOffset, result.poleAngle);
  }
  const first = arm(solver);
  checkPair(first);
  assert.equal(first.status, SolveStatus.Success);
  const acceptedAngle = first.poleAngle;
  volume.set(first.elbow);
  const limited = arm(solver, { swivelSpeedLimit: 0.1, searchBudget: 64 }, 0.001);
  checkPair(limited);
  assert.equal(limited.status, SolveStatus.SwivelRateLimitExceeded);
  assert.ok(Math.abs(limited.poleAngle - acceptedAngle) <= 0.0001);
  assert.ok(solver.calculatePoleClearance(root, [0, 1, 0], hand, 0.04).resolved);
  volume.set([0, -1, 0]);
  const recovered = arm(solver, { swivelSpeedLimit: 0, searchBudget: 0 });
  checkPair(recovered);
  assert.equal(recovered.status, SolveStatus.Success);
  assert.equal(recovered.poleAngle, acceptedAngle);
  const trapped = new SphereVolume({ center: [0, 0, 0], radius: 10 });
  solver.addVolume(trapped);
  const failed = arm(solver, { swivelSpeedLimit: 0.1, searchBudget: 16 }, 0.01);
  checkPair(failed);
  assert.equal(failed.status, SolveStatus.ObstacleOccluded);
  trapped.set([10, 10, 10], 0.1);
  const untrapped = arm(solver, { swivelSpeedLimit: 0, searchBudget: 0 });
  checkPair(untrapped);
  assert.equal(untrapped.status, SolveStatus.Success);
  assert.equal(untrapped.poleAngle, acceptedAngle);
});

test('an admissible diagnostic-grid result commits its own angle and elbow as the next search center', () => {
  let open = true;
  const clearAngle = Math.PI / 16;
  const volume = {
    evaluate(point, surface, normal) {
      surface.set(point);
      normal.set([1, 0, 0]);
      return 2;
    },
    segmentClearance(start, end) {
      if (open) return 1;
      const joint = Math.hypot(start[1], start[2]) > 0.5 ? start : end;
      return Math.abs(Math.atan2(joint[2], joint[1]) - clearAngle) < 1e-4 ? 1 : -0.05;
    },
  };
  const solver = new AvoidanceSolver([volume]);
  assert.equal(arm(solver).status, SolveStatus.Success);
  open = false;
  const angles = [];
  const callback = (base, target, angle, out) => {
    angles.push(angle);
    evaluate(base, target, angle, out);
  };
  // The bounded grid has steps .3/16 and misses the narrow clear arc. The
  // global diagnostic grid finds PI/16, which is still inside the rate limit.
  const result = arm(solver, { swivelSpeedLimit: 0.3, searchBudget: 32 }, 1, callback);
  assert.equal(result.status, SolveStatus.Success);
  assert.equal(result.poleAngle, clearAngle);
  assert.ok(angles.length > 33, 'the clear candidate must come from the diagnostic pass');
  const expected = new Float32Array(3);
  evaluate(root, result.target, clearAngle, expected);
  assert.deepEqual(result.elbow, expected);
  const next = arm(solver, { swivelSpeedLimit: 0, searchBudget: 0 }, 0.001);
  assert.equal(next.status, SolveStatus.Success);
  assert.equal(next.poleAngle, clearAngle);
  assert.deepEqual(next.elbow, expected);
});

test('zero, odd, and maximum search budgets keep candidate order and stable best-on-tie selection', () => {
  const blocked = {
    evaluate(point, surface, normal) {
      surface.set(point);
      normal.set([1, 0, 0]);
      return 2;
    },
    segmentClearance() {
      return -1;
    },
  };
  for (const [budget, golden] of [
    [0, [0]],
    [1, [0, Math.PI]],
    [3, [0, Math.PI / 2, -Math.PI / 2, Math.PI]],
    [5, [0, Math.PI / 3, -Math.PI / 3, (2 * Math.PI) / 3, (-2 * Math.PI) / 3, Math.PI]],
    [255, null],
    [256, null],
  ]) {
    const solver = new AvoidanceSolver([blocked]),
      candidates = [];
    const callback = (base, target, angle, out) => {
      assert.equal(typeof angle, 'number');
      assert.ok(Number.isFinite(angle));
      candidates.push(angle);
      evaluate(base, target, angle, out);
    };
    const result = arm(solver, { searchBudget: budget }, 1 / 60, callback);
    assert.equal(result.status, SolveStatus.ObstacleOccluded);
    assert.equal(candidates.length, budget + 1);
    assert.equal(result.poleAngle, 0, 'equal-clearance candidates must preserve the first best pose');
    if (golden) assert.deepEqual(candidates, golden);
    else {
      assert.deepEqual(candidates.slice(0, 3), [0, Math.PI / 128, -Math.PI / 128]);
      for (let i = 1; i + 1 < candidates.length; i += 2) {
        assert.equal(candidates[i], -candidates[i + 1]);
        if (i > 1) assert.ok(candidates[i] > candidates[i - 2]);
      }
      assert.equal(candidates.at(-1), budget === 255 ? Math.PI : -Math.PI);
    }
    const retained = candidates.slice();
    arm(solver, { searchBudget: 3 }, 0.003, callback);
    assert.deepEqual(
      candidates.slice(0, retained.length),
      retained,
      'later callbacks must not mutate retained primitive angle snapshots',
    );
  }
});

test('zero and sub-ULP rate windows keep a nonzero center without candidate drift', () => {
  let blocked = false;
  const center = Math.PI / 4;
  const volume = {
    evaluate(point, surface, normal) {
      surface.set(point);
      normal.set([1, 0, 0]);
      return 2;
    },
    segmentClearance(start, end) {
      if (blocked) return -1;
      const joint = Math.hypot(start[1], start[2]) > 0.5 ? start : end;
      return Math.abs(Math.atan2(joint[2], joint[1]) - center) < 1e-4 ? 1 : -1;
    },
  };
  const solver = new AvoidanceSolver([volume]);
  assert.equal(arm(solver, { searchBudget: 8 }).poleAngle, center);
  blocked = true;
  for (const [speed, dt] of [
    [0, 0.001],
    [Number.MIN_VALUE, 1],
    [1e-300, 0.05],
    [1e-3, 0.001],
  ]) {
    const values = [];
    const callback = (base, target, angle, out) => {
      assert.equal(typeof angle, 'number');
      values.push(angle);
      evaluate(base, target, angle, out);
    };
    const result = arm(solver, { searchBudget: 3, swivelSpeedLimit: speed }, dt, callback);
    assert.equal(result.status, SolveStatus.ObstacleOccluded);
    assert.equal(result.poleAngle, center);
    const span = speed * dt;
    assert.deepEqual(values.slice(0, 4), [center, center + span * 0.5, center - span * 0.5, center + span]);
    assert.ok(values.every(Number.isFinite));
  }
});

test('a zero-speed search preserves primitive positive-zero callback arguments', () => {
  let blocked = false;
  const volume = {
    evaluate(point, surface, normal) {
      surface.set(point);
      normal.set([1, 0, 0]);
      return 2;
    },
    segmentClearance() {
      return blocked ? -1 : 1;
    },
  };
  const solver = new AvoidanceSolver([volume]);
  assert.ok(Object.is(arm(solver).poleAngle, 0));
  blocked = true;
  const values = [];
  const callback = (base, target, angle, out) => {
    assert.equal(typeof angle, 'number');
    values.push(angle);
    evaluate(base, target, angle, out);
  };
  arm(solver, { swivelSpeedLimit: 0, searchBudget: 3 }, Number.MIN_VALUE, callback);
  assert.equal(values.length, 8, 'bounded and diagnostic passes should both run');
  for (const value of values.slice(0, 4))
    assert.ok(Object.is(value, 0), 'adding signed zero offsets must preserve positive-zero center semantics');
});

test('coincident shoulder requests use a deterministic fold direction across tiny and large reaches', () => {
  for (const [upper, lower, foldMargin, reachMargin] of [
    [1, 1, 0.01, 0.01],
    [3e-20, 2e-20, 1e-22, 1e-22],
    [3e20, 2e20, 1e18, 1e18],
  ]) {
    const solver = new AvoidanceSolver(),
      origin = [0, 0, 0],
      options = { foldMargin, reachMargin, searchBudget: 0 };
    const result = solver.solve(origin, origin, origin, upper, lower, 0, 0, 0.01, ik(upper, lower), options);
    assert.equal(result.resolved, false, 'a raw zero-reach request must never be accepted');
    assert.ok([...result.target, ...result.elbow].every(Number.isFinite));
    assert.ok(result.target[0] > 0);
    assert.equal(result.target[1], 0);
    assert.equal(result.target[2], 0);
    assert.ok(distance(origin, result.target) >= Math.abs(upper - lower) + foldMargin);
    assert.ok(distance(origin, result.target) <= upper + lower - reachMargin);
    if (result.status === SolveStatus.SingularDeadZone) {
      const tolerance = Math.min(4e-6, Math.min(upper, lower) * 1e-5);
      assert.ok(Math.abs(distance(origin, result.elbow) - upper) <= tolerance);
      assert.ok(Math.abs(distance(result.elbow, result.target) - lower) <= tolerance);
    }
  }
  assert.throws(
    () => new AvoidanceSolver().solve([0, 0, 0], [1, 0, 0], [1, 0, 0], 1e39, 1e39, 0, 0, 0.01, ik(1e39, 1e39)),
    /operational reach/,
  );
});

test('caller writes to public numeric result fields cannot replace a nonzero accepted center', () => {
  const volumes = [
    new SphereVolume({ center: [0.5, 0.5, 0], radius: 0.15 }),
    new SphereVolume({ center: [0.5, 0.5, 0], radius: 0.15 }),
  ];
  const solver = new AvoidanceSolver([volumes[0]]),
    control = new AvoidanceSolver([volumes[1]]);
  const retained = arm(solver),
    original = arm(control);
  assert.deepEqual(retained, original);
  const angle = original.poleAngle;
  assert.notEqual(angle, 0);
  for (const poison of [NaN, Infinity, -Infinity, -12345.6789, -0]) {
    retained.poleAngle = poison;
    retained.poleAngleOffset = poison;
    retained.clearance = poison;
    retained.maxPenetration = poison;
    retained.iterations = poison;
    retained.status = 99;
    retained.resolved = retained.targetResolved = false;
    const actual = arm(solver, { swivelSpeedLimit: 0, searchBudget: 0 }, 0.003);
    const expected = arm(control, { swivelSpeedLimit: 0, searchBudget: 0 }, 0.003);
    assert.deepEqual(actual, expected);
    assert.equal(actual.status, SolveStatus.Success);
    assert.ok(Object.is(actual.poleAngle, angle));
  }
});

test('callback writes to prior public results and copied inputs cannot poison accepted scalar state', () => {
  const solver = new AvoidanceSolver([new SphereVolume({ center: [0.5, 0.5, 0], radius: 0.15 })]);
  const control = new AvoidanceSolver([new SphereVolume({ center: [0.5, 0.5, 0], radius: 0.15 })]);
  const retained = arm(solver);
  assert.deepEqual(retained, arm(control));
  const angle = retained.poleAngle;
  const mutating = (base, target, candidateAngle, out) => {
    assert.equal(typeof candidateAngle, 'number');
    assert.ok(Object.is(candidateAngle, angle));
    evaluate(base, target, candidateAngle, out);
    base.fill(-1000);
    target.fill(2000);
    retained.target.fill(3000);
    retained.elbow.fill(4000);
    retained.poleAngle = NaN;
    retained.poleAngleOffset = Infinity;
    retained.clearance = retained.maxPenetration = retained.iterations = NaN;
    retained.status = 99;
    retained.resolved = retained.targetResolved = false;
  };
  for (const dt of [Number.MIN_VALUE, 0.001, 1 / 60, 0.25]) {
    const options = { swivelSpeedLimit: 0, searchBudget: 0 };
    assert.deepEqual(arm(solver, options, dt, mutating), arm(control, options, dt));
    assert.deepEqual(arm(solver, options, dt), arm(control, options, dt));
  }
});
