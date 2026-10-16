import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset } from '../packages/gltf-pro/dist/index.js';
import { multiplyMatrices } from '@margoengine/math/mat4';
import { gripPosition, holdObjectAtGrip, localPoint, solveArm, worldPosition } from '../examples/skinning-ik/rig-ik.ts';

// Match browser module resolution without adding a source-only loader to the ordinary test suite.
mkdirSync(resolve('test-results'), { recursive: true });
const temporary = mkdtempSync(resolve('test-results/ik-body-')),
  modulePath = join(temporary, 'body.mjs');
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
unlinkSync(modulePath);
rmdirSync(temporary);
const bytes = readFileSync(new URL('../examples/assets/skinning-ik.glb', import.meta.url));
const doc = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
const asset = new GLTFAsset(doc, [bytes.subarray(28 + bytes.readUInt32LE(12))]);
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
async function robot() {
  const store = await TransformStore.create(doc.nodes.length + 4),
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
  const named = (name) => nodes[doc.nodes.findIndex((n) => n.name === name)],
    shoulder = named('UpperArm'),
    elbow = named('Forearm'),
    wrist = named('Hand');
  const start = worldPosition(wrist),
    localGrip = localPoint(wrist, [start[0], start[1] + 0.13, start[2]]),
    orb = engine.createMesh();
  const rest = [shoulder, elbow, wrist].map((node) => {
    const t = store.transforms,
      id = node.id;
    return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
  });
  const solver = new BodyIK({ frame, shoulder, elbow, wrist, localGrip });
  return {
    engine,
    store,
    frame,
    nodes,
    shoulder,
    elbow,
    wrist,
    localGrip,
    orb,
    solver,
    resample: () => [shoulder, elbow, wrist].forEach((node, i) => node.setQuaternion(rest[i])),
  };
}
function held(rig) {
  assert.equal(rig.solver.collision(), null);
  assert.ok(
    distance(holdObjectAtGrip(rig.orb, rig.wrist, rig.localGrip), gripPosition(rig.wrist, rig.localGrip)) < 2e-6,
  );
  const orb = localPoint(rig.frame, gripPosition(rig.wrist, rig.localGrip));
  for (let i = 0; i < 96; i++) {
    const y = 1 - (2 * (i + 0.5)) / 96,
      angle = i * Math.PI * (3 - Math.sqrt(5)),
      r = Math.sqrt(1 - y * y),
      radius = 0.10465342044830322;
    assert.equal(
      insideTorso([orb[0] + radius * r * Math.cos(angle), orb[1] + radius * y, orb[2] + radius * r * Math.sin(angle)]),
      false,
      'actual held orb sphere must stay outside curved torso',
    );
  }
}

// Independent oracle uses the authored torso's curved volume and actual exported arm vertices.
function insideTorso(p) {
  // The green front armor has an independent, slightly fuller profile than the porcelain shell.
  const front = [
    [0.745, 0.145, 0.133],
    [0.8, 0.19, 0.155],
    [0.95, 0.23, 0.178],
    [1.035, 0.218, 0.168],
    [1.085, 0.17, 0.143],
  ];
  for (let i = 1; i < front.length; i++) {
    const [y0, x0, z0] = front[i - 1],
      [y1, x1, z1] = front[i];
    if (p[1] < y0 || p[1] > y1) continue;
    const t = (p[1] - y0) / (y1 - y0),
      rx = x0 + (x1 - x0) * t,
      rz = z0 + (z1 - z0) * t;
    if (Math.abs(p[0]) < rx * 0.983) {
      const z = 0.025 - rz * (1 - (Math.abs(p[0]) / rx) ** (2 / 0.67)) ** (0.67 / 2) - 0.008;
      if (p[2] > z && p[2] < 0.025) return true;
    }
  }
  const rings = [
    [0.7, 0.13, 0.11],
    [0.75, 0.19, 0.14],
    [0.94, 0.235, 0.17],
    [1.04, 0.225, 0.16],
    [1.115, 0.16, 0.12],
  ];
  if (p[1] > 0.795 && p[1] < 1.065 && Math.abs(p[0]) < 0.145 && p[2] > 0.1795 && p[2] < 0.2045) return true;
  for (let i = 1; i < rings.length; i++) {
    const [y0, x0, z0] = rings[i - 1],
      [y1, x1, z1] = rings[i];
    if (p[1] < y0 || p[1] > y1) continue;
    const t = (p[1] - y0) / (y1 - y0),
      rx = x0 + (x1 - x0) * t,
      rz = z0 + (z1 - z0) * t;
    return (Math.abs(p[0]) / rx) ** (2 / 0.67) + (Math.abs(p[2] - 0.025) / rz) ** (2 / 0.67) < 0.999;
  }
  return false;
}
function mountedShoulder(point) {
  const shoulder = [-0.24, 1.03, 0],
    upper = [-0.2, -0.19, -0.08],
    pole = [0.631587009346442, -0.38037150225808186, -0.6755852055031603],
    tolerance = 0.000001,
    delta = point.map((v, i) => v - shoulder[i]);
  if (Math.hypot(...delta) <= 0.083 + tolerance) return true;
  if (
    point.reduce(
      (sum, v, i) => sum + ((v - shoulder[i] - upper[i] * 0.12) / ([0.09, 0.09, 0.0825][i] + tolerance)) ** 2,
      0,
    ) <= 1
  )
    return true;
  const axial = delta.reduce((sum, v, i) => sum + v * pole[i], 0),
    radial = Math.hypot(...delta.map((v, i) => v - axial * pole[i]));
  return (
    (Math.abs(axial) <= 0.07 + tolerance && radial <= 0.0416 + tolerance) ||
    (Math.abs(Math.abs(axial) - 0.072) <= 0.007 + tolerance && radial <= 0.08 + tolerance) ||
    (Math.abs(Math.abs(axial) - 0.0835) <= 0.0035 + tolerance && radial <= 0.0296 + tolerance)
  );
}
function checkActualArmVertices(rig) {
  let blendedChecked = 0;
  for (const meshNode of doc.nodes) {
    if (meshNode.mesh === undefined || meshNode.skin === undefined) continue;
    const skin = doc.skins[meshNode.skin],
      binds = asset.accessor(skin.inverseBindMatrices, 'MAT4');
    const armSlots = skin.joints
        .map((joint, slot) => (['UpperArm', 'Forearm', 'Hand'].includes(doc.nodes[joint].name) ? slot : -1))
        .filter((slot) => slot >= 0),
      matrices = skin.joints.map((joint, slot) => {
        const m = new Float32Array(16);
        multiplyMatrices(rig.nodes[joint].matrix, binds.subarray(slot * 16, slot * 16 + 16), m);
        return m;
      });
    for (const primitive of doc.meshes[meshNode.mesh].primitives) {
      const attrs = primitive.attributes,
        positions = asset.accessor(attrs.POSITION, 'VEC3'),
        ids = asset.accessor(attrs.JOINTS_0, 'VEC4'),
        weights = asset.accessor(attrs.WEIGHTS_0, 'VEC4');
      for (let vertex = 0; vertex < positions.length / 3; vertex++) {
        let weight = 0;
        for (let k = 0; k < 4; k++) if (armSlots.includes(ids[vertex * 4 + k])) weight += weights[vertex * 4 + k];
        if (weight < 0.99999) continue;
        const [x, y, z] = positions.subarray(vertex * 3, vertex * 3 + 3),
          world = [0, 0, 0];
        const names = [];
        for (let k = 0; k < 4; k++) {
          const w = weights[vertex * 4 + k];
          if (!w) continue;
          const slot = ids[vertex * 4 + k],
            matrix = matrices[slot];
          names.push(doc.nodes[skin.joints[slot]].name);
          world[0] += w * (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]);
          world[1] += w * (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]);
          world[2] += w * (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]);
        }
        const p = localPoint(rig.frame, world);
        if (names.length > 1) blendedChecked++;
        if (names.every((name) => name === 'UpperArm') && mountedShoulder([x, y, z])) continue; // actual mount pieces only
        assert.equal(
          insideTorso(p),
          false,
          `${names.join('+')} exported skin vertex penetrates torso at ${JSON.stringify(p)}`,
        );
      }
    }
  }
  assert.ok(blendedChecked > 0, 'the independent skin oracle must examine blended elbow sleeve vertices');
}

test('torso-only IK permits front cross-body, behind, full overhead and outward reach', async () => {
  const rig = await robot();
  try {
    for (const target of [
      [-0.15, 1.1, -0.45],
      [-0.51, 1.05, 0.33],
      [-0.24, 1.69, 0],
      [-0.7, 1.1, -0.15],
    ]) {
      rig.resample();
      const result = rig.solver.solve(target);
      assert.equal(result.safe, true);
      assert.ok(
        distance(result.orb, target) < 0.002,
        `valid target rejected: ${JSON.stringify(target)} result ${JSON.stringify(result)}`,
      );
      held(rig);
      checkActualArmVertices(rig);
    }
  } finally {
    rig.engine.dispose();
  }
});

test('full angular sweep preserves broad reach and clears the actual exported arm surfaces', async () => {
  const rig = await robot();
  try {
    const root = worldPosition(rig.shoulder);
    let outward = 0;
    for (const elevation of [-Math.PI / 3, 0, Math.PI / 3])
      for (let step = 0; step < 24; step++) {
        const azimuth = (step * Math.PI) / 12,
          r = 0.46,
          target = [
            root[0] + r * Math.cos(elevation) * Math.cos(azimuth),
            root[1] + r * Math.sin(elevation) + 0.13,
            root[2] + r * Math.cos(elevation) * Math.sin(azimuth),
          ];
        rig.resample();
        let result = rig.solver.solve(target);
        for (let settle = 0; settle < 80 && distance(result.orb, target) > 0.002; settle++) {
          const next = rig.solver.solve(target);
          if (distance(next.orb, result.orb) < 1e-7) {
            result = next;
            break;
          }
          result = next;
        }
        assert.equal(result.safe, true);
        held(rig);
        if (target[0] < -0.38) {
          outward++;
          assert.ok(distance(result.orb, target) < 0.002, 'the complete outward sphere remains reachable');
        }
        checkActualArmVertices(rig);
      }
    assert.ok(outward >= 20, 'the angular sweep must include a broad outward workspace');
    // A wrist target at the shoulder is a legitimate fully folded request, rather than a NaN direction.
    assert.equal(rig.solver.solve([root[0], root[1] + 0.13, root[2]]).safe, true);
    held(rig);
  } finally {
    rig.engine.dispose();
  }
});

test('torso targets, unreachable targets and IK-off poses preserve a safe held orb', async () => {
  const rig = await robot();
  try {
    for (const x of [-1.3, -0.48, 0, 0.75])
      for (const y of [0.48, 1, 1.1, 1.4, 1.85])
        for (const z of [-1, -0.23, 0, 0.85]) {
          rig.resample();
          assert.equal(rig.solver.solve([x, y, z]).safe, true);
          held(rig);
        }
    const safe = gripPosition(rig.wrist, rig.localGrip);
    solveArm({ ...rig, target: [0, 1, 0], pole: [0, 1, 1] });
    assert.ok(rig.solver.collision());
    assert.equal(rig.solver.enforce().safe, true);
    assert.ok(distance(gripPosition(rig.wrist, rig.localGrip), safe) < 2e-6);
    rig.resample();
    assert.equal(rig.solver.enforce().safe, true);
    held(rig);
  } finally {
    rig.engine.dispose();
  }
});

test('stationary targets are deterministic and model placement remains correct', async () => {
  const rig = await robot();
  try {
    for (const target of [
      [0, 1, 0],
      [-0.51, 1.05, 0.33],
      [-0.24, 1.69, 0],
    ]) {
      const first = rig.solver.solve(target),
        start = performance.now();
      for (let i = 0; i < 100; i++) {
        rig.resample();
        const result = rig.solver.solve(target);
        assert.ok(distance(first.orb, result.orb) < 1e-7);
      }
      assert.ok(performance.now() - start < 1000, 'cached stationary target must avoid repeating pole search');
      held(rig);
    }
    rig.frame.setPosition([3, -0.5, 2]).setRotation([0.25, -0.6, 0.15]).setScale([1.7, 1.7, 1.7]);
    rig.store.tick(false);
    const target = gripPosition(rig.frame, [-0.51, 1.05, 0.33]),
      result = rig.solver.solve(target);
    assert.equal(result.safe, true);
    assert.ok(distance(target, result.orb) < 0.003);
    held(rig);
    assert.throws(() => rig.solver.solve([NaN, 0, 0]), /Body IK target/);
  } finally {
    rig.engine.dispose();
  }
});

test('small front cross-body target steps move smoothly without changing the head pose', async () => {
  const rig = await robot();
  try {
    const head = rig.nodes[doc.nodes.findIndex((n) => n.name === 'Head')],
      initialHead = Array.from(head.matrix);
    let previous = rig.solver.solve([-0.48, 1.1, -0.45]).orb,
      elbow = worldPosition(rig.elbow);
    for (let step = 1; step <= 80; step++) {
      const target = [-0.48 + (0.33 * step) / 80, 1.1, -0.45];
      rig.resample();
      const result = rig.solver.solve(target),
        nextElbow = worldPosition(rig.elbow);
      assert.ok(distance(result.orb, target) < 0.002, 'a clear front target should remain fully reachable');
      assert.ok(distance(result.orb, previous) < 0.008, 'small target changes must not jump the held orb');
      assert.ok(distance(nextElbow, elbow) < 0.04, 'pole changes must stay close to the previous elbow');
      previous = result.orb;
      elbow = nextElbow;
    }
    assert.deepEqual(Array.from(head.matrix), initialHead, 'body contact must not restrict head tracking');
    held(rig);
  } finally {
    rig.engine.dispose();
  }
});

test('the proximal shaft cannot hide inside an oversized shoulder-mount exclusion', async () => {
  const rig = await robot();
  try {
    // A full48×48 elbow-plane/shoulder-roll sweep finds actual shaft/chest intersection for this coordinate.
    // The named front preset stays reachable; this centered lower/front request needs a real body contact limit.
    const target = [0, 1.1, -0.4],
      result = rig.solver.solve(target);
    assert.equal(result.safe, true);
    assert.equal(result.blocked, true);
    assert.ok(distance(result.orb, target) > 0.002);
    held(rig);
    checkActualArmVertices(rig);
  } finally {
    rig.engine.dispose();
  }
});

test('reset clears contact recovery and returns Home to the exact authored elbow pose', async () => {
  const rig = await robot();
  try {
    const joints = [rig.shoulder, rig.elbow, rig.wrist],
      initial = joints.map(worldPosition),
      home = gripPosition(rig.wrist, rig.localGrip);
    rig.solver.solve([-0.15, 1.1, -0.45]);
    rig.solver.solve([-0.51, 1.05, 0.33]);
    for (let i = 0; i < 20; i++) rig.solver.solve([-0.2 + 0.005 * i, 0.95, -0.13]);
    assert.ok(distance(worldPosition(rig.elbow), initial[1]) > 0.02, 'the test must enter a different contact pose');
    rig.solver.reset();
    joints.forEach((joint, i) =>
      assert.ok(
        distance(worldPosition(joint), initial[i]) < 1e-7,
        'reset restores authored joint positions immediately',
      ),
    );
    const result = rig.solver.solve(home);
    assert.equal(result.safe, true);
    assert.equal(result.blocked, false);
    assert.equal(result.limited, false);
    assert.ok(distance(result.orb, home) < 2e-6);
    assert.ok(
      distance(worldPosition(rig.elbow), initial[1]) < 2e-6,
      'Home must restore the original low elbow after reset',
    );
    held(rig);
    checkActualArmVertices(rig);
  } finally {
    rig.engine.dispose();
  }
});

test('low front chest requests clear every rigid and blended arm skin vertex', async () => {
  const rig = await robot();
  try {
    for (const target of [
      [0, 0.8, -0.15],
      [-0.1, 0.8, -0.15],
      [-0.15, 0.9, -0.2],
    ]) {
      rig.resample();
      assert.equal(rig.solver.solve(target).safe, true);
      held(rig);
      checkActualArmVertices(rig);
    }
    for (const x of [-0.5, -0.35, -0.2, -0.05, 0.1, 0.25])
      for (const y of [0.65, 0.8, 0.95, 1.1, 1.25])
        for (const z of [-0.4, -0.25, -0.15, 0, 0.15]) {
          rig.resample();
          const target = [x, y, z],
            result = rig.solver.solve(target);
          assert.equal(result.safe, true);
          held(rig);
          try {
            checkActualArmVertices(rig);
          } catch (error) {
            error.message += ' target ' + JSON.stringify(target);
            throw error;
          }
        }
    rig.frame.setPosition([3, -0.5, 2]).setRotation([0.25, -0.6, 0.15]).setScale([1.7, 1.7, 1.7]);
    rig.store.tick(false);
    assert.equal(rig.solver.solve(gripPosition(rig.frame, [0, 0.8, -0.15])).safe, true);
    held(rig);
    checkActualArmVertices(rig);
  } finally {
    rig.engine.dispose();
  }
});

test('targets inside the torso slide laterally and vertically across contact instead of freezing', async () => {
  const rig = await robot();
  try {
    const cases = [
      { start: [-0.48, 1, -0.16], path: (i) => [-0.48 + (0.48 * i) / 100, 1, -0.16], axis: 0, minimum: 0.2 },
      {
        start: [-0.2, 0.7, -0.4],
        path: (i) => [-0.2, 0.7 + (0.85 * i) / 100, -0.13],
        axis: 1,
        minimum: 0.5,
        release: true,
      },
      { start: [-0.2, 1, -0.4], path: (i) => [-0.2, 1, -0.4 + (0.8 * i) / 100], axis: 2, minimum: 0.5, release: true },
    ];
    for (const { start, path, axis, minimum, release } of cases) {
      let previous = rig.solver.solve(start).orb,
        elbow = worldPosition(rig.elbow),
        first;
      for (let i = 0; i <= 100; i++) {
        rig.resample();
        const result = rig.solver.solve(path(i)),
          nextElbow = worldPosition(rig.elbow);
        assert.equal(result.safe, true);
        held(rig);
        if (i === 0) first = result.orb;
        if (i > 0) {
          assert.ok(
            distance(result.orb, previous) < 0.025,
            `contact should not jump: step ${i}, previous ${JSON.stringify(previous)}, next ${JSON.stringify(result.orb)}`,
          );
          assert.ok(distance(nextElbow, elbow) < 0.045, `elbow contact branch should remain continuous: step ${i}`);
        }
        previous = result.orb;
        elbow = nextElbow;
        if (i % 10 === 0) checkActualArmVertices(rig);
      }
      if (release) {
        for (let i = 0; i < 90 && distance(previous, path(100)) > 0.002; i++) {
          rig.resample();
          const result = rig.solver.solve(path(100));
          held(rig);
          assert.ok(distance(result.orb, previous) < 0.025, 'stationary contact recovery must remain continuous');
          previous = result.orb;
        }
      }
      assert.ok(
        previous[axis] - first[axis] > minimum,
        `inside requests must slide along body: start ${JSON.stringify(first)}, end ${JSON.stringify(previous)}`,
      );
      if (release)
        assert.ok(
          distance(previous, path(100)) < 0.02,
          `a clear reachable endpoint should release the contact without a retained drag offset: ${JSON.stringify(previous)} vs ${JSON.stringify(path(100))}`,
        );
    }
  } finally {
    rig.engine.dispose();
  }
});
