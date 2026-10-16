import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { gripPosition, localPoint, worldPosition } from '../examples/skinning-ik/rig-ik.ts';
import { mapArmControl, nearestArmControlParameter } from '../examples/skinning-ik/arm-controls.ts';

mkdirSync(resolve('test-results'), { recursive: true });
const temporary = mkdtempSync(resolve('test-results/ik-arm-controls-')),
  modulePath = join(temporary, 'body.mjs'),
  torsoPath = join(temporary, 'torso.mjs');
const bundle = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: {
    write: false,
    target: 'es2022',
    minify: false,
    lib: { entry: resolve('examples/skinning-ik/body-ik.ts'), formats: ['es'] },
    rollupOptions: { external: (id) => id.startsWith('@margoengine/') },
  },
});
writeFileSync(modulePath, bundle[0].output[0].code);
const { BodyIK } = await import(pathToFileURL(modulePath).href);
const torsoBundle = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: {
    write: false,
    target: 'es2022',
    minify: false,
    lib: { entry: resolve('examples/skinning-ik/torso-aim.ts'), formats: ['es'] },
    rollupOptions: { external: (id) => id.startsWith('@margoengine/') },
  },
});
writeFileSync(torsoPath, torsoBundle[0].output[0].code);
const { TorsoAim } = await import(pathToFileURL(torsoPath).href);
unlinkSync(modulePath);
unlinkSync(torsoPath);
rmdirSync(temporary);
const bytes = readFileSync(new URL('../examples/assets/skinning-ik.glb', import.meta.url));
const doc = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
async function robot() {
  const store = await TransformStore.create(doc.nodes.length + 2),
    engine = new Engine({ width: 256, height: 256, clientWidth: 256, clientHeight: 256 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    frame = engine.createMesh();
  const nodes = doc.nodes.map((node) =>
    engine
      .createMesh()
      .setParent(frame)
      .setPosition(node.translation ?? [0, 0, 0])
      .setQuaternion(node.rotation ?? [0, 0, 0, 1])
      .setScale(node.scale ?? [1, 1, 1]),
  );
  doc.nodes.forEach((node, i) => node.children?.forEach((child) => nodes[child].setParent(nodes[i])));
  store.tick(false);
  const named = (name) => nodes[doc.nodes.findIndex((node) => node.name === name)],
    shoulder = named('UpperArm'),
    elbow = named('Forearm'),
    wrist = named('Hand'),
    start = worldPosition(wrist),
    localGrip = localPoint(wrist, [start[0], start[1] + 0.13, start[2]]),
    torsoAim = new TorsoAim(named('Body'), frame),
    solver = new BodyIK({ frame: torsoAim.frame, shoulder, elbow, wrist, localGrip });
  const lengths = [
    distance(worldPosition(shoulder), worldPosition(elbow)),
    distance(worldPosition(elbow), worldPosition(wrist)),
  ];
  return { engine, store, frame, shoulder, elbow, wrist, localGrip, solver, torsoAim, lengths };
}

function advance(rig, target, dt) {
  const previousYaw = rig.torsoAim.yaw;
  rig.torsoAim.update(target, dt);
  assert.ok(
    Math.abs(rig.torsoAim.yaw - previousYaw) <= 1.6 * dt + 1e-12,
    'torso movement must honor its angular speed cap',
  );
  assert.ok(Math.abs(rig.torsoAim.yaw) <= rig.torsoAim.maxYaw + 1e-12);
  const result = rig.solver.solve(gripPosition(rig.frame, target), dt);
  assert.equal(result.safe, true);
  assert.equal(rig.solver.collision(), null, 'the full hull follows the turned body frame');
  const positions = [rig.shoulder, rig.elbow, rig.wrist].map(worldPosition);
  for (let i = 0; i < 2; i++)
    assert.ok(
      Math.abs(distance(positions[i], positions[i + 1]) - rig.lengths[i]) < 2e-6,
      'torso assist must not stretch either link',
    );
  return result;
}

function settle(rig, target, dt = 1 / 60) {
  let result;
  for (let step = 0; step < 180; step++) {
    result = advance(rig, target, dt);
    if (
      Math.abs(rig.torsoAim.yaw - rig.torsoAim.desiredYaw) < 1e-6 &&
      distance(result.orb, gripPosition(rig.frame, target)) < 0.002
    )
      break;
  }
  return result;
}

test('independent arm tracks share authored home and preserve normalized parameter/readout round trips', () => {
  const home = mapArmControl('height', 0.5),
    out = new Float64Array(3);
  for (const control of ['side', 'height', 'nearFar']) {
    assert.deepEqual(mapArmControl(control, 0.5), home);
    assert.strictEqual(mapArmControl(control, 0.5, out), out);
    for (let i = 0; i <= 100; i++) {
      const t = i / 100,
        point = mapArmControl(control, t);
      assert.ok(Math.abs(nearestArmControlParameter(control, point) - t) < 2e-7, `${control} parameter ${t}`);
    }
    assert.deepEqual(mapArmControl(control, -1), mapArmControl(control, 0));
    assert.deepEqual(mapArmControl(control, 2), mapArmControl(control, 1));
  }
  assert.ok(mapArmControl('height', 0)[1] < 0.67 && mapArmControl('height', 1)[1] > 1.68);
  assert.ok(mapArmControl('side', 0)[0] < -0.75 && mapArmControl('side', 1)[0] >= 0.235);
  assert.equal(mapArmControl('side', 1)[1], 1.16, 'cross-body movement stays at chest height');
  assert.equal(mapArmControl('side', 1)[2], -0.3, 'cross-body movement stays in front of the body');
  assert.ok(mapArmControl('nearFar', 0)[2] > 0.19 && mapArmControl('nearFar', 1)[2] < -0.49);
  for (const parameter of [NaN, Infinity, -Infinity]) {
    out.set([1, 2, 3]);
    assert.throws(() => mapArmControl('height', parameter, out), /finite/);
    assert.deepEqual([...out], [1, 2, 3]);
  }
});

test('each complete arm-control track is reachable with bounded torso assist and the moving body guard', async () => {
  const rig = await robot();
  const records = [];
  try {
    for (const control of ['height', 'nearFar', 'side']) {
      rig.torsoAim.reset();
      rig.solver.reset();
      let worst = 0;
      for (let sample = 0; sample <= 160; sample++) {
        const parameter = sample <= 80 ? sample / 80 : (160 - sample) / 80,
          target = mapArmControl(control, parameter);
        const result = settle(rig, target);
        const residual = distance(result.orb, target);
        worst = Math.max(worst, residual);
        records.push({
          control,
          parameter,
          target,
          orb: result.orb,
          shoulder: worldPosition(rig.shoulder),
          elbow: worldPosition(rig.elbow),
          wrist: worldPosition(rig.wrist),
          residual,
          torsoYaw: rig.torsoAim.yaw,
        });
        assert.equal(result.safe, true);
        assert.equal(rig.solver.collision(), null);
        assert.ok(
          residual < 0.002,
          `${control} ${parameter}: ${residual} m residual at ${JSON.stringify(target)}, held ${JSON.stringify(result.orb)}`,
        );
      }
      assert.ok(worst < 0.002);
    }
    const down = records.find((value) => value.control === 'height' && value.parameter === 0);
    const up = records.find((value) => value.control === 'height' && value.parameter === 1);
    assert.ok(down.wrist[1] < down.shoulder[1] - 0.49, 'Height starts with the hand down at its own side');
    assert.ok(up.wrist[1] > up.shoulder[1] + 0.52, 'Height ends with the hand fully overhead');
    const near = records.find((value) => value.control === 'nearFar' && value.parameter === 0);
    const far = records.find((value) => value.control === 'nearFar' && value.parameter === 1);
    const bend = (value) => {
      const upper = distance(value.shoulder, value.elbow),
        lower = distance(value.elbow, value.wrist),
        reach = distance(value.shoulder, value.wrist);
      return Math.acos(
        Math.max(-1, Math.min(1, (upper * upper + lower * lower - reach * reach) / (2 * upper * lower))),
      );
    };
    assert.ok(bend(far) > bend(near) + 1, 'Near and far visibly folds and extends the elbow');
    assert.ok(distance(far.shoulder, far.wrist) > 0.51, 'Far is a real front extension');
  } finally {
    writeFileSync('test-results/skinning-ik-arm-controls-paths.json', JSON.stringify(records, null, 2));
    rig.torsoAim.dispose();
    rig.engine.dispose();
  }
});

test('fast cross-body reversals preserve link lengths, held grip and torso history through zero-delta renders', async () => {
  const rig = await robot();
  try {
    const changes = [
      ['side', 1],
      ['height', 1],
      ['side', 0],
      ['nearFar', 1],
      ['side', 1],
      ['height', 0],
      ['side', 0.5],
    ];
    const deltas = [1 / 120, 1 / 30, 1 / 60, 0.05];
    for (let i = 0; i < changes.length; i++) {
      const [control, parameter] = changes[i],
        target = mapArmControl(control, parameter);
      for (let step = 0; step < 4; step++) {
        const result = advance(rig, target, deltas[(i + step) % deltas.length]);
        assert.ok(result.orb.every(Number.isFinite));
        const beforeYaw = rig.torsoAim.yaw,
          beforeGrip = gripPosition(rig.wrist, rig.localGrip);
        rig.torsoAim.update(target, 0);
        rig.solver.enforce();
        assert.equal(rig.torsoAim.yaw, beforeYaw, 'reflection renders must not advance torso yaw');
        assert.ok(distance(gripPosition(rig.wrist, rig.localGrip), beforeGrip) < 2e-6);
      }
    }
    const target = mapArmControl('side', 1),
      result = settle(rig, target);
    assert.ok(distance(result.orb, target) < 0.002, 'reversals must recover the complete opposite-side endpoint');
  } finally {
    rig.torsoAim.dispose();
    rig.engine.dispose();
  }
});
