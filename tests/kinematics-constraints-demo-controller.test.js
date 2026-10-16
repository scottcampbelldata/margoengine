import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
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

test('recorded 2250-frame contact gestures take validated useful detours and release the final hold', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/constraints-user-contact-20261016.json', import.meta.url), 'utf8'));
  const bytes = Buffer.from(fixture.data, 'base64');
  assert.equal(bytes.length, fixture.frames * 20);
  const d = createConstraintDemo();
  d.configure(fixture.settings);
  d.solveOptions.swivelSpeedLimit = fixture.settings.swivelSpeedLimit;
  d.solveOptions.searchBudget = fixture.settings.searchBudget;
  d.setTarget(...fixture.warmup.target);
  for (let i = 0; i < fixture.warmup.frames; i++) d.step(fixture.warmup.dtSeconds);
  let held = 0, consecutive = 0, maxConsecutive = 0, detours = 0;
  for (let frame = 0; frame < fixture.frames; frame++) {
    const offset = frame * 20;
    d.setTarget(bytes.readFloatLE(offset + 8), bytes.readFloatLE(offset + 12), bytes.readFloatLE(offset + 16));
    const beforeHand = [...d.currentHand], beforeElbow = [...d.currentElbow], beforePole = d.acceptedPole;
    const previousError = Math.hypot(...d.currentHand.map((v, axis) => v - d.rawTarget[axis]));
    d.step(bytes.readDoubleLE(offset));
    audit(d);
    // Existing point-contact projection adds up to61um beyond prospective
    // pacing in this recording. This is a measured regression envelope, not
    // a general Cartesian speed guarantee from the package.
    assert.ok(d.handStep <= 0.75 * d.dt + 0.000065, `frame ${frame}: hand step ${d.handStep}`);
    assert.ok(Math.abs(d.acceptedPole - beforePole) <= d.solveOptions.swivelSpeedLimit * d.dt + 1e-12);
    if (d.result.resolved) consecutive = 0;
    else {
      held++; maxConsecutive = Math.max(maxConsecutive, ++consecutive);
      assert.deepEqual([...d.currentHand], beforeHand);
      assert.deepEqual([...d.currentElbow], beforeElbow);
      assert.equal(d.outwardDetour, false);
    }
    if (d.outwardDetour) {
      detours++;
      assert.equal(d.result.resolved, true);
      assert.equal(d.chased, true);
      assert.ok(d.handStep <= 0.75 * d.dt + 1e-6, `frame ${frame}: detour hand step`);
      const error = Math.hypot(...d.currentHand.map((v, axis) => v - d.rawTarget[axis]));
      assert.ok(error < previousError, `frame ${frame}: detour must reduce requested-target error`);
    }
  }
  // Regression bounds for these captured gestures, not a claim that all targets
  // admit a clear trajectory or that discrete checks certify a temporal sweep.
  assert.equal(held, 0, `recorded baseline held ${fixture.recordedBaseline.held} frames`);
  assert.equal(maxConsecutive, 0);
  assert.ok(detours > 100, `${detours} outward detours`);
  for (let frame = 0; frame < 240; frame++) {
    d.step(1 / 60); audit(d);
    assert.ok(d.handStep <= 0.75 / 60 + 0.000065);
  }
  assert.equal(d.result.resolved, true);
  assert.ok(Math.hypot(...d.currentHand.map((v, axis) => v - d.rawTarget[axis])) < 1e-5,
    'the final target must eventually be reached instead of drifting outward indefinitely');
  d.step(0); assert.equal(d.outwardDetour, false);
  d.setPaused(true); assert.equal(d.outwardDetour, false);
});

test('normal clearance reserve releases all55 reconstructed held contact snapshots without a pole jump', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/constraints-contact-hold-55-20261016.json', import.meta.url), 'utf8'));
  // The recording lost its earliest history. Recover a bend reference from the
  // displayed elbow and pole in an isolated copy of the real controller module.
  // This setup deliberately stays out of the production API; it is not an
  // assertion that rounded snapshot data reproduces hidden state bit-for-bit.
  let source = readFileSync(new URL('../examples/kinematics-constraints-controller.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const marker = '  configure({});\n  return {';
  assert.ok(source.includes(marker));
  source = source.replace('export function createConstraintDemo() {', 'export function createConstraintDemo(snapshot) {');
  source = source.replace("'../packages/kinematics-constraints/dist/index.js'", JSON.stringify(new URL('../packages/kinematics-constraints/dist/index.js', import.meta.url).href));
  source = source.replace(marker, `  configure({});
  root.set(snapshot.root); currentHand.set(snapshot.hand); currentElbow.set(snapshot.elbow);
  rawTarget.set(snapshot.target); acceptedPole = snapshot.pole;
  const axis = snapshot.hand.map((v,i)=>v-snapshot.root[i]), axisLength = Math.hypot(...axis);
  for(let i=0;i<3;i++) bendAxis[i]=axis[i]/axisLength;
  const radial = snapshot.elbow.map((v,i)=>v-snapshot.root[i]);
  const along = radial.reduce((sum,v,i)=>sum+v*bendAxis[i],0);
  for(let i=0;i<3;i++) radial[i]-=along*bendAxis[i];
  const radius = Math.hypot(...radial);
  for(let i=0;i<3;i++) radial[i]/=radius;
  const cross = [bendAxis[1]*radial[2]-bendAxis[2]*radial[1],bendAxis[2]*radial[0]-bendAxis[0]*radial[2],bendAxis[0]*radial[1]-bendAxis[1]*radial[0]];
  for(let i=0;i<3;i++) bendReference[i]=radial[i]*Math.cos(snapshot.pole)-cross[i]*Math.sin(snapshot.pole);
  hasBendFrame=true; avoidance.hasPole=true; avoidance.previousPole=snapshot.pole;
  avoidance.poleArguments.accepted=snapshot.pole;
  acceptedClearance=measurePose();
  return {`);
  const {createConstraintDemo: createSnapshotDemo} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.equal(fixture.frames.length, 55);
  for (const sample of fixture.frames) {
    const d = createSnapshotDemo({...fixture.initialPose, target: sample.target});
    const previousError = Math.hypot(...d.currentHand.map((v,axis)=>v-d.rawTarget[axis]));
    d.step(sample.dt);
    audit(d);
    assert.equal(d.result.resolved, true, `frame ${sample.frame}`);
    assert.equal(d.outwardDetour, true);
    assert.equal(d.solveCalls, 6, 'first contact-normal waypoint must succeed');
    assert.equal(d.angleStep, 0, 'the local escape must not need any swivel jump');
    assert.ok(d.clearance >= 0.008 + 0.00004);
    assert.ok(d.handStep > 0 && d.handStep <= 0.75 * d.dt + 1e-6);
    const error = Math.hypot(...d.currentHand.map((v,axis)=>v-d.rawTarget[axis]));
    assert.ok(previousError-error > 0.009, 'must make useful progress towards the requested target');
  }
});

test('all3103 recorded normal-contact frames recover without artificial waypoint singularity', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/constraints-contact-normal-3103-20261016.json', import.meta.url), 'utf8'));
  const bytes = Buffer.from(fixture.data, 'base64');
  assert.equal(bytes.length, fixture.frames * 20);
  const d = createConstraintDemo();
  d.configure(fixture.settings);
  d.solveOptions.swivelSpeedLimit = fixture.settings.swivelSpeedLimit;
  d.solveOptions.searchBudget = fixture.settings.searchBudget;
  d.setTarget(...fixture.warmup.target);
  for (let i = 0; i < fixture.warmup.frames; i++) d.step(fixture.warmup.dtSeconds);
  let detours = 0;
  for (let frame = 0; frame < fixture.frames; frame++) {
    const offset = frame * 20;
    d.setTarget(bytes.readFloatLE(offset + 8), bytes.readFloatLE(offset + 12), bytes.readFloatLE(offset + 16));
    const beforePole = d.acceptedPole;
    const beforeError = Math.hypot(...d.currentHand.map((v,axis)=>v-d.rawTarget[axis]));
    d.step(bytes.readDoubleLE(offset));
    audit(d);
    assert.equal(d.result.resolved, true, `recorded frame ${frame}`);
    assert.ok(Math.abs(d.acceptedPole-beforePole) <= d.solveOptions.swivelSpeedLimit*d.dt+1e-12);
    // The original target contact band adds up to67um beyond prospective
    // pacing in this recording. This is a trajectory regression envelope.
    assert.ok(d.handStep <= 0.75*d.dt+0.00007);
    if (d.outwardDetour) {
      detours++;
      assert.ok(d.handStep <= 0.75*d.dt+1e-6);
      const requestedReach = Math.hypot(...d.lastSolveTarget.map((v,axis)=>v-d.lastSolveRoot[axis]));
      assert.ok(requestedReach >= Math.abs(d.upperLength-d.lowerLength)+d.solveOptions.foldMargin);
      assert.ok(requestedReach <= d.upperLength+d.lowerLength-d.solveOptions.reachMargin);
      const error = Math.hypot(...d.currentHand.map((v,axis)=>v-d.rawTarget[axis]));
      assert.ok(error < beforeError, `frame ${frame}: conditioned waypoint must still make progress`);
    }
  }
  assert.ok(detours > 300);
});
