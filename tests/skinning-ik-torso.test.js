import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset } from '../packages/gltf-pro/dist/index.js';
import { multiplyMatrices } from '@margoengine/math/mat4';
import { gripPosition, localPoint, worldPosition } from '../examples/skinning-ik/rig-ik.ts';
import { HeadAim } from '../examples/skinning-ik/head-aim.ts';
import { mapArmControl } from '../examples/skinning-ik/arm-controls.ts';
import { cowlingHull } from '../examples/skinning-ik/head-aim-shape.ts';
import { TargetMotion } from '../examples/skinning-ik/target-motion.ts';
import {
  triangleTree,
  meshSurfaceDistance,
  pointSurfaceDistance,
  transformPoint,
} from './support/skinning-ik-clearance.js';

mkdirSync(resolve('test-results'), { recursive: true });
const temporary = mkdtempSync(resolve('test-results/ik-torso-'));
const bundle = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: {
    write: false,
    target: 'es2022',
    minify: false,
    lib: {
      entry: {
        body: resolve('examples/skinning-ik/body-ik.ts'),
        torso: resolve('examples/skinning-ik/torso-aim.ts'),
        route: resolve('examples/skinning-ik/arm-control-route.ts'),
        armHead: resolve('examples/skinning-ik/arm-head-clearance.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: { external: (id) => id.startsWith('@margoengine/') },
  },
});
for (const entry of bundle[0].output) writeFileSync(join(temporary, entry.fileName), entry.code);
const { BodyIK } = await import(pathToFileURL(join(temporary, 'body.js')).href);
const { TorsoAim } = await import(pathToFileURL(join(temporary, 'torso.js')).href);
const { ArmControlRoute } = await import(pathToFileURL(join(temporary, 'route.js')).href);
const { ArmHeadClearance } = await import(pathToFileURL(join(temporary, 'armHead.js')).href);
for (const entry of bundle[0].output) unlinkSync(join(temporary, entry.fileName));
rmdirSync(temporary);
const bytes = readFileSync(new URL('../examples/assets/skinning-ik.glb', import.meta.url));
const doc = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
const asset = new GLTFAsset(doc, [bytes.subarray(28 + bytes.readUInt32LE(12))]);
const headClearance = {
  min: [-0.194, -0.039, -0.236],
  max: [0.194, 0.307, 0.134],
  targetRadius: 0.10465342044830322,
  margin: 0.003,
  chestFloor: -0.032,
  cowlingMinY: 0.039,
  chestPoints: cowlingHull,
};
const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
const quaternion = (mesh) => {
  const t = mesh.engine.store.transforms,
    id = mesh.id;
  return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
};
const translation = (mesh) => [mesh.position.x, mesh.position.y, mesh.position.z];
async function robot(transformed = false, physical = false) {
  const store = await TransformStore.create(64),
    engine = new Engine({ width: 256, height: 256, clientWidth: 256, clientHeight: 256 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    root = engine.createMesh();
  const nodes = doc.nodes.map((node) =>
    engine
      .createMesh()
      .setParent(root)
      .setPosition(node.translation ?? [0, 0, 0])
      .setQuaternion(node.rotation ?? [0, 0, 0, 1])
      .setScale(node.scale ?? [1, 1, 1]),
  );
  doc.nodes.forEach((node, i) => node.children?.forEach((child) => nodes[child].setParent(nodes[i])));
  if (transformed) root.setPosition([2, -0.3, 1]).setRotation([0.25, -0.55, 0.17]).setScale([1.7, 1.7, 1.7]);
  store.tick(false);
  const named = (name) => nodes[doc.nodes.findIndex((node) => node.name === name)],
    body = named('Body'),
    shoulder = named('UpperArm'),
    otherShoulder = named('RightUpperArm'),
    elbow = named('Forearm'),
    wrist = named('Hand'),
    head = named('Head'),
    start = localPoint(root, worldPosition(wrist)),
    home = [start[0], start[1] + 0.13, start[2]],
    localGrip = localPoint(wrist, gripPosition(root, home)),
    torso = new TorsoAim(body, root),
    armHeadClearance = physical ? new ArmHeadClearance(torso.frame, head, shoulder, elbow) : undefined,
    headAim = physical
      ? new HeadAim(head, [0, 0.19, -0.232], 1.3, {
          ...headClearance,
          rotationClearance: (rotation, out) => armHeadClearance.evaluate(rotation, out),
        })
      : undefined,
    tracking = { enabled: true },
    solver = new BodyIK({
      frame: torso.frame,
      shoulder,
      elbow,
      wrist,
      localGrip,
      head: physical ? head : undefined,
      armHeadClearance,
      extraClearance: physical
        ? (orb, out) => {
            if (tracking.enabled) headAim.update(orb);
            else headAim.reset(orb);
            out[0] = headAim.headClearance;
          }
        : undefined,
    });
  const authored = [shoulder, otherShoulder, head].map((mesh) => localPoint(torso.frame, worldPosition(mesh))),
    locals = [body, shoulder, otherShoulder, elbow, wrist, head].map(translation),
    lengths = [
      distance(worldPosition(shoulder), worldPosition(elbow)),
      distance(worldPosition(elbow), worldPosition(wrist)),
    ];
  return {
    engine,
    store,
    root,
    body,
    shoulder,
    otherShoulder,
    elbow,
    wrist,
    head,
    localGrip,
    torso,
    solver,
    headAim,
    armHeadClearance,
    tracking,
    nodes,
    home,
    authored,
    locals,
    lengths,
  };
}
function step(rig, target, dt = 1 / 60) {
  const before = rig.torso.yaw;
  rig.torso.update(target, dt);
  assert.ok(Math.abs(rig.torso.yaw - before) <= 1.6 * dt + 1e-12);
  const worldTarget = gripPosition(rig.root, target),
    result = rig.solver.solve(worldTarget, dt);
  assert.equal(result.safe, true);
  assert.equal(rig.solver.collision(), null);
  const upper = distance(worldPosition(rig.shoulder), worldPosition(rig.elbow)),
    lower = distance(worldPosition(rig.elbow), worldPosition(rig.wrist));
  assert.ok(Math.abs(upper - rig.lengths[0]) < 2e-6 && Math.abs(lower - rig.lengths[1]) < 2e-6);
  for (const [i, mesh] of [rig.shoulder, rig.otherShoulder, rig.head].entries()) {
    assert.ok(
      distance(worldPosition(mesh), gripPosition(rig.torso.frame, rig.authored[i])) < 2e-6,
      'Shoulders and head must remain attached to the same moving torso frame',
    );
  }
  return { result, residual: distance(result.orb, worldTarget) };
}
function settle(rig, target) {
  let value;
  for (let i = 0; i < 150; i++) {
    value = step(rig, target);
    if (value.residual < 0.0015 && Math.abs(rig.torso.yaw - rig.torso.desiredYaw) < 1e-5) break;
  }
  return value;
}

test('no-reset changes between complete control tracks remain reachable with head tracking', async (t) => {
  const rig = await robot(false, true),
    motion = new TargetMotion(gripPosition(rig.root, rig.home)),
    route = new ArmControlRoute(),
    records = [];
  t.after(() => {
    writeFileSync('test-results/skinning-ik-control-transitions.json', JSON.stringify(records, null, 2));
    rig.engine.dispose();
  });
  const endpoints = [
      ['side', 0],
      ['side', 1],
      ['height', 0],
      ['height', 1],
      ['nearFar', 0],
      ['nearFar', 1],
    ],
    sequence = [];
  for (const from of endpoints) for (const to of endpoints) if (from !== to) sequence.push(from, to);
  for (const tracking of [true, false]) {
    rig.tracking.enabled = tracking;
    for (const [control, parameter] of sequence) {
      const goal = mapArmControl(control, parameter);
      route.request(control, parameter, localPoint(rig.root, gripPosition(rig.wrist, rig.localGrip)));
      let residual = Infinity,
        frames = 0;
      for (; frames < 300; frames++) {
        const accepted = localPoint(rig.root, gripPosition(rig.wrist, rig.localGrip)),
          waypoint = route.update(accepted, 1 / 60),
          command = motion.update(gripPosition(rig.root, waypoint), 1 / 60);
        step(rig, localPoint(rig.root, command));
        rig.solver.enforce();
        residual = distance(gripPosition(rig.wrist, rig.localGrip), gripPosition(rig.root, goal));
        if (residual < 0.002 && motion.settled && route.settled) break;
      }
      records.push({
        tracking,
        control,
        parameter,
        residual,
        frames,
        command: [...motion.position],
        waypoint: [...route.position],
        orb: gripPosition(rig.wrist, rig.localGrip),
        yaw: rig.torso.yaw,
      });
      assert.ok(residual < 0.002, `${control} ${parameter} transition stalled ${residual}m after ${frames} frames`);
    }
  }
});

test('interrupted route changes recover under transformed roots and reflection updates hold every motion history', async (t) => {
  for (const transformed of [false, true]) {
    const rig = await robot(transformed, true),
      route = new ArmControlRoute(),
      motion = new TargetMotion(gripPosition(rig.root, rig.home));
    t.after(() => rig.engine.dispose());
    const advance = (dt) => {
      const accepted = localPoint(rig.root, gripPosition(rig.wrist, rig.localGrip)),
        waypoint = route.update(accepted, dt),
        command = motion.update(gripPosition(rig.root, waypoint), dt);
      if (dt > 0) step(rig, localPoint(rig.root, command), dt);
      else rig.torso.update(localPoint(rig.root, command), 0);
      const held = rig.solver.enforce();
      assert.equal(held.safe, true);
      return held;
    };
    const controls = ['side', 'height', 'nearFar'],
      deltas = [1 / 120, 1 / 30, 1 / 60, 0.05];
    for (let change = 0; change < 90; change++) {
      const control = controls[change % controls.length],
        parameter = change % 2;
      route.request(control, parameter, localPoint(rig.root, gripPosition(rig.wrist, rig.localGrip)));
      for (let frame = 0; frame < 1 + (change % 9); frame++) {
        advance(deltas[(change + frame) % deltas.length]);
        const waypoint = [...route.position],
          command = [...motion.position],
          yaw = rig.torso.yaw,
          orb = gripPosition(rig.wrist, rig.localGrip);
        for (let probe = 0; probe < 3; probe++) advance(0);
        assert.deepEqual(route.position, waypoint);
        assert.deepEqual(motion.position, command);
        assert.equal(rig.torso.yaw, yaw);
        assert.ok(distance(gripPosition(rig.wrist, rig.localGrip), orb) < 2e-6);
      }
    }
    const goal = mapArmControl('height', 1);
    route.request('height', 1, localPoint(rig.root, gripPosition(rig.wrist, rig.localGrip)));
    for (let frame = 0; frame < 480 && (!route.settled || !motion.settled); frame++) advance(1 / 60);
    assert.ok(
      distance(gripPosition(rig.wrist, rig.localGrip), gripPosition(rig.root, goal)) < 0.002,
      'interrupted commands must recover the requested endpoint without a reset',
    );
  }
});

test('actual torso assist reaches the opposite chest side without stretching or detaching either shoulder', async (t) => {
  const rig = await robot();
  t.after(() => rig.engine.dispose());
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(rig.torso.frame.matrix[i] - rig.root.matrix[i]) < 1e-6);
  const value = settle(rig, [0.235, 1.16, -0.3]);
  assert.ok(value.residual < 0.002, `Opposite-side residual ${value.residual}`);
  assert.ok(rig.torso.yaw < -0.8 && rig.torso.yaw >= -0.85);
  assert.deepEqual(
    [rig.body, rig.shoulder, rig.otherShoulder, rig.elbow, rig.wrist, rig.head].map(translation),
    rig.locals,
  );
});

test('full-width side path and return remain reachable with the authored body guard', async (t) => {
  const rig = await robot(false, true);
  t.after(() => rig.engine.dispose());
  const records = [];
  for (let sample = 0; sample <= 80; sample++) {
    const parameter = sample <= 40 ? sample / 40 : (80 - sample) / 40;
    const target = mapArmControl('side', parameter),
      value = settle(rig, target);
    records.push({ parameter, target, yaw: rig.torso.yaw, residual: value.residual, orb: value.result.orb });
    assert.ok(value.residual < 0.002, `Path ${parameter}, yaw ${rig.torso.yaw}: ${value.residual}`);
  }
  writeFileSync('test-results/skinning-ik-torso-path.json', JSON.stringify(records, null, 2));
});

test('torso collision frame and opposite-side reach follow a transformed uniformly scaled model', async (t) => {
  const rig = await robot(true);
  t.after(() => rig.engine.dispose());
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(rig.torso.frame.matrix[i] - rig.root.matrix[i]) < 2e-6);
  assert.ok(settle(rig, [0.235, 1.16, -0.3]).residual < 0.002);
  rig.root.setPosition([-1, 0.5, -2]).setRotation([-0.1, 0.3, -0.2]);
  rig.store.tick(false);
  assert.ok(settle(rig, [0.235, 1.16, -0.3]).residual < 0.002);
});

test('reflection and manual hold reapply accepted torso yaw without advancing history, and reset restores rest', async (t) => {
  const rig = await robot();
  t.after(() => rig.engine.dispose());
  const rest = quaternion(rig.body);
  settle(rig, [0.235, 1.16, -0.3]);
  const q = quaternion(rig.body),
    yaw = rig.torso.yaw,
    desired = rig.torso.desiredYaw;
  let writes = 0;
  const original = rig.body.setQuaternion;
  rig.body.setQuaternion = function (value) {
    writes++;
    return original.call(this, value);
  };
  for (let i = 0; i < 120; i++) {
    rig.torso.applyHeld();
    rig.torso.update(rig.home, 0);
  }
  assert.deepEqual(quaternion(rig.body), q);
  assert.equal(rig.torso.yaw, yaw);
  assert.equal(rig.torso.desiredYaw, desired);
  assert.equal(writes, 0);
  rig.body.setRotation([0, 0.03, 0]);
  rig.torso.applyHeld();
  assert.deepEqual(quaternion(rig.body), q);
  rig.torso.reset();
  rig.solver.reset();
  assert.deepEqual(quaternion(rig.body), rest);
  assert.equal(rig.torso.yaw, 0);
  assert.equal(rig.torso.desiredYaw, 0);
  assert.equal(rig.solver.collision(), null);
});

test('torso update rejects invalid inputs before changing its accepted state', async (t) => {
  const rig = await robot();
  t.after(() => rig.engine.dispose());
  const before = quaternion(rig.body);
  for (const target of [
    [NaN, 0, 0],
    [0, Infinity, 0],
    [1e40, 0, 0],
    ['1', 0, 0],
    [0, 0],
  ]) {
    assert.throws(() => rig.torso.update(target, 1 / 60));
    assert.equal(rig.torso.yaw, 0);
    assert.deepEqual(quaternion(rig.body), before);
  }
  for (const dt of [-1, Infinity, NaN]) assert.throws(() => rig.torso.update(rig.home, dt));
  rig.torso.update([-0.35 + 0.585e-4, 1.16, -0.3], 1e-12);
  assert.ok(Math.abs(rig.torso.yaw) <= 1.6e-12, 'Tiny dt cannot bypass the angular speed cap');
  const yaw = rig.torso.yaw,
    accepted = quaternion(rig.body);
  rig.root.setScale([1, 2, 1]);
  assert.throws(() => rig.torso.update([0.235, 1.16, -0.3], 1 / 60), /positive uniform/);
  assert.throws(() => rig.torso.applyHeld(), /positive uniform/);
  assert.equal(rig.torso.yaw, yaw);
  assert.deepEqual(quaternion(rig.body), accepted);
});

function actualSurfaces(rig) {
  const groups = { active: [], inactive: [], head: [], chin: [], body: [] };
  let blendedArmVertices = 0,
    bodyArmBlendVertices = 0;
  for (const node of doc.nodes) {
    if (node.skin === undefined || node.mesh === undefined) continue;
    const skin = doc.skins[node.skin],
      binds = asset.accessor(skin.inverseBindMatrices, 'MAT4'),
      matrices = skin.joints.map((joint, slot) => {
        const matrix = new Float64Array(16);
        multiplyMatrices(rig.nodes[joint].matrix, binds.subarray(slot * 16, slot * 16 + 16), matrix);
        return matrix;
      });
    for (const primitive of doc.meshes[node.mesh].primitives) {
      const attrs = primitive.attributes,
        positions = asset.accessor(attrs.POSITION, 'VEC3'),
        joints = asset.accessor(attrs.JOINTS_0, 'VEC4'),
        weights = asset.accessor(attrs.WEIGHTS_0, 'VEC4'),
        indices = asset.accessor(primitive.indices),
        vertices = [],
        names = [];
      for (let vertex = 0; vertex < positions.length / 3; vertex++) {
        const position = Array.from(positions.subarray(vertex * 3, vertex * 3 + 3)),
          posed = [0, 0, 0],
          influences = new Set();
        for (let k = 0; k < 4; k++) {
          const weight = weights[vertex * 4 + k];
          if (!weight) continue;
          const slot = joints[vertex * 4 + k],
            point = transformPoint(matrices[slot], position);
          for (let axis = 0; axis < 3; axis++) posed[axis] += weight * point[axis];
          influences.add(doc.nodes[skin.joints[slot]].name);
        }
        const list = [...influences],
          active = list.some((name) => ['UpperArm', 'Forearm', 'Hand'].includes(name));
        if (active && list.length > 1) blendedArmVertices++;
        if (active && influences.has('Body')) bodyArmBlendVertices++;
        vertices.push(posed);
        names.push(list);
      }
      for (let i = 0; i < indices.length; i += 3) {
        const ids = [indices[i], indices[i + 1], indices[i + 2]],
          triangle = ids.map((id) => vertices[id]),
          influences = [...new Set(ids.flatMap((id) => names[id]))];
        if (influences.every((name) => name === 'Body')) groups.body.push(triangle);
        else if (influences.every((name) => name === 'Head')) {
          groups.head.push(triangle);
          // The rigid collar intentionally seats through the chest. The visible
          // chin/cowling above the authored neck mount is a non-adjacent surface.
          if (ids.every((id) => positions[id * 3 + 1] > 1.185)) groups.chin.push(triangle);
        } else if (influences.every((name) => name.startsWith('Right'))) groups.inactive.push(triangle);
        else if (
          influences.some((name) => ['UpperArm', 'Forearm', 'Hand'].includes(name)) &&
          influences.every((name) => ['Body', 'UpperArm', 'Forearm', 'Hand'].includes(name))
        )
          groups.active.push(triangle);
      }
    }
  }
  return { groups, blendedArmVertices, bodyArmBlendVertices };
}

test('routed overhead and cross-track motion clears independently skinned head, chest and inactive-arm surfaces', async (t) => {
  const rig = await robot(false, true),
    route = new ArmControlRoute(),
    motion = new TargetMotion(gripPosition(rig.root, rig.home)),
    records = [];
  t.after(() => {
    writeFileSync(
      'test-results/skinning-ik-control-transition-clearance.json',
      JSON.stringify(
        {
          method:
            'Finite sampled actual skin triangle distances during routed motion, not continuous collision detection.',
          records,
        },
        null,
        2,
      ),
    );
    rig.engine.dispose();
  });
  for (const [control, parameter] of [
    ['side', 1],
    ['height', 1],
    ['height', 0],
    ['nearFar', 0],
    ['height', 1],
  ]) {
    const goal = mapArmControl(control, parameter);
    route.request(control, parameter, localPoint(rig.root, gripPosition(rig.wrist, rig.localGrip)));
    for (let frame = 0; frame < 300; frame++) {
      const accepted = localPoint(rig.root, gripPosition(rig.wrist, rig.localGrip)),
        command = motion.update(gripPosition(rig.root, route.update(accepted, 1 / 60)), 1 / 60);
      step(rig, localPoint(rig.root, command));
      rig.solver.enforce();
      const done = motion.settled && route.settled;
      if (frame % 20 === 0 || done) {
        const { groups } = actualSurfaces(rig),
          head = triangleTree(groups.head),
          body = triangleTree(groups.body),
          inactive = triangleTree(groups.inactive),
          orb = gripPosition(rig.wrist, rig.localGrip),
          closest = {},
          record = {
            control,
            parameter,
            frame,
            orb,
            orbHead: pointSurfaceDistance(orb, head) - headClearance.targetRadius,
            activeHead: meshSurfaceDistance(groups.active, head, closest),
            inactiveHead: meshSurfaceDistance(groups.inactive, head),
            chinBody: meshSurfaceDistance(groups.chin, body),
            activeInactive: meshSurfaceDistance(groups.active, inactive),
          };
        records.push(record);
        if (record.activeHead < 0.003) record.closestActiveHead = closest;
        for (const key of ['orbHead', 'activeHead', 'inactiveHead', 'chinBody', 'activeInactive'])
          assert.ok(record[key] >= 0.003, `${key}: ${JSON.stringify(record)}`);
      }
      if (done) {
        assert.ok(distance(gripPosition(rig.wrist, rig.localGrip), gripPosition(rig.root, goal)) < 0.002);
        break;
      }
      assert.ok(frame < 299, 'routed sampled motion must reach its endpoint');
    }
  }
});

test('sampled assist arc clears actual skinned inactive-arm and head surfaces with optical tracking enabled', async (t) => {
  const rig = await robot(false, true);
  t.after(() => rig.engine.dispose());
  const headAim = rig.headAim,
    records = [],
    radius = 0.10465342044830322;
  const samples = [0.5, 0.6, 0.7, 0.75, 0.8, 0.88, 0.94, 1, 0.88, 0.75, 0.5].map((parameter) =>
    mapArmControl('side', parameter),
  );
  samples.unshift(mapArmControl('side', 0));
  samples.push(
    mapArmControl('height', 0),
    mapArmControl('height', 1),
    mapArmControl('nearFar', 0),
    mapArmControl('nearFar', 1),
  );
  try {
    for (const target of samples) {
      const value = settle(rig, target);
      const { groups, blendedArmVertices, bodyArmBlendVertices } = actualSurfaces(rig),
        inactive = triangleTree(groups.inactive),
        head = triangleTree(groups.head),
        body = triangleTree(groups.body);
      assert.ok(blendedArmVertices > 0);
      const record = {
        target,
        orb: value.result.orb,
        residual: value.residual,
        yaw: rig.torso.yaw,
        headAngle: headAim.angle,
        headLimited: headAim.limited,
        blendedArmVertices,
        bodyArmBlendVertices,
        triangles: Object.fromEntries(Object.entries(groups).map(([name, triangles]) => [name, triangles.length])),
        orbInactive: pointSurfaceDistance(value.result.orb, inactive) - radius,
        orbHead: pointSurfaceDistance(value.result.orb, head) - radius,
        activeInactive: meshSurfaceDistance(groups.active, inactive),
        activeHead: meshSurfaceDistance(groups.active, head),
        chinBody: meshSurfaceDistance(groups.chin, body),
      };
      records.push(record);
    }
  } finally {
    writeFileSync('test-results/skinning-ik-torso-surface-clearance.json', JSON.stringify(records, null, 2));
  }
  for (const record of records) {
    assert.ok(record.residual < 0.002, `Physical target residual: ${JSON.stringify(record)}`);
    assert.ok(record.orbInactive > 0, `Orb/inactive arm: ${JSON.stringify(record)}`);
    assert.ok(record.orbHead > 0, `Orb/head: ${JSON.stringify(record)}`);
    assert.ok(record.activeInactive > 1e-6, `Active/inactive arm: ${JSON.stringify(record)}`);
    assert.ok(record.activeHead > 1e-6, `Active arm/head: ${JSON.stringify(record)}`);
    assert.ok(record.chinBody > 1e-6, `Chin/chest: ${JSON.stringify(record)}`);
  }
});

test('moving side samples retain at least the head margin before the torso or arm has settled', async (t) => {
  const rig = await robot(false, true);
  t.after(() => rig.engine.dispose());
  const aim = rig.headAim,
    records = [];
  // Verify the configured proxy against every actual exported Head triangle,
  // including its collar, cowling, ear pieces and both optical lenses.
  const restSurfaces = actualSurfaces(rig);
  for (const triangle of restSurfaces.groups.head)
    for (const point of triangle) {
      const local = localPoint(rig.head, point);
      for (let axis = 0; axis < 3; axis++)
        assert.ok(
          local[axis] >= headClearance.min[axis] && local[axis] <= headClearance.max[axis],
          'Head proxy must enclose every actual Head skin vertex',
        );
    }
  try {
    for (let frame = 0; frame <= 300; frame++) {
      const parameter =
        frame <= 90 ? 0.5 + frame / 180 : frame <= 150 ? 1 : frame <= 240 ? 1 - (frame - 150) / 180 : 0.5;
      const target = mapArmControl('side', parameter),
        value = step(rig, target);
      assert.equal(aim.clearanceResolved, true, `No head-clear pose at frame${frame}`);
      assert.ok(aim.headClearance >= 0, `Proxy clearance ${aim.headClearance} at frame${frame}`);
      if (frame % 10 === 0) {
        const triangles = actualSurfaces(rig).groups.head;
        const clearance = pointSurfaceDistance(value.result.orb, triangleTree(triangles)) - headClearance.targetRadius;
        records.push({
          frame,
          parameter,
          target,
          yaw: rig.torso.yaw,
          residual: value.residual,
          headLimited: aim.limited,
          proxyClearance: aim.headClearance,
          actualHeadClearance: clearance,
        });
        assert.ok(clearance >= headClearance.margin, `Presented head surface clearance ${clearance} at frame${frame}`);
      }
    }
  } finally {
    writeFileSync('test-results/skinning-ik-torso-dynamic-clearance.json', JSON.stringify(records, null, 2));
  }
});

test('arbitrary near-head requests and look toggles retain a checked held pose', async (t) => {
  const rig = await robot(false, true);
  t.after(() => rig.engine.dispose());
  const records = [];
  try {
    for (const tracking of [true, false, true]) {
      rig.tracking.enabled = tracking;
      const enforced = rig.solver.enforce();
      assert.equal(enforced.safe, true, 'A look toggle must recheck and retain a physically clear pose');
      for (const target of [
        [0, 1.15, 0],
        [0, 1.3, -0.23],
        [-0.1, 1.16, -0.12],
        [0.235, 1.16, -0.3],
      ]) {
        let value;
        for (let i = 0; i < 12; i++) value = step(rig, target);
        assert.equal(rig.headAim.clearanceResolved, true);
        assert.ok(rig.headAim.headClearance >= 0);
        const surfaces = actualSurfaces(rig),
          head = triangleTree(surfaces.groups.head);
        const clearance = pointSurfaceDistance(value.result.orb, head) - headClearance.targetRadius;
        assert.ok(clearance >= headClearance.margin, `Unsafe arbitrary head target${target}: ${clearance}`);
        records.push({
          tracking,
          target,
          orb: value.result.orb,
          residual: value.residual,
          yaw: rig.torso.yaw,
          headClearance: rig.headAim.headClearance,
          actualOrbHeadClearance: clearance,
        });
      }
    }
  } finally {
    writeFileSync('test-results/skinning-ik-head-arbitrary-targets.json', JSON.stringify(records, null, 2));
  }
});
