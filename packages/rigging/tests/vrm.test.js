// VRM 1.0 on real files: the VRM Consortium's published samples Seed-san (VirtualCast) and
// VRM1_Constraint_Twist_Sample (pixiv), read, written back, driven and swung on a model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { Animation } from '../../animation/dist/index.js';
import { GLB_BIN, GLB_JSON, glbChunks } from '../../shared/glb.js';
import { SpringBones } from '../dist/springs.js';
import {
  VRMExpressions,
  VRM_REQUIRED_BONES,
  addVRM,
  checkVRM,
  createVRM,
  readVRM,
  vrmEyeAngles,
  vrmGaze,
  vrmLookWeights,
  vrmSprings,
  writeVRM,
} from '../dist/vrm.js';

const file = (name) => {
  const bytes = readFileSync(new URL(`../../../examples/assets/vrm/${name}`, import.meta.url));
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};
const seed = file('Seed-san.vrm'),
  twist = file('VRM1_Constraint_Twist_Sample.vrm');
const json = (bytes) => JSON.parse(new TextDecoder().decode(glbChunks(bytes)[0].data));
const close = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

test('reads both real files: meta, every bone, expressions, gaze, springs, with nothing to report', () => {
  const san = readVRM(seed),
    sample = readVRM(twist);
  assert.equal(san.specVersion, '1.0');
  assert.equal(san.meta.name, 'Seed-san');
  assert.deepEqual(san.meta.authors, ['VirtualCast, Inc.']);
  assert.equal(Object.keys(san.humanoid.humanBones).length, 51);
  assert.equal(Object.keys(sample.humanoid.humanBones).length, 54);
  for (const bone of VRM_REQUIRED_BONES) assert.ok(san.humanoid.humanBones[bone], bone);
  assert.equal(Object.keys(san.expressions.preset).length, 18);
  assert.equal(san.expressions.preset.happy.overrideBlink, 'blend');
  assert.equal(san.lookAt.type, 'expression');
  assert.equal(sample.lookAt.type, 'bone');
  assert.equal(san.springBone.springs.length, 9);
  assert.equal(sample.springBone.springs.length, 22);
  assert.deepEqual(checkVRM(san, json(seed)), []);
  assert.deepEqual(checkVRM(sample, json(twist)), []);
  // A parsed document reads the same as the bytes, and the result does not alias it.
  const doc = json(seed),
    again = readVRM(doc);
  assert.deepEqual(again, san);
  again.meta.name = 'Other';
  assert.equal(doc.extensions.VRMC_vrm.meta.name, 'Seed-san');
});

test('writing a real file back changes nothing but what was edited', () => {
  for (const source of [seed, twist]) {
    const avatar = readVRM(source),
      same = writeVRM(source, avatar);
    assert.deepEqual(json(same), json(source));
    const before = glbChunks(source),
      after = glbChunks(same);
    assert.equal(after.length, before.length);
    assert.equal(Buffer.compare(after[1].data, before[1].data), 0, 'BIN chunk is byte for byte the same');
    assert.equal(after[1].type, GLB_BIN);
    assert.equal(after[0].type, GLB_JSON);
    avatar.meta.name = 'Renamed';
    avatar.expressions.preset.aa.morphTargetBinds[0].weight = 0.5;
    delete avatar.springBone;
    const edited = writeVRM(source, avatar),
      read = readVRM(edited),
      doc = json(edited);
    assert.equal(read.meta.name, 'Renamed');
    assert.equal(read.expressions.preset.aa.morphTargetBinds[0].weight, 0.5);
    assert.equal(read.springBone, undefined);
    assert.ok(!doc.extensionsUsed.includes('VRMC_springBone'));
    assert.deepEqual(doc.extensions.VRMC_node_constraint, json(source).extensions.VRMC_node_constraint);
    assert.deepEqual(doc.nodes, json(source).nodes, 'node constraints and the rest stay');
  }
});

// A plain GLB holding a humanoid hierarchy, with no VRM in it.
function plainGLB() {
  const names = [
      'hips', 'spine', 'head',
      'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
      'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    ],
    at = Object.fromEntries(names.map((name, i) => [name, i])),
    nodes = names.map((name) => ({ name })),
    child = (a, ...b) => (nodes[at[a]].children = b.map((name) => at[name]));
  child('hips', 'spine', 'leftUpperLeg', 'rightUpperLeg');
  child('spine', 'head', 'leftUpperArm', 'rightUpperArm');
  child('leftUpperLeg', 'leftLowerLeg');
  child('leftLowerLeg', 'leftFoot');
  child('rightUpperLeg', 'rightLowerLeg');
  child('rightLowerLeg', 'rightFoot');
  child('leftUpperArm', 'leftLowerArm');
  child('leftLowerArm', 'leftHand');
  child('rightUpperArm', 'rightLowerArm');
  child('rightLowerArm', 'rightHand');
  const text = new TextEncoder().encode(
      JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes }),
    ),
    length = (text.length + 3) & ~3,
    out = new Uint8Array(20 + length).fill(0x20),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, length, true);
  view.setUint32(16, GLB_JSON, true);
  out.set(text, 20);
  return { bytes: out, bones: at };
}

test('createVRM and writeVRM turn a plain rigged GLB into a .vrm (stand-in hierarchy)', () => {
  const { bytes, bones } = plainGLB(),
    avatar = createVRM({
      name: 'Rig',
      authors: ['Margo'],
      bones,
      lookAt: { type: 'bone', offsetFromHeadBone: [0, 0.06, 0] },
    }),
    written = writeVRM(bytes, avatar),
    read = readVRM(written);
  assert.equal(read.meta.licenseUrl, 'https://vrm.dev/licenses/1.0/');
  assert.equal(read.humanoid.humanBones.leftHand.node, bones.leftHand);
  assert.ok(json(written).extensionsUsed.includes('VRMC_vrm'));
  assert.deepEqual(json(written).nodes, json(bytes).nodes);
  // From a Map, as humanoidBones gives it.
  const map = new Map(Object.entries(bones));
  assert.equal(createVRM({ name: 'R', authors: ['M'], bones: map }).humanoid.humanBones.spine.node, 1);
});

test('what breaks the specification is named and refused', () => {
  const { bytes, bones } = plainGLB(),
    make = (edit) => {
      const avatar = createVRM({ name: 'Rig', authors: ['Margo'], bones });
      edit(avatar);
      return avatar;
    },
    issues = (edit) => checkVRM(make(edit), json(bytes)).join(' ');
  assert.match(issues((a) => delete a.humanoid.humanBones.head), /head is required/);
  assert.match(issues((a) => (a.meta.name = '')), /meta.name/);
  assert.match(issues((a) => (a.meta.authors = [])), /author/);
  assert.match(issues((a) => (a.humanoid.humanBones.head.node = 99)), /does not exist/);
  assert.match(issues((a) => (a.humanoid.humanBones.head.node = a.humanoid.humanBones.spine.node)), /share node/);
  assert.match(
    issues((a) => ([a.humanoid.humanBones.leftHand, a.humanoid.humanBones.leftFoot] = [a.humanoid.humanBones.leftFoot, a.humanoid.humanBones.leftHand])),
    /must descend/,
  );
  assert.match(issues((a) => (a.humanoid.humanBones.tail = { node: 1 })), /not a humanoid bone/);
  assert.match(issues((a) => (a.lookAt = { type: 'eyes' })), /lookAt.type/);
  assert.match(
    issues((a) => (a.expressions = { custom: { happy: {} } })),
    /preset's name/,
  );
  assert.match(
    issues((a) => (a.expressions = { preset: { aa: { morphTargetBinds: [{ node: 1, index: 0, weight: 1 }] } } })),
    /no mesh/,
  );
  assert.match(
    issues((a) => (a.expressions = { preset: { aa: { textureTransformBinds: [{ material: 3 }] } } })),
    /material 3/,
  );
  assert.throws(() => writeVRM(bytes, make((a) => delete a.humanoid.humanBones.hips)), RangeError);
  assert.throws(() => writeVRM(new Uint8Array(4), make(() => {})), TypeError);
  assert.throws(() => readVRM(new Uint8Array(40)), TypeError);
  assert.throws(() => readVRM({ extensions: {} }), /no VRMC_vrm/);
  assert.throws(() => readVRM({ extensions: { VRM: {} } }), { code: 'unsupported' });
  assert.throws(() => readVRM({ extensions: { VRMC_vrm: { specVersion: '0.0' } } }), { code: 'unsupported' });
  assert.throws(() => readVRM({ extensions: { VRMC_vrm: { specVersion: '1.0' } } }), /humanBones/);
});

test('expressions follow isBinary and the overrides on the real files', () => {
  const san = new VRMExpressions(readVRM(seed)),
    happy = () => san.resolve().get('happy'),
    blink = () => san.resolve().get('blink');
  san.set('blink', 1);
  assert.equal(blink(), 1);
  // Seed-san's happy is binary with overrideBlink blend: under 0.5 it shows nothing and holds nothing back.
  san.set('happy', 0.4);
  assert.equal(happy(), 0);
  assert.equal(blink(), 1);
  san.set('happy', 0.6);
  assert.equal(happy(), 1);
  assert.equal(blink(), 0);
  // relaxed blocks.
  san.set('happy', 0).set('relaxed', 0.9);
  assert.equal(blink(), 0);
  // The pixiv sample's happy is not binary: blink fades in step.
  const sample = new VRMExpressions(readVRM(twist));
  sample.set('blink', 0.8).set('happy', 0.25);
  assert.ok(close(sample.resolve().get('blink'), 0.6));
  assert.equal(sample.resolve().get('happy'), 0.25);
  // Values clamp, a preset the avatar lacks does nothing, a wrong custom name is caught.
  sample.set('aa', 7);
  assert.equal(sample.get('aa'), 1);
  assert.throws(() => sample.set('smile2', 1), /not on this avatar/);
  assert.throws(() => sample.set('aa', NaN), /finite/);
});

test('override rules on a stand-in: own kind is ignored, a binary target is cut off, custom names can join', () => {
  const avatar = {
      expressions: {
        preset: {
          blink: { overrideBlink: 'block', overrideMouth: 'blend' },
          aa: { isBinary: true },
          ih: {},
        },
        custom: { mouthWide: {}, smirk: { overrideMouth: 'blend' } },
      },
    },
    plain = new VRMExpressions(avatar),
    wide = new VRMExpressions(avatar, { mouth: ['mouthWide'] });
  plain.set('blink', 1);
  assert.equal(plain.resolve().get('blink'), 1, 'an override of its own kind is invalid');
  plain.set('blink', 0).set('smirk', 0.5).set('aa', 1).set('ih', 1).set('mouthWide', 1);
  const out = plain.resolve();
  assert.equal(out.get('aa'), 0, 'a binary target is suppressed by any effect');
  assert.equal(out.get('ih'), 0.5);
  assert.equal(out.get('mouthWide'), 1);
  wide.set('smirk', 0.5).set('mouthWide', 1);
  assert.equal(wide.resolve().get('mouthWide'), 0.5);
});

test('accumulation adds morphs, and colours and texture moves as differences from the base', () => {
  const avatar = {
      expressions: {
        preset: {
          aa: {
            morphTargetBinds: [{ node: 0, index: 1, weight: 0.5 }],
            materialColorBinds: [{ material: 0, type: 'color', targetValue: [1, 0, 0, 1] }],
            textureTransformBinds: [{ material: 1, offset: [0.5, 0] }],
          },
          ih: {
            morphTargetBinds: [
              { node: 0, index: 1, weight: 1 },
              { node: 0, index: 2, weight: 1 },
            ],
            materialColorBinds: [{ material: 0, type: 'color', targetValue: [0, 1, 0, 1] }],
          },
        },
      },
    },
    expressions = new VRMExpressions(avatar).set('aa', 1).set('ih', 0.25),
    out = expressions.evaluate();
  assert.deepEqual(out.morphs, [
    { node: 0, index: 1, weight: 0.75 },
    { node: 0, index: 2, weight: 0.25 },
  ]);
  assert.equal(out.colors[0].parts.length, 2);
  assert.equal(out.transforms[0].parts[0].value, 1);
  assert.deepEqual(out.transforms[0].parts[0].scale, [1, 1]);
  // At rest every bind is still listed, so a morph goes back to 0.
  assert.deepEqual(new VRMExpressions(avatar).evaluate().morphs.map((m) => m.weight), [0, 0]);
});

test('gaze: yaw and pitch in LookAt space, through the range maps', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.5, 0, 1],
    rest = [0, 0, 0, 1],
    map = (inputMaxValue, outputScale) => ({ inputMaxValue, outputScale }),
    lookAt = {
      type: 'bone',
      offsetFromHeadBone: [0, 0.1, 0],
      rangeMapHorizontalInner: map(45, 5),
      rangeMapHorizontalOuter: map(45, 10),
      rangeMapVerticalDown: map(30, 6),
      rangeMapVerticalUp: map(30, 3),
    };
  const left = vrmGaze(lookAt, identity, rest, [1, 1.6, 1]);
  assert.ok(close(left.yaw, 45) && close(left.pitch, 0));
  const down = vrmGaze(lookAt, identity, rest, [0, 0.6, 1]);
  assert.ok(close(down.yaw, 0) && close(down.pitch, 45));
  const behind = vrmGaze(lookAt, identity, rest, [0, 1.6, -1]);
  assert.ok(close(Math.abs(behind.yaw), 180));
  // A head turned 90 degrees about y looks along +X; its rest rotation does not count as forward.
  const turned = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1.5, 0, 1];
  assert.ok(close(vrmGaze(lookAt, turned, rest, [1, 1.6, 0]).yaw, 0, 1e-4));
  const q = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  assert.ok(close(vrmGaze(lookAt, turned, q, [0, 1.6, 1]).yaw, 0, 1e-4));
  // The left eye's outer range is to the left, the right eye's inner one.
  const eyes = vrmEyeAngles(lookAt, { yaw: 22.5, pitch: -15 });
  assert.ok(close(eyes.left.yaw, 5) && close(eyes.right.yaw, 2.5));
  assert.ok(close(eyes.left.pitch, -1.5) && close(eyes.right.pitch, -1.5));
  const other = vrmEyeAngles(lookAt, { yaw: -90, pitch: 15 });
  assert.ok(close(other.left.yaw, -5) && close(other.right.yaw, -10), 'clamped at the input range');
  assert.ok(close(other.left.pitch, 3));
  const weights = vrmLookWeights({ ...lookAt, rangeMapHorizontalOuter: map(45, 1) }, { yaw: -22.5, pitch: 15 });
  assert.ok(close(weights.lookRight, 0.5) && weights.lookLeft === 0);
  assert.ok(close(weights.lookDown, 3) && weights.lookUp === 0);
  // An input range of 0 is all or nothing; no maps default to 90 degrees onto 0 to 1.
  assert.equal(vrmLookWeights({ rangeMapHorizontalOuter: map(0, 0.7) }, { yaw: 5, pitch: 0 }).lookLeft, 0.7);
  assert.equal(vrmLookWeights({ rangeMapHorizontalOuter: map(0, 0.7) }, { yaw: 0, pitch: 0 }).lookLeft, 0);
  assert.equal(vrmLookWeights({}, { yaw: 45, pitch: 0 }).lookLeft, 0.5);
});

test('every real spring chain runs: no bad number, lengths hold, the pose returns', () => {
  for (const source of [seed, twist]) {
    const doc = json(source),
      options = vrmSprings(readVRM(source)),
      parents = new Array(doc.nodes.length).fill(-1);
    doc.nodes.forEach((node, i) => node.children?.forEach((child) => (parents[child] = i)));
    const springs = new SpringBones(parents, options),
      fresh = () => {
        const local = new Float64Array(parents.length * 10);
        doc.nodes.forEach((node, i) => {
          local.set(node.translation ?? [0, 0, 0], i * 10);
          local.set(node.rotation ?? [0, 0, 0, 1], i * 10 + 3);
          local.set(node.scale ?? [1, 1, 1], i * 10 + 7);
        });
        return local;
      };
    assert.ok(options.chains.length >= 9);
    const hips = readVRM(source).humanoid.humanBones.hips.node;
    let last;
    for (let frame = 0; frame < 300; frame++) {
      const local = fresh();
      if (frame < 120) local[hips * 10] += 0.4 * Math.sin(frame / 8);
      springs.stepPose({ parents, local }, 1 / 60);
      for (const v of local) assert.ok(Number.isFinite(v));
      last = local;
    }
    assert.equal(last.length, parents.length * 10);
  }
});

async function setup(t, bytes) {
  const chunks = glbChunks(bytes),
    doc = json(bytes),
    store = await TransformStore.create(512),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    model = new PBRModel(engine, new GLTFAsset(doc, [chunks[1].data])),
    animation = new Animation(model);
  engine.use({ name: animation.name, setup() {} });
  t.after(() => {
    animation.dispose();
    model.dispose();
    engine.dispose();
  });
  return { engine, store, model, animation, doc };
}
const positionOf = (model, node) => Array.from(model.nodes[node].matrix.subarray(12, 15));

test('addVRM on real Seed-san: morphs, a texture move, the look expressions, hair, then dispose goes back', async (t) => {
  const { store, model, animation, doc } = await setup(t, seed),
    avatar = readVRM(doc),
    handle = addVRM(animation, avatar),
    { node, index } = avatar.expressions.preset.aa.morphTargetBinds[0],
    face = model.primitives.find((p) => p.nodeIndex === node),
    robo = model.primitives.find((p) => p.definition.material === 11).material,
    before = robo.uvt.slice();
  assert.deepEqual(handle.unsupported, []);
  handle.expressions.set('aa', 1).set('happy', 1);
  handle.update(1 / 60);
  assert.equal(face.weights[index], 1);
  assert.ok(close(robo.uvt[2], before[2] + 0.25), `offset ${robo.uvt[2]}`);
  // Look left of the model: Seed-san's gaze runs on expressions.
  store.tick(false);
  const head = positionOf(model, avatar.humanoid.humanBones.head.node);
  handle.lookAtTarget = [head[0] + 1, head[1] + 0.08, head[2] + 1.1];
  handle.update(1 / 60);
  assert.ok(handle.gaze.yaw > 30, `yaw ${handle.gaze.yaw}`);
  assert.ok(handle.expressions.get('lookLeft') > 0.3);
  const look = avatar.expressions.preset.lookLeft.morphTargetBinds[0];
  assert.ok(close(face.weights[look.index], handle.expressions.get('lookLeft')));
  // Hair: walk the model and the tip leaves its rest place, with every chain still finite.
  const chain = handle.springs.options.chains.at(-1),
    tip = chain.joints.at(-1),
    rootTip = () => {
      store.tick(false);
      return positionOf(model, tip);
    },
    rest = rootTip();
  let furthest = 0;
  for (let frame = 0; frame < 40; frame++) {
    model.root.setPosition([frame * 0.02, 0, 0]);
    handle.update(1 / 60);
    const now = rootTip();
    furthest = Math.max(furthest, Math.abs(now[0] - frame * 0.02 - rest[0]));
    assert.ok(now.every(Number.isFinite));
  }
  assert.ok(furthest > 1e-3, `tip moved ${furthest}`);
  handle.dispose();
  handle.dispose();
  assert.equal(face.weights[index], 0);
  assert.ok(close(robo.uvt[2], before[2]));
});

test('addVRM on the real pixiv sample: the eye bones follow the target by their range maps', async (t) => {
  const { store, model, animation, doc } = await setup(t, twist),
    avatar = readVRM(doc),
    handle = addVRM(animation, avatar, { springs: false }),
    { head, leftEye } = avatar.humanoid.humanBones,
    eye = model.nodes[leftEye.node],
    rest = [...doc.nodes[leftEye.node].rotation ?? [0, 0, 0, 1]];
  assert.equal(handle.springs, null);
  store.tick(false);
  const at = positionOf(model, head.node);
  handle.update(1 / 60);
  assert.equal(handle.gaze, null);
  handle.lookAtTarget = [at[0] + 2, at[1] + 0.061, at[2] + 2];
  handle.update(1 / 60);
  store.tick(false);
  // The left eye's outer range: 90 degrees onto 10.
  assert.ok(close(handle.gaze.yaw, 45, 1.5), `yaw ${handle.gaze.yaw}`);
  const t0 = store.transforms,
    id = eye.id,
    q = [t0.qx[id], t0.qy[id], t0.qz[id], t0.qw[id]],
    angle = 2 * Math.acos(Math.min(1, Math.abs(q[0] * rest[0] + q[1] * rest[1] + q[2] * rest[2] + q[3] * rest[3])));
  assert.ok(close((angle * 180) / Math.PI, handle.gaze.yaw / 9, 0.02), `eye turned ${(angle * 180) / Math.PI}`);
  handle.lookAtTarget = null;
  handle.update(1 / 60);
  assert.ok(close(t0.qw[id], rest[3], 1e-6));
  assert.throws(() => (handle.lookAtTarget = [0, NaN, 0]), /finite/);
  handle.dispose();
});

test('an avatar that does not fit the model is refused', async (t) => {
  const { animation, doc } = await setup(t, seed),
    avatar = readVRM(doc);
  avatar.expressions.preset.aa.morphTargetBinds[0].index = 999;
  assert.throws(() => addVRM(animation, avatar), /morph target 999/);
});

test('a model disposed first takes the avatar with it, and dispose after that does nothing', async (t) => {
  const { model, animation, doc } = await setup(t, seed),
    vrm = addVRM(animation, readVRM(doc));
  animation.dispose();
  model.dispose();
  assert.doesNotThrow(() => vrm.dispose());
});
