import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset } from '../packages/gltf-pro/dist/index.js';
import { invertMatrixStable } from '@margoengine/math/mat4';

mkdirSync('test-results', { recursive: true });
const temporary = mkdtempSync(resolve('test-results/head-arm-test-')),
  path = join(temporary, 'helper.mjs');
const bundle = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: {
    write: false,
    target: 'es2022',
    minify: false,
    lib: { entry: resolve('examples/skinning-ik/arm-head-clearance.ts'), formats: ['es'] },
    rollupOptions: { external: (id) => id.startsWith('@margoengine/') },
  },
});
writeFileSync(path, bundle[0].output[0].code);
const { ArmHeadClearance } = await import(pathToFileURL(path).href);
unlinkSync(path);
rmdirSync(temporary);
const bytes = readFileSync('examples/assets/skinning-ik.glb'),
  doc = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12))),
  asset = new GLTFAsset(doc, [bytes.subarray(28 + bytes.readUInt32LE(12))]);
function transform(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
const selected = [];
for (const node of doc.nodes) {
  if (node.mesh === undefined || node.skin === undefined) continue;
  const skin = doc.skins[node.skin],
    binds = asset.accessor(skin.inverseBindMatrices, 'MAT4');
  for (const primitive of doc.meshes[node.mesh].primitives) {
    const a = primitive.attributes,
      p = asset.accessor(a.POSITION, 'VEC3'),
      j = asset.accessor(a.JOINTS_0, 'VEC4'),
      w = asset.accessor(a.WEIGHTS_0, 'VEC4');
    for (let v = 0; v < p.length / 3; v++) {
      let active = false;
      for (let k = 0; k < 4; k++)
        if (w[v * 4 + k] > 0 && doc.nodes[skin.joints[j[v * 4 + k]]].name === 'UpperArm') active = true;
      if (!active) continue;
      const influences = [];
      for (let k = 0; k < 4; k++)
        if (w[v * 4 + k] > 0) {
          const slot = j[v * 4 + k];
          influences.push({
            joint: skin.joints[slot],
            weight: w[v * 4 + k],
            point: transform(binds.subarray(slot * 16, slot * 16 + 16), p.subarray(v * 3, v * 3 + 3)),
          });
        }
      selected.push(influences);
    }
  }
}
async function fixture() {
  const store = await TransformStore.create(doc.nodes.length + 1),
    engine = new Engine({ width: 1, height: 1, clientWidth: 1, clientHeight: 1 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    frame = engine.createMesh();
  const nodes = doc.nodes.map((n) =>
    engine
      .createMesh()
      .setParent(frame)
      .setPosition(n.translation ?? [0, 0, 0])
      .setQuaternion(n.rotation ?? [0, 0, 0, 1])
      .setScale(n.scale ?? [1, 1, 1]),
  );
  doc.nodes.forEach((n, i) => n.children?.forEach((j) => nodes[j].setParent(nodes[i])));
  store.tick(false);
  const named = (name) => nodes[doc.nodes.findIndex((n) => n.name === name)],
    head = named('Head'),
    shoulder = named('UpperArm'),
    elbow = named('Forearm'),
    guard = new ArmHeadClearance(frame, head, shoulder, elbow);
  return { store, engine, frame, nodes, head, shoulder, elbow, guard };
}

test('head-only envelope contains every actual mounted and blended upper-arm vertex through moving poses', async (t) => {
  const rig = await fixture();
  t.after(() => rig.engine.dispose());
  assert.equal(selected.length, 2418);
  assert.ok(
    selected.some((v) => v.length > 1),
    'the oracle must include blended sleeve vertices',
  );
  const inverse = new Float64Array(16),
    directions = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
  for (let i = 0; i < 80; i++) directions.push([Math.sin(i * 1.7), Math.cos(i * 0.71), Math.sin(i * 0.37)]);
  for (let pose = 0; pose < 20; pose++) {
    rig.frame.setPosition([2, -0.5, 3]).setRotation([0.2, -0.6, 0.15]).setScale([1.7, 1.7, 1.7]);
    rig.shoulder.setQuaternion([Math.sin(pose * 0.37), Math.cos(pose * 0.29), Math.sin(pose * 0.17), 0.8]);
    rig.elbow.setQuaternion([Math.sin(pose * 0.21), -0.2, Math.cos(pose * 0.31), 0.9]);
    rig.store.tick(false);
    assert.ok(invertMatrixStable(rig.frame.matrix, inverse));
    rig.guard.prepare();
    const actual = selected.map((influences) => {
      const point = [0, 0, 0];
      for (const influence of influences) {
        const world = transform(rig.nodes[influence.joint].matrix, influence.point);
        for (let axis = 0; axis < 3; axis++) point[axis] += world[axis] * influence.weight;
      }
      return transform(inverse, point);
    });
    for (const direction of directions) {
      const support = rig.guard.supportArm(direction),
        bound = support[0] * direction[0] + support[1] * direction[1] + support[2] * direction[2];
      let expected = -Infinity;
      for (const p of actual)
        expected = Math.max(expected, p[0] * direction[0] + p[1] * direction[1] + p[2] * direction[2]);
      assert.ok(
        bound >= expected + 0.003 * Math.hypot(...direction) - 1e-6,
        'the padded union must contain the complete skinned envelope',
      );
    }
  }
});

test('proposed head queries match exact Float32 kernel matrices and preserve the scene under transformed roots', async (t) => {
  const rig = await fixture();
  t.after(() => rig.engine.dispose());
  const a = new Float64Array(1),
    b = new Float64Array(1);
  for (const transformed of [false, true]) {
    if (transformed) rig.frame.setPosition([2, -0.4, 3]).setRotation([0.23, -0.41, 0.17]).setScale([1.7, 1.7, 1.7]);
    for (let i = 0; i < 250; i++) {
      rig.store.tick(false);
      const before = [...rig.head.matrix],
        rotation = [Math.sin(i * 0.371), Math.cos(i * 0.227), Math.sin(i * 0.197), Math.cos(i * 0.771)];
      rig.guard.evaluate(rotation, a);
      assert.deepEqual([...rig.head.matrix], before, 'query must not commit the proposed Head pose');
      rig.head.setQuaternion(rotation);
      rig.store.tick(false);
      assert.deepEqual(
        new Uint32Array(rig.guard.worldMatrix.buffer),
        new Uint32Array(rig.head.matrix.buffer, rig.head.matrix.byteOffset, 16),
      );
      rig.guard.evaluateCurrent(b);
      assert.equal(b[0], a[0]);
    }
  }
});

test('the formerly omitted shoulder mount rejects the reproduced downward gaze near-contact pose', async (t) => {
  const rig = await fixture();
  t.after(() => rig.engine.dispose());
  const poses = [
    [0, -0.000014731318515259773, 0, 1],
    [-0.8684719204902649, 0.2781201899051666, 0.40954092144966125, -0.026113025844097137],
    [0.7093943953514099, -0.07458493858575821, -0.4289264380931854, 0.554273247718811],
    [-0.14805354177951813, 0.02231520414352417, -0.12713347375392914, 0.9805198907852173],
    [-0.25159451365470886, 0.48792561888694763, 0.20470838248729706, 0.8103846311569214],
  ];
  const named = (name) => rig.nodes[doc.nodes.findIndex((n) => n.name === name)];
  ['Body', 'UpperArm', 'Forearm', 'Hand', 'Head'].forEach((name, index) => named(name).setQuaternion(poses[index]));
  rig.store.tick(false);
  const out = new Float64Array(1);
  rig.guard.evaluateCurrent(out);
  assert.ok(out[0] < 0, 'actual skin was only 0.250 mm from the head while torso-trimmed proxies reported 120 mm');
  rig.guard.evaluate([0, 0, 0, 1], out);
  assert.ok(out[0] > 0, 'the guard must leave a reachable clearance-preserving head alternative');
});

test('head envelope cache validates actual arm/frame changes, store growth and guards before writing', async (t) => {
  const rig = await fixture();
  t.after(() => rig.engine.dispose());
  const out = new Float64Array([17, 19]),
    original = rig.guard.kernel.query.bind(rig.guard.kernel);
  let calls = 0;
  rig.guard.kernel.query = (...args) => {
    calls++;
    return original(...args);
  };
  rig.guard.evaluateCurrent(out);
  assert.ok(out[0] > 0);
  const count = calls;
  for (let i = 0; i < 20; i++) rig.guard.evaluateCurrent(out);
  assert.equal(calls, count);
  rig.shoulder.setRotation([0.2, -0.3, 0.1]);
  rig.guard.evaluateCurrent(out);
  assert.equal(calls, count + 1);
  const retained = out[0];
  for (let i = 0; i < 80; i++) rig.engine.createMesh();
  rig.guard.evaluateCurrent(out);
  assert.equal(out[0], retained);
  for (const invalid of [
    [0, 0, 0, 0],
    [0, 0, 1],
    [NaN, 0, 0, 1],
    [Infinity, 0, 0, 1],
    [1e40, 0, 0, 1],
  ]) {
    out[0] = 17;
    assert.throws(() => rig.guard.evaluate(invalid, out));
    assert.deepEqual([...out], [17, 19]);
  }
  rig.frame.setScale([1, 1.1, 1]);
  assert.throws(() => rig.guard.evaluateCurrent(out), /uniform/);
  assert.deepEqual([...out], [17, 19]);
});
