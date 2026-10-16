import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset } from '../packages/gltf-pro/dist/index.js';
import { HeadAim } from '../examples/skinning-ik/head-aim.ts';
import { cowlingHull } from '../examples/skinning-ik/head-aim-shape.ts';
import { gripPosition, localPoint, worldPosition } from '../examples/skinning-ik/rig-ik.ts';
import { mapArmControl } from '../examples/skinning-ik/arm-controls.ts';
import { GazeTarget } from '../examples/skinning-ik/gaze-target.ts';
import { TargetMotion } from '../examples/skinning-ik/target-motion.ts';

mkdirSync(resolve('test-results'), { recursive: true });
const temporary = mkdtempSync(resolve('test-results/ik-gaze-'));
const bundle = await build({
  configFile: false, publicDir: false, logLevel: 'silent',
  build: { write: false, target: 'es2022', minify: false,
    lib: { entry: {
      body: resolve('examples/skinning-ik/body-ik.ts'),
      torso: resolve('examples/skinning-ik/torso-aim.ts'),
      armHead: resolve('examples/skinning-ik/arm-head-clearance.ts'),
      route: resolve('examples/skinning-ik/arm-control-route.ts'),
    }, formats: ['es'] },
    rollupOptions: { external: id => id.startsWith('@margoengine/') },
  },
});
for (const output of bundle[0].output) writeFileSync(join(temporary, output.fileName), output.code);
const { BodyIK } = await import(pathToFileURL(join(temporary, 'body.js')).href),
  { TorsoAim } = await import(pathToFileURL(join(temporary, 'torso.js')).href),
  { ArmHeadClearance } = await import(pathToFileURL(join(temporary, 'armHead.js')).href),
  { ArmControlRoute } = await import(pathToFileURL(join(temporary, 'route.js')).href);
for (const output of bundle[0].output) unlinkSync(join(temporary, output.fileName));
rmdirSync(temporary);

const bytes = readFileSync(new URL('../examples/assets/skinning-ik.glb', import.meta.url)),
  jsonLength = bytes.readUInt32LE(12),
  doc = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength)),
  asset = new GLTFAsset(doc, [bytes.subarray(28 + jsonLength)]),
  radius = 0.10465342044830322,
  distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
const pupilBounds = [0, 1].map(() => ({ minimum: [Infinity, Infinity, Infinity],
  maximum: [-Infinity, -Infinity, -Infinity], vertices: 0, frontNormals: 0, rigidHead: true })),
  headSlot = doc.skins[0].joints.findIndex(index => doc.nodes[index].name === 'Head');
for (const node of doc.nodes) {
  if (node.skin === undefined || node.mesh === undefined) continue;
  for (const primitive of doc.meshes[node.mesh].primitives) {
    if (doc.materials[primitive.material].name !== 'Light keeper / amber optical glow') continue;
    const positions = asset.accessor(primitive.attributes.POSITION, 'VEC3'),
      normals = asset.accessor(primitive.attributes.NORMAL, 'VEC3'),
      joints = asset.accessor(primitive.attributes.JOINTS_0, 'VEC4'),
      weights = asset.accessor(primitive.attributes.WEIGHTS_0, 'VEC4');
    for (let offset = 0; offset < positions.length; offset += 3) {
      const bound = pupilBounds[positions[offset] < 0 ? 0 : 1];
      bound.vertices++;
      if (positions[offset + 2] < -.2329 && normals[offset + 2] < -.999) bound.frontNormals++;
      let sum = 0;
      for (let influence = 0; influence < 4; influence++) {
        const index = offset / 3 * 4 + influence;
        sum += weights[index];
        if (weights[index] > 0 && joints[index] !== headSlot) bound.rigidHead = false;
      }
      if (Math.abs(sum - 1) > 1e-7) bound.rigidHead = false;
      for (let axis = 0; axis < 3; axis++) {
        bound.minimum[axis] = Math.min(bound.minimum[axis], positions[offset + axis]);
        bound.maximum[axis] = Math.max(bound.maximum[axis], positions[offset + axis]);
      }
    }
  }
}
const opticalMidpoint = [0, 1, 2].map(axis => pupilBounds.reduce((sum, bound) =>
  sum + (bound.minimum[axis] + bound.maximum[axis]) / 2, 0) / 2);

async function robot(transformed = false, reserve = .001) {
  const store = await TransformStore.create(64),
    engine = new Engine({ width: 1, height: 1, clientWidth: 1, clientHeight: 1 }, store, {
      backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {},
    }),
    root = engine.createMesh(),
    nodes = doc.nodes.map(node => engine.createMesh().setParent(root)
      .setPosition(node.translation ?? [0, 0, 0]).setQuaternion(node.rotation ?? [0, 0, 0, 1])
      .setScale(node.scale ?? [1, 1, 1]));
  doc.nodes.forEach((node, i) => node.children?.forEach(child => nodes[child].setParent(nodes[i])));
  if (transformed) root.setPosition([2, -.3, 1]).setRotation([.25, -.55, .17]).setScale([1.7, 1.7, 1.7]);
  store.tick(false);
  const named = name => nodes[doc.nodes.findIndex(node => node.name === name)],
    body = named('Body'), head = named('Head'), shoulder = named('UpperArm'),
    elbow = named('Forearm'), wrist = named('Hand'), torso = new TorsoAim(body, root),
    armHead = new ArmHeadClearance(torso.frame, head, shoulder, elbow),
    homeWrist = localPoint(root, worldPosition(wrist)),
    home = [homeWrist[0], homeWrist[1] + .13, homeWrist[2]],
    localGrip = localPoint(wrist, gripPosition(root, home)),
    optical = localPoint(head, gripPosition(root, opticalMidpoint)),
    aim = new HeadAim(head, optical, 1.3, {
      min: [-.194, -.039, -.236], max: [.194, .307, .134],
      targetRadius: radius, margin: .003, chestFloor: -.032, chestPoints: cowlingHull,
      rotationClearance: (rotation, out) => armHead.evaluate(rotation, out),
    }),
    gaze = new GazeTarget(head, root, optical, { front: -.236, targetRadius: radius, margin: .003, reserve }),
    tracking = { enabled: true, constraintEnabled: false },
    gazeClearance = new Float64Array(1),
    solver = new BodyIK({ frame: torso.frame, shoulder, elbow, wrist, localGrip,
      head, armHeadClearance: armHead,
      extraClearance(orb, out) {
        if (tracking.enabled) aim.update(orb);
        else aim.reset(orb);
        out[0] = aim.headClearance;
        if (tracking.enabled && tracking.constraintEnabled) {
          gaze.clearance(orb, gazeClearance);
          out[0] = Math.min(out[0], gazeClearance[0]);
        }
      },
    }),
    lengths = [distance(worldPosition(shoulder), worldPosition(elbow)),
      distance(worldPosition(elbow), worldPosition(wrist))];
  return { engine, store, root, body, head, shoulder, elbow, wrist, torso, aim, solver, optical, lengths,
    initialRootScale: transformed ? 1.7 : 1,
    localGrip, gaze, tracking, motion: new TargetMotion(gripPosition(root, home)), route: new ArmControlRoute(),
    acceptedLocal: [...home], acceptedTorso: localPoint(torso.frame, gripPosition(root, home)),
    goal: [0, 0, 0], routeGoal: [0, 0, 0], held: [0, 0, 0], waypoint: [0, 0, 0],
    conditioned: [0, 0, 0], command: [0, 0, 0], transportStep: 0,
    controls: { ik: true, auto: true },
    animated: [body, head, shoulder, elbow, wrist].map(node => ({ node, rotation: rotation(node) })),
    savedArm: [shoulder, elbow, wrist].map(rotation) };
}
function rotation(node) {
  const t = node.engine.store.transforms, id = node.id;
  return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
}

// Independent measurement from the presented Head world matrix and the
// authored binocular optical midpoint/direction, rather than diagnostic fields.
function opticalRay(rig, target) {
  rig.store.tick(false);
  const origin = gripPosition(rig.head, rig.optical),
    ahead = gripPosition(rig.head, [rig.optical[0], rig.optical[1], rig.optical[2] - .1]),
    delta = ahead.map((value, i) => value - origin[i]), length = Math.hypot(...delta),
    forward = delta.map(value => value / length),
    demand = target.map((value, i) => value - origin[i]),
    along = demand.reduce((sum, value, i) => sum + value * forward[i], 0),
    perpendicular = Math.hypot(...demand.map((value, i) => value - along * forward[i]));
  return { origin, forward, along, perpendicular,
    error: Math.atan2(perpendicular, along), distance: along < 0 ? Math.hypot(...demand) : perpendicular };
}
function step(rig, requested, dt = 1 / 60) {
  // WorkshopAnimator restores authored input quaternions before the pose
  // controller. Its transient wrist is not the previously presented grip.
  for (const { node, rotation } of rig.animated) node.setQuaternion(rotation);
  rig.store.tick(false);
  rig.torso.applyHeld();
  if (!rig.tracking.enabled) rig.tracking.constraintEnabled = false;
  if (dt > 0 && rig.controls.ik && rig.controls.auto) {
    let goal = gripPosition(rig.root, requested, rig.goal);
    if (rig.route.active) {
      const reached = rig.tracking.enabled
        ? rig.gaze.projectLocal(rig.route.position, rig.routeGoal) : rig.route.position;
      const waypoint = rig.route.update(rig.acceptedLocal, dt, reached);
      goal = gripPosition(rig.root, waypoint, rig.goal);
    }
    if (rig.tracking.enabled) goal = rig.gaze.project(goal, rig.conditioned);
    else for (let i = 0; i < 3; i++) rig.conditioned[i] = goal[i];
    let command = rig.motion.update(goal, dt);
    for (let i = 0; i < 3; i++) rig.command[i] = command[i];
    const beforeTorso = localPoint(rig.root, gripPosition(rig.torso.frame, rig.acceptedTorso));
    rig.torso.update(localPoint(rig.root, command), dt);
    const accepted = gripPosition(rig.torso.frame, rig.acceptedTorso, rig.held);
    rig.transportStep = distance(beforeTorso, localPoint(rig.root, accepted));
    if (rig.tracking.enabled) {
      rig.gaze.beginStep(accepted);
      rig.tracking.constraintEnabled = true;
      command = rig.gaze.waypoint(accepted, command, rig.motion.maxSpeed * dt, rig.waypoint);
    }
    rig.solver.solve(command, dt);
  } else if (rig.controls.ik)
    [rig.shoulder, rig.elbow, rig.wrist].forEach((node, i) => node.setQuaternion(rig.savedArm[i]));
  const result = rig.solver.enforce();
  if (rig.controls.ik) rig.savedArm = [rig.shoulder, rig.elbow, rig.wrist].map(rotation);
  localPoint(rig.root, result.orb, rig.acceptedLocal);
  localPoint(rig.torso.frame, result.orb, rig.acceptedTorso);
  rig.aim.checkClearance(result.orb);
  return result;
}
function settle(rig, requested, requireArrival = true) {
  let result;
  for (let frame = 0; frame < 300; frame++) {
    result = step(rig, requested);
    if (frame >= 20 && distance(result.orb, rig.conditioned) < .0015 && rig.motion.settled &&
      Math.abs(rig.torso.yaw - rig.torso.desiredYaw) < 1e-5) break;
  }
  if (requireArrival) {
    assert.equal(rig.motion.settled, true, 'clear conditioned command must settle');
    assert.ok(distance(result.orb, rig.conditioned) < .002,
      `clear conditioned endpoint was not reached: ${JSON.stringify({ requested, conditioned: rig.conditioned, orb: result.orb })}`);
  }
  return result;
}
function verify(rig, result) {
  assert.equal(result.safe, true);
  assert.equal(rig.aim.clearanceResolved, true);
  assert.ok(rig.aim.headClearance >= 0, `head clearance ${rig.aim.headClearance}`);
  const scaleRatio = rig.store.transforms.sx[rig.root.id] / rig.initialRootScale;
  assert.ok(Math.abs(distance(worldPosition(rig.shoulder), worldPosition(rig.elbow)) - rig.lengths[0] * scaleRatio) < 3e-6);
  assert.ok(Math.abs(distance(worldPosition(rig.elbow), worldPosition(rig.wrist)) - rig.lengths[1] * scaleRatio) < 3e-6);
  const ray = opticalRay(rig, result.orb);
  const presentedHead = [...rig.head.matrix];
  assert.ok(Math.abs(ray.error - rig.aim.rayError) < 2e-5, 'diagnostics must describe the presented optics');
  assert.ok(Math.abs(ray.distance - rig.aim.rayDistance) < 2e-6);
  assert.equal(rig.solver.collision(), null);
  assert.deepEqual([...rig.head.matrix], presentedHead, 'a clearance audit must not repair a stale presented gaze');
  return ray;
}

test('the measured optical midpoint and forward axis match the actual exported binocular pupils', () => {
  for (const [side, bound] of pupilBounds.entries()) {
    assert.ok(bound.vertices > 0);
    assert.equal(bound.rigidHead, true, 'pupil solids must follow the tested Head transform rigidly');
    assert.ok(bound.frontNormals > 0, 'the outer pupil faces point along authored -Z');
    const center = bound.minimum.map((value, axis) => (value + bound.maximum[axis]) / 2);
    assert.ok(distance(center, [side ? .074 : -.074, 1.34, -.232]) < 2e-6);
    assert.ok(bound.maximum[0] - bound.minimum[0] > .016);
    assert.ok(bound.maximum[1] - bound.minimum[1] > .016);
    assert.ok(bound.maximum[2] - bound.minimum[2] < .0021, 'pupil faces are perpendicular to authored -Z');
  }
});

test('near-face cross-body requests do not accept a safe arm by turning the eyes away from its orb', async t => {
  const rig = await robot(), records = [];
  t.after(() => {
    writeFileSync('test-results/skinning-ik-gaze-near-face.json', JSON.stringify(records, null, 2));
    rig.engine.dispose();
  });
  // The first free target is captured from the live pointer reproduction:
  // Home -> side .97 -> drag near the neck. The original handoff reports a
  // safe arm while its optical ray points 103.46 degrees away from the orb.
  for (const requested of [mapArmControl('side', .5), mapArmControl('side', .97),
    [.07209322601556778, 1.2092939615249634, -.2827683687210083], mapArmControl('side', .88),
    [0, 1.18, -.25], mapArmControl('side', 1), [.05, 1.2, -.25], mapArmControl('side', .5)]) {
    const result = settle(rig, requested), ray = verify(rig, result);
    records.push({ requested, orb: [...result.orb], yaw: rig.torso.yaw,
      ray, limited: rig.aim.limited, headClearance: rig.aim.headClearance });
    assert.ok(ray.along > 0, `accepted near-face orb must remain ahead of the eyes: ${JSON.stringify(records.at(-1))}`);
    if (requested[0] === .235)
      assert.ok(Math.abs(localPoint(rig.root, result.orb)[0] - .235) < .002, 'retain the full opposite-side reach');
  }
});

test('presented optical rays track clear cross-body targets through torso yaw, reversal and transformed roots', async t => {
  for (const transformed of [false, true]) {
    const rig = await robot(transformed);
    t.after(() => rig.engine.dispose());
    for (const parameter of [.5, .7, .8, .88, .94, .88, .8, .7, .5]) {
      const requested = mapArmControl('side', parameter), result = settle(rig, requested), ray = verify(rig, result);
      assert.ok(ray.along > 0 && ray.perpendicular < 3e-6, `clear target ${parameter}: ${JSON.stringify(ray)}`);
      assert.equal(rig.aim.limited, false);
      const before = [...rig.head.matrix];
      for (let probe = 0; probe < 3; probe++) rig.aim.update(result.orb);
      assert.deepEqual([...rig.head.matrix], before, 'secondary render updates must preserve the accepted gaze');
    }
  }
});

test('targets beyond neck travel report bounded imperfect gaze rather than claiming exact optical alignment', async t => {
  const rig = await robot(true);
  t.after(() => rig.engine.dispose());
  for (const point of [[0, 1.2, 2], [-2, 1.3, .5]]) {
    const target = gripPosition(rig.root, point);
    rig.aim.update(target);
    const ray = opticalRay(rig, target);
    assert.equal(rig.aim.limited, true);
    assert.ok(Number.isFinite(ray.error) && ray.error > 1e-3);
    assert.ok(rig.aim.angle <= rig.aim.maxAngle + 1e-7);
    assert.ok(Math.abs(ray.error - rig.aim.rayError) < 2e-5);
    assert.equal(rig.aim.clearanceResolved, true);
    assert.ok(rig.aim.headClearance >= 0);
  }
});

function retainedState(rig) {
  return {
    yaw: rig.torso.yaw, desiredYaw: rig.torso.desiredYaw,
    motion: [...rig.motion.position], velocity: [...rig.motion.velocity], settled: rig.motion.settled,
    route: [...rig.route.position], cursor: rig.route.cursor, routing: rig.route.active,
    routeSettled: rig.route.settled, accepted: [...rig.acceptedLocal],
    head: [...rig.head.matrix], shoulder: [...rig.shoulder.matrix],
    elbow: [...rig.elbow.matrix], wrist: [...rig.wrist.matrix],
  };
}

test('rapid front reversals and filter chords keep every presented frame clear without gaze-away or reflection history advances', async t => {
  const rig = await robot(), records = [];
  t.after(() => {
    writeFileSync('test-results/skinning-ik-gaze-reversals.json', JSON.stringify(records, null, 2));
    rig.engine.dispose();
  });
  settle(rig, mapArmControl('side', .5));
  let previous = [...rig.acceptedLocal];
  for (let frame = 0; frame < 300; frame++) {
    const requested = frame < 70 ? mapArmControl('side', 1)
      : frame < 100 ? [.07209322601556778, 1.2092939615249634, -.2827683687210083]
      : frame < 130 ? mapArmControl('side', .5) : frame < 160 ? mapArmControl('side', 1)
      : frame < 210 ? [0, 1.18, -.25] : mapArmControl('side', .5),
      result = step(rig, requested), ray = verify(rig, result), accepted = [...rig.acceptedLocal],
      handStep = distance(previous, accepted), limit = rig.motion.maxSpeed / 60 + rig.transportStep;
    records.push({ frame, requested, conditioned: [...rig.conditioned], command: [...rig.command],
      accepted, handStep, limit, error: ray.error, headClearance: rig.aim.headClearance });
    assert.ok(ray.along > 0, `frame ${frame} looks away from accepted orb`);
    assert.ok(handStep <= limit + 5e-5, `frame ${frame} hand step ${handStep} exceeds command + torso transport ${limit}`);
    if (frame % 13 === 0) {
      const before = retainedState(rig);
      for (let probe = 0; probe < 3; probe++) verify(rig, step(rig, requested, 0));
      assert.deepEqual(retainedState(rig), before, 'unchanged zero-delta frames must not advance any motion history');
    }
    previous = accepted;
  }
  assert.ok(distance(rig.acceptedLocal, mapArmControl('side', .5)) < .002, 'reversal must recover to Home');
});

test('enabling gaze while already close recovers outward without resetting the arm or invalidating the first held pose', async t => {
  const rig = await robot(), requested = [.07209322601556778, 1.2092939615249634, -.2827683687210083], records = [];
  t.after(() => {
    writeFileSync('test-results/skinning-ik-gaze-toggle.json', JSON.stringify(records, null, 2));
    rig.engine.dispose();
  });
  rig.tracking.enabled = false;
  verify(rig, settle(rig, requested, false));
  let previous = [...rig.acceptedLocal];
  const beforeRadius = distance(gripPosition(rig.wrist, rig.localGrip), worldPosition(rig.head));
  assert.ok(beforeRadius < rig.gaze.minimumRadius, 'exercise a truly inside-workspace look-off pose');
  rig.tracking.enabled = true;
  // A control edit may revalidate on a zero-delta render, but cannot solve a
  // new arm trajectory or advance the target filter in that render.
  const motionBefore = [...rig.motion.position];
  const held = step(rig, requested, 0);
  assert.equal(held.safe, true);
  assert.ok(distance(previous, rig.acceptedLocal) < 2e-6, 'look edit must not reset the held arm');
  assert.deepEqual([...rig.motion.position], motionBefore);
  for (let frame = 0; frame < 120; frame++) {
    const result = step(rig, requested), ray = verify(rig, result), accepted = [...rig.acceptedLocal],
      handStep = distance(previous, accepted), limit = rig.motion.maxSpeed / 60 + rig.transportStep;
    records.push({ frame, accepted, handStep, limit, error: ray.error, clearance: rig.aim.headClearance });
    assert.ok(handStep <= limit + 5e-5, 're-enabling gaze must chase rather than teleport the arm');
    if (frame >= 60) assert.ok(ray.along > 0, 'gaze must recover while the close raw target remains held');
    previous = accepted;
  }
  assert.ok(distance(gripPosition(rig.wrist, rig.localGrip), worldPosition(rig.head)) >= rig.gaze.minimumRadius - 3e-6);
});

test('moving model roots revalidate gaze geometry while final model-local hand steps remain bounded', async t => {
  const rig = await robot(true), requested = [.07209322601556778, 1.2092939615249634, -.2827683687210083];
  t.after(() => rig.engine.dispose());
  verify(rig, settle(rig, requested));
  let previous = [...rig.acceptedLocal];
  for (let frame = 0; frame < 90; frame++) {
    rig.root.setPosition([2 + .05 * Math.sin(frame * .02), -.3, 1])
      .setRotation([.25 + .02 * Math.sin(frame * .03), -.55 + .1 * Math.sin(frame * .02), .17]);
    const result = step(rig, requested), ray = verify(rig, result), accepted = [...rig.acceptedLocal],
      handStep = distance(previous, accepted), limit = rig.motion.maxSpeed / 60 / 1.7 + rig.transportStep;
    assert.ok(ray.along > 0);
    assert.ok(handStep <= limit + 5e-5, `moving root frame ${frame}: ${handStep} > ${limit}`);
    previous = accepted;
  }
});

test('conditioned route waypoints complete without replacing raw coordinates or latching on their offset', async t => {
  // A supported larger reserve makes the authored side endpoint require a
  // measurable projection, so raw-waypoint arrival would otherwise deadlock.
  const rig = await robot(false, .02), requested = mapArmControl('side', 1);
  t.after(() => rig.engine.dispose());
  rig.route.request('side', 1, rig.acceptedLocal);
  let projectedWaypoint = false, result, frames = 0;
  for (; frames < 600; frames++) {
    const raw = [...rig.route.position], projected = rig.gaze.projectLocal(raw, [0, 0, 0]);
    projectedWaypoint ||= distance(raw, projected) > .002;
    result = step(rig, requested);
    verify(rig, result);
    if (rig.route.settled && rig.motion.settled) break;
  }
  assert.equal(projectedWaypoint, true, 'exercise a route waypoint that differs from its conditioned destination');
  assert.ok(frames < 600, 'the route must complete against its conditioned waypoint');
  assert.deepEqual([...rig.route.position], requested, 'conditioning must retain the raw authored route endpoint');
  assert.ok(Math.abs(rig.acceptedLocal[0] - .235) < .002, 'full opposite-side X reach must remain available');
  assert.ok(distance(result.orb, rig.conditioned) < .002);
});

test('no-solve and zero-delta audits refresh a changed parent frame and scale without advancing recovery history', async t => {
  for (const mode of ['auto-off', 'ik-off', 'partial-recovery']) {
    const rig = await robot(true), requested = mapArmControl('side', 1);
    t.after(() => rig.engine.dispose());
    if (mode === 'partial-recovery') {
      rig.tracking.enabled = false;
      const close = [.07209322601556778, 1.2092939615249634, -.2827683687210083];
      verify(rig, settle(rig, close, false));
      rig.tracking.enabled = true;
      verify(rig, step(rig, close));
    } else verify(rig, settle(rig, requested));
    rig.controls.auto = false;
    if (mode === 'ik-off') rig.controls.ik = false;
    const firstHeld = step(rig, requested, 0);
    verify(rig, firstHeld);
    const firstGap = new Float64Array(1), firstScale = rig.store.transforms.sx[rig.root.id];
    rig.gaze.clearance(firstHeld.orb, firstGap);
    const effectiveGuard = (distance(firstHeld.orb, worldPosition(rig.head)) - firstGap[0]) / firstScale;
    if (mode === 'partial-recovery')
      assert.ok(effectiveGuard < rig.gaze.minimumRadius - .001, 'exercise a partially recovered guard');
    const accepted = [...rig.acceptedLocal],
      motion = [...rig.motion.position], velocity = [...rig.motion.velocity],
      yaw = rig.torso.yaw, desiredYaw = rig.torso.desiredYaw,
      route = [...rig.route.position], cursor = rig.route.cursor;
    for (const [position, rotation, scale] of [
      [[5, -.7, -2], [.15, .4, -.2], .8],
      [[-1, 1.2, 4], [-.2, -.7, .1], 2.2],
      [[2, -.3, 1], [.25, -.55, .17], 1.7],
    ]) {
      rig.root.setPosition(position).setRotation(rotation).setScale([scale, scale, scale]);
      for (const dt of [0, 1 / 60, 0]) {
        const result = step(rig, requested, dt), ray = verify(rig, result), gap = new Float64Array(1);
        if (mode !== 'partial-recovery') assert.ok(ray.along > 0);
        assert.ok(distance(accepted, rig.acceptedLocal) < 4e-6, `${mode}: parent transport must not reset the arm`);
        rig.gaze.clearance(result.orb, gap);
        const actualScale = rig.store.transforms.sx[rig.root.id],
          authoredGap = distance(result.orb, worldPosition(rig.head)) / actualScale - effectiveGuard;
        assert.ok(Math.abs(gap[0] / actualScale - authoredGap) < 3e-6,
          `${mode}: no-solve gaze query used a stale pivot or scale`);
        assert.deepEqual([...rig.motion.position], motion);
        assert.deepEqual([...rig.motion.velocity], velocity);
        assert.equal(rig.torso.yaw, yaw);
        assert.equal(rig.torso.desiredYaw, desiredYaw);
        assert.deepEqual([...rig.route.position], route);
        assert.equal(rig.route.cursor, cursor);
      }
    }
  }
});
