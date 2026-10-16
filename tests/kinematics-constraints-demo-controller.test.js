import assert from 'node:assert/strict';
import test from 'node:test';
import {createConstraintDemo} from '../examples/kinematics-constraints-controller.js';

// Independent convex segment minimum: endpoints plus the interior stationary pair.
function distance(a, b, c, d) {
  const u = b.map((x, i) => x - a[i]),
    v = d.map((x, i) => x - c[i]),
    w = a.map((x, i) => x - c[i]);
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const uu = dot(u, u),
    vv = dot(v, v),
    uv = dot(u, v),
    uw = dot(u, w),
    vw = dot(v, w);
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const pairs = [
    [0, vv ? clamp(vw / vv) : 0],
    [1, vv ? clamp((vw + uv) / vv) : 0],
    [uu ? clamp(-uw / uu) : 0, 0],
    [uu ? clamp((uv - uw) / uu) : 0, 1],
  ];
  const den = uu * vv - uv * uv;
  if (den > 1e-14) {
    const s = (uv * vw - vv * uw) / den,
      t = (uu * vw - uv * uw) / den;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) pairs.push([s, t]);
  }
  return Math.min(
    ...pairs.map(([s, t]) =>
      Math.hypot(...w.map((x, i) => x + s * u[i] - t * v[i])),
    ),
  );
}
function audit(d) {
  const root = [...d.root],
    elbow = [...d.currentElbow],
    hand = [...d.currentHand];
  assert.ok([...root, ...elbow, ...hand].every(Number.isFinite));
  assert.ok(
    Math.abs(Math.hypot(...root.map((x, i) => x - elbow[i])) - d.upperLength) <
      1e-6,
  );
  assert.ok(
    Math.abs(Math.hypot(...hand.map((x, i) => x - elbow[i])) - d.lowerLength) <
      1e-6,
  );
  const reach = Math.hypot(...root.map((x, i) => x - hand[i]));
  assert.ok(
    reach >=
      Math.abs(d.upperLength - d.lowerLength) + d.solveOptions.foldMargin,
  );
  assert.ok(
    reach <= d.upperLength + d.lowerLength - d.solveOptions.reachMargin,
  );
  for (const volume of d.volumes) {
    const a = volume.start ? [...volume.start] : [...volume.center],
      b = volume.end ? [...volume.end] : a;
    assert.ok(
      distance(root, elbow, a, b) - volume.radius - d.elbowRadius >=
        d.avoidance.minClearance - 1e-6,
    );
    assert.ok(
      distance(elbow, hand, a, b) - volume.radius - d.forearmRadius >=
        d.avoidance.minClearance - 1e-6,
    );
  }
}
test('all scene/gap/damping configurations begin from an independently clear full pose', () => {
  const d = createConstraintDemo();
  for (const scene of ['torso', 'mixed'])
    for (const minClearance of [0, 0.008, 0.03])
      for (const damping of [0, 0.12, 0.25]) {
        d.configure({scene, minClearance, damping});
        assert.equal(d.result.resolved, true);
        audit(d);
      }
  for (const settings of [
    {scene: 'unknown'},
    {minClearance: NaN},
    {minClearance: -1},
    {damping: Infinity},
  ])
    assert.throws(() => d.configure(settings));
});
test('mixed-obstacle reversal, caller dt and demo torso assist preserve full-chain invariants and pole history', () => {
  const d = createConstraintDemo();
  let accepted = 0,
    chased = 0,
    held = 0,
    maximumYaw = 0;
  d.configure({scene: 'mixed'});
  d.setYawAssist(true);
  for (let i = 0; i < 2400; i++) {
    const previousHand = [...d.currentHand],
      previousElbow = [...d.currentElbow],
      previousRoot = [...d.root],
      previousPole = d.acceptedPole;
    d.setClock(['live', 'fixed60', 'fixed120'][Math.floor(i / 200) % 3]);
    d.solveOptions.swivelSpeedLimit =
      ([0, 15, 90, 180, 360][Math.floor(i / 37) % 5] * Math.PI) / 180;
    d.solveOptions.searchBudget = [0, 32, 128, 256][Math.floor(i / 80) % 4];
    d.setInteractiveTarget(
      0.3 + 0.67 * Math.cos(i * 0.025),
      0.85 + 0.23 * Math.sin(i * 0.025),
    );
    d.step([1 / 240, 1 / 120, 1 / 60, 0.08][i % 4]);
    audit(d);
    maximumYaw = Math.max(maximumYaw, d.yaw);
    if (d.result.resolved) {
      accepted++;
      if (d.chased) chased++;
      assert.ok(
        Math.abs(d.result.poleAngle - previousPole) <=
          Math.min(Math.PI, d.solveOptions.swivelSpeedLimit * d.dt) + 1e-12,
      );
      assert.ok(d.angleStep <= d.solveOptions.swivelSpeedLimit * d.dt + 1e-12);
    } else {
      held++;
      assert.deepEqual([...d.currentHand], previousHand);
      assert.deepEqual([...d.currentElbow], previousElbow);
      assert.deepEqual([...d.root], previousRoot);
      assert.equal(d.angleStep, 0);
    }
  }
  assert.ok(accepted > 500);
  assert.ok(chased > 0);
  assert.ok(held > 0);
  assert.ok(maximumYaw > 0.2 && maximumYaw <= (25 * Math.PI) / 180);
});
test('target-only projection never modifies the accepted arm or certifies reach and returns to full-chain history', () => {
  const d = createConstraintDemo();
  const hand = [...d.currentHand],
    elbow = [...d.currentElbow],
    pole = d.result.poleAngle;
  d.setMode('target');
  d.setTarget(0, 0.8, 0);
  for (let i = 0; i < 120; i++) d.step(1 / 60);
  assert.equal(d.targetResult.resolved, true);
  assert.deepEqual([...d.currentHand], hand);
  assert.deepEqual([...d.currentElbow], elbow);
  for (const volume of d.volumes)
    assert.ok(
      distance(
        [...d.projectedTarget],
        [...d.projectedTarget],
        [...volume.start],
        [...volume.end],
      ) -
        volume.radius -
        d.forearmRadius >=
        0.008 - 1e-6,
    );
  d.setTarget(4, 4, 4);
  for (let i = 0; i < 120; i++) d.step(1 / 60);
  assert.equal(d.targetResult.resolved, true);
  assert.ok(
    Math.hypot(...d.projectedTarget.map((x, i) => x - d.root[i])) >
      d.upperLength + d.lowerLength,
  );
  d.setMode('chain');
  d.setTarget(0.9, 0.7, 0.14);
  d.step(1 / 60);
  audit(d);
  assert.ok(Math.abs(d.result.poleAngle - pole) <= Math.PI / 60 + 1e-12);
});
test('singular raw requests remain held; zero time and rejected settings never silently advance a pose', () => {
  const d = createConstraintDemo();
  const hand = [...d.currentHand],
    elbow = [...d.currentElbow];
  for (const distance of [0, 1e-12, 1.07, 1.08]) {
    d.setTarget(d.root[0], d.root[1] + distance, d.root[2]);
    for (let i = 0; i < 60; i++) {
      d.step(1 / 60);
      assert.equal(d.result.resolved, false);
      assert.equal(d.chased, false);
      audit(d);
    }
  }
  assert.deepEqual([...d.currentHand], hand);
  assert.deepEqual([...d.currentElbow], elbow);
  const oldResult = d.result;
  d.step(0);
  assert.equal(d.result, oldResult);
  for (const dt of [-1, NaN, Infinity]) assert.throws(() => d.step(dt));
});

test('normal contact sliding, zero-speed hold and speed release expose distinct accepted motion without reset', () => {
  const d = createConstraintDemo();
  d.setInteractiveTarget(0, 0.9);
  for (let i = 0; i < 180; i++) d.step(1 / 60);
  let sliding = 0,
    maxSlideStep = 0;
  for (let i = 0; i < 120; i++) {
    d.setInteractiveTarget(0.02 * Math.sin(i * 0.08), 0.9);
    d.step(1 / 60);
    audit(d);
    if (d.result.resolved && d.clampActive && d.handStep > 0) sliding++;
    maxSlideStep = Math.max(maxSlideStep, d.handStep);
  }
  assert.ok(sliding > 100);
  assert.ok(maxSlideStep > 0);
  d.solveOptions.swivelSpeedLimit = 0;
  d.setTarget(-0.1, 0.9, 0.39);
  let held = 0;
  for (let i = 0; i < 120; i++) {
    d.step(1 / 60);
    audit(d);
    if (!d.result.resolved) {
      held++;
      assert.equal(d.handStep, 0);
      assert.equal(d.angleStep, 0);
    }
  }
  assert.ok(held > 50);
  d.solveOptions.swivelSpeedLimit = Math.PI * 2;
  let resumed = 0;
  for (let i = 0; i < 180; i++) {
    const angle = d.acceptedPole;
    d.step(1 / 60);
    audit(d);
    assert.ok(Math.abs(d.acceptedPole - angle) <= Math.PI / 30 + 1e-12);
    if (d.result.resolved && d.handStep > 0) resumed++;
  }
  assert.ok(resumed > 0);
  assert.equal(d.result.resolved, true);
});

test('prospective pacing removes the mixed-scene catch-up jump before solve history commits', () => {
  const d = createConstraintDemo(); d.configure({scene:'mixed'}); d.setClock('fixed120'); d.setYawAssist(true);
  let peak = 0, accepted = 0;
  for (let i = 0; i < 720; i++) {
    d.setInteractiveTarget(.3+.67*Math.cos(i*.025),.85+.23*Math.sin(i*.025)); d.step(1/30); audit(d);
    peak = Math.max(peak,d.handStep); if (d.result.resolved) accepted++;
    assert.ok([...d.commandTarget,...d.lastSolveTarget,...d.lastSolveRoot].every(Number.isFinite));
  }
  // Regression envelope for this fixed scene/trajectory; not a general velocity certificate.
  assert.equal(accepted,720); assert.ok(peak < .00626);
  const hand = [...d.currentHand]; d.setPaused(true); d.step(1/60);
  assert.deepEqual([...d.currentHand],hand); assert.equal(d.handStep,0); assert.equal(d.angleStep,0); assert.equal(d.solveCalls,0);
});
