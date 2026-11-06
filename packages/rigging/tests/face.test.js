// Face tracking onto characters: names, frames, smoothing, gain and mirror as plain data, morph targets on a stand-in
// model (no real model with these names was found), and a real avatar's expressions through VRM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { Animation } from '../../animation/dist/index.js';
import { GLB_BIN, GLB_JSON, glbChunks } from '../../shared/glb.js';
import { addVRM, readVRM } from '../dist/vrm.js';
import { FACE_SHAPES, FaceMapper, addFace, faceShapeOf, vrmFaceExpressions } from '../dist/face.js';

const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not ${b}`);

test('the 52 names: unique, and none hides inside another', () => {
  assert.equal(FACE_SHAPES.length, 52);
  assert.equal(new Set(FACE_SHAPES).size, 52);
  for (const shape of FACE_SHAPES) assert.equal(faceShapeOf(shape), shape);
  for (const shape of FACE_SHAPES) assert.equal(faceShapeOf(`a.${shape}`), shape, 'with a prefix');
  for (const shape of FACE_SHAPES) assert.equal(faceShapeOf(shape.toUpperCase()), shape, 'in capitals');
});

test('names from other tools read as the shape', () => {
  for (const [name, shape] of [
    ['EyeBlinkLeft', 'eyeBlinkLeft'],
    ['eye_blink_left', 'eyeBlinkLeft'],
    ['eyeBlink_L', 'eyeBlinkLeft'],
    ['eyeBlinkR', 'eyeBlinkRight'],
    ['blendShape1.ARKit_jawOpen', 'jawOpen'],
    ['Face.mouth-smile-right', 'mouthSmileRight'],
    ['mouth_L', 'mouthLeft'],
    ['tongueOut', 'tongueOut'],
  ])
    assert.equal(faceShapeOf(name), shape, name);
  for (const name of ['_neutral', 'Target 0', 'smile', 'blink', '']) assert.equal(faceShapeOf(name), null, name);
});

test('both frame shapes, unknown names ignored, left out shapes hold', () => {
  const mapper = new FaceMapper({ smoothing: 0 });
  mapper.push({ jawOpen: 0.5, somethingElse: 3 }).update(0.016);
  near(mapper.get('jawOpen'), 0.5);
  mapper
    .push([
      { categoryName: '_neutral', score: 1 },
      { categoryName: 'eyeBlinkLeft', score: 0.25 },
    ])
    .update(0.016);
  near(mapper.get('eyeBlinkLeft'), 0.25);
  near(mapper.get('jawOpen'), 0.5, 1e-6);
  mapper.push(null).update(0.016);
  near(mapper.get('jawOpen'), 0);
  assert.throws(() => mapper.push({ jawOpen: NaN }), RangeError);
  assert.throws(() => mapper.push(7), TypeError);
  assert.throws(() => mapper.get('smile'), RangeError);
  assert.throws(() => mapper.update(-1), RangeError);
});

test('smoothing is the same at any frame rate and eases from where it is', () => {
  const run = (frames) => {
    const mapper = new FaceMapper({ smoothing: 0.1 }).push({ jawOpen: 1 });
    for (let i = 0; i < frames; i++) mapper.update(0.2 / frames);
    return mapper.get('jawOpen');
  };
  near(run(2), 1 - Math.exp(-2), 1e-6);
  near(run(2), run(20), 1e-5);
  const mapper = new FaceMapper({ smoothing: 0.1 }).push({ jawOpen: 1 }).update(0);
  assert.equal(mapper.get('jawOpen'), 0, 'no time, no move');
  mapper.update(1e6);
  near(mapper.get('jawOpen'), 1);
  mapper.reset();
  assert.equal(mapper.get('jawOpen'), 0);
  mapper.update(1);
  assert.equal(mapper.get('jawOpen'), 0, 'reset forgets the frame');
});

test('gain scales and clamps, mirror swaps sides and leaves the middle', () => {
  const all = new FaceMapper({ smoothing: 0, gain: 2 }).push({ jawOpen: 0.3, cheekPuff: 0.8 }).update(1);
  near(all.get('jawOpen'), 0.6);
  near(all.get('cheekPuff'), 1);
  const one = new FaceMapper({ smoothing: 0, gain: { jawOpen: 0.5 } }).push({ jawOpen: 1, cheekPuff: 1 }).update(1);
  near(one.get('jawOpen'), 0.5);
  near(one.get('cheekPuff'), 1);
  const mirrored = new FaceMapper({ smoothing: 0, mirror: true })
    .push({ eyeBlinkLeft: 1, mouthSmileRight: 0.5, jawOpen: 0.25, jawLeft: 0.75 })
    .update(1);
  near(mirrored.get('eyeBlinkRight'), 1);
  near(mirrored.get('eyeBlinkLeft'), 0);
  near(mirrored.get('mouthSmileLeft'), 0.5);
  near(mirrored.get('jawOpen'), 0.25);
  near(mirrored.get('jawRight'), 0.75);
  assert.throws(() => new FaceMapper({ smoothing: -1 }), RangeError);
  assert.throws(() => new FaceMapper({ gain: -1 }), RangeError);
  assert.throws(() => new FaceMapper({ gain: { smile: 1 } }), RangeError);
  assert.throws(() => new FaceMapper({ gain: { jawOpen: Infinity } }), RangeError);
  assert.throws(() => new FaceMapper({ gain: 'loud' }), TypeError);
});

test('VRM presets from the 52: blinks split, gaze averaged, nothing past 1', () => {
  const mapper = new FaceMapper({ smoothing: 0 })
      .push({
        eyeBlinkLeft: 1,
        eyeBlinkRight: 0.25,
        eyeLookOutLeft: 0.6,
        eyeLookInRight: 0.4,
        jawOpen: 0.7,
        mouthSmileLeft: 1,
        mouthSmileRight: 0.5,
      })
      .update(1),
    v = vrmFaceExpressions((shape) => mapper.get(shape));
  near(v.blink, 0.25);
  near(v.blinkLeft, 0.75);
  near(v.blinkRight, 0);
  near(v.lookLeft, 0.5);
  near(v.lookRight, 0);
  near(v.aa, 0.7);
  near(v.happy, 0.75);
  assert.equal(v.relaxed, undefined);
  for (const value of Object.values(v)) assert.ok(value >= 0 && value <= 1);
});

const file = (path) => readFileSync(new URL(`../../../examples/assets/${path}`, import.meta.url));

async function host(t, doc, bin) {
  const store = await TransformStore.create(512),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    model = new PBRModel(engine, new GLTFAsset(doc, bin)),
    animation = new Animation(model);
  engine.use({ name: animation.name, setup() {} });
  t.after(() => {
    animation.dispose();
    model.dispose();
    engine.dispose();
  });
  return { engine, model, animation };
}

/** The Fox with stand-in morph targets named by `names`: no real model with these shape names was found. */
function foxWithNames(names) {
  const chunks = glbChunks(new Uint8Array(file('khronos/Fox/Fox.glb'))),
    doc = JSON.parse(new TextDecoder().decode(chunks.find((c) => c.type === GLB_JSON).data)),
    bin = chunks.find((c) => c.type === GLB_BIN).data,
    mesh = doc.meshes[0],
    vertices = doc.accessors[mesh.primitives[0].attributes.POSITION].count,
    delta = new Float32Array(vertices * 3);
  doc.buffers = [{ byteLength: bin.byteLength }, { byteLength: delta.byteLength }];
  doc.bufferViews.push({ buffer: 1, byteLength: delta.byteLength });
  doc.accessors.push({
    bufferView: doc.bufferViews.length - 1,
    componentType: 5126,
    count: vertices,
    type: 'VEC3',
    min: [0, 0, 0],
    max: [0, 0, 0],
  });
  const accessor = doc.accessors.length - 1;
  mesh.primitives[0].targets = names.map(() => ({ POSITION: accessor }));
  mesh.weights = names.map(() => 0);
  mesh.extras = { targetNames: names };
  return { doc, buffers: [new Uint8Array(bin), new Uint8Array(delta.buffer)], node: doc.nodes.findIndex((n) => n.mesh === 0) };
}

test('stand-in morph targets found by name, map for the rest, and back to neutral', async (t) => {
  const f = foxWithNames(['ARKit_jawOpen', 'eyeBlink_L', 'Brow_Sad', 'Other']),
    { model, animation } = await host(t, f.doc, f.buffers),
    primitive = model.primitives.find((p) => p.nodeIndex === f.node),
    face = addFace(animation, { smoothing: 0, map: { browInnerUp: 'Brow_Sad' } });
  assert.deepEqual([...face.matched].sort(), ['browInnerUp', 'eyeBlinkLeft', 'jawOpen']);
  assert.equal(face.missing.length, 49);
  face.push({ jawOpen: 0.5, eyeBlinkLeft: 1, browInnerUp: 0.25 });
  face.update(1 / 60);
  assert.deepEqual(Array.from(primitive.weights), [0.5, 1, 0.25, 0]);
  face.dispose();
  assert.deepEqual(Array.from(primitive.weights), [0, 0, 0, 0]);
  face.dispose();
});

test('a model with nothing to drive is told so, and bad settings are refused', async (t) => {
  const f = foxWithNames(['Other']),
    { animation } = await host(t, f.doc, f.buffers);
  assert.throws(() => addFace(animation), { code: 'state' });
  assert.throws(() => addFace(animation, { map: { smile: 'Other' } }), RangeError);
  assert.throws(() => addFace(animation, { smoothing: -1 }), RangeError);
  const face = addFace(animation, { map: { jawOpen: ['Other'] } });
  assert.deepEqual(face.matched, ['jawOpen']);
  face[Symbol.dispose]();
});

test('Seed-san: tracker frames drive a real avatar through its expressions', async (t) => {
  const bytes = new Uint8Array(file('vrm/Seed-san.vrm')),
    chunks = glbChunks(bytes),
    doc = JSON.parse(new TextDecoder().decode(chunks[0].data)),
    { animation, model } = await host(t, doc, [chunks[1].data]),
    avatar = readVRM(doc),
    vrm = addVRM(animation, avatar, { springs: false }),
    face = addFace(animation, { vrm, smoothing: 0 });
  assert.deepEqual(face.matched, []);
  const bind = avatar.expressions.preset.blink.morphTargetBinds[0],
    primitive = model.primitives.find((p) => p.nodeIndex === bind.node);
  assert.equal(primitive.weights[bind.index], 0);
  face.push({ eyeBlinkLeft: 1, eyeBlinkRight: 1 });
  face.update(1 / 60);
  vrm.update(1 / 60);
  assert.ok(primitive.weights[bind.index] > 0.9, `${primitive.weights[bind.index]}`);
  assert.equal(vrm.expressions.get('blink'), 1);
  face.dispose();
  vrm.update(1 / 60);
  assert.equal(primitive.weights[bind.index], 0);
  vrm.dispose();
});
