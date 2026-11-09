// Node transforms are JSON numbers: translations, rotations, scales and matrices keep every finite JavaScript number
// as given (no Float32 rounding, underflow or range limit), through TRS, matrices, hierarchy and the keyframe helpers'
// rest poses. Geometry and animation accessors stay Float32, as glTF requires.
import test from 'node:test';
import assert from 'node:assert/strict';
import { animateCels, animatePlacements, animateTransforms, exportGLB, exportGLTF } from '../dist/index.js';
import { accessor, readGLB, validate } from './helpers.js';

const quad = () => ({
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2],
});
const big = [16_777_217, -16_777_217, 0.1];
// Exactly unit to within 1e-16, with digits Float32 cannot hold.
const turn = [0, Math.sin(0.3), 0, Math.cos(0.3)];

test('TRS, matrix and hierarchy JSON keep exact double values', async () => {
  const child = {
      name: 'Child',
      translation: [0.1, 0.2, 0.30000000000000004],
      scale: [1e-50, -2.5, 1 / 3],
      geometry: quad(),
    },
    matrix = [
      Math.cos(0.7),
      Math.sin(0.7),
      0,
      0,
      -Math.sin(0.7),
      Math.cos(0.7),
      0,
      0,
      0,
      0,
      1 / 3,
      0,
      16_777_217,
      -16_777_217,
      0.1,
      1,
    ],
    scene = {
      nodes: [
        { name: 'Pose', translation: big, rotation: turn, scale: [1e-50, 1, 1], children: [child] },
        { name: 'Placed', matrix, children: [{ name: 'Deep', translation: [-1e300, 1e300, 5e-324] }] },
        { name: 'Mirror', scale: [-1, 1, 1], rotation: [0, 0, 0, -1], geometry: quad() },
      ],
    },
    before = structuredClone(scene),
    glb = exportGLB(scene),
    report = await validate(glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  assert.deepEqual(scene, before, 'inputs unchanged');
  const { json } = readGLB(glb),
    node = (name) => json.nodes.find((n) => n.name === name);
  assert.deepEqual(node('Pose').translation, [16_777_217, -16_777_217, 0.1]);
  assert.deepEqual(node('Pose').rotation, turn);
  assert.deepEqual(node('Pose').scale, [1e-50, 1, 1]);
  assert.deepEqual(node('Child').translation, [0.1, 0.2, 0.30000000000000004]);
  assert.deepEqual(node('Child').scale, [1e-50, -2.5, 1 / 3]);
  assert.deepEqual(node('Placed').matrix, matrix);
  assert.deepEqual(node('Deep').translation, [-1e300, 1e300, 5e-324]);
  assert.deepEqual(node('Mirror').rotation, [0, 0, 0, -1], 'a negative-w unit quaternion keeps its sign');
  assert.deepEqual(node('Mirror').scale, [-1, 1, 1]);
  // The same numbers through the .gltf writer.
  const { json: text } = exportGLTF(scene);
  assert.deepEqual(text.nodes[0].translation, big);
  assert.deepEqual(text.nodes.find((n) => n.name === 'Placed').matrix, matrix);
});

test('validation still refuses nonfinite values, bad shapes, partial zero scale and sheared matrices', () => {
  const node = (more) => ({ nodes: [{ geometry: quad(), ...more }] });
  for (const bad of [Number.NaN, Infinity, -Infinity])
    assert.throws(() => exportGLB(node({ translation: [bad, 0, 0] })), RangeError);
  assert.throws(() => exportGLB(node({ translation: [0, 0] })), TypeError);
  assert.throws(() => exportGLB(node({ translation: [0, 0, '1'] })), RangeError);
  assert.throws(() => exportGLB(node({ scale: [1e-50, 0, 1] })), /Scale must be nonzero/);
  assert.throws(() => exportGLB(node({ rotation: [0, 0, 0, 0] })), /Quaternion must be nonzero/);
  assert.throws(() => exportGLB(node({ matrix: [1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })), /shear/);
  assert.throws(() => exportGLB(node({ matrix: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })), /affine/);
  assert.throws(() => exportGLB(node({ matrix: new Array(15).fill(0) })), TypeError);
  // [0, 0, 0] still collapses a hidden node.
  assert.deepEqual(readGLB(exportGLB(node({ scale: [0, 0, 0] }))).json.nodes[0].scale, [0, 0, 0]);
  // A rotation off unit length by more than 1e-5 is scaled to unit length, its sign kept.
  assert.deepEqual(readGLB(exportGLB(node({ rotation: [0, 0, 0, -2] }))).json.nodes[0].rotation, [0, 0, 0, -1]);
});

test('keyframe helpers keep the saved base placement exactly; channel keys stay Float32', async () => {
  const clip = { fps: 10, frames: [0, 1] },
    pose = { translation: big, rotation: turn, scale: [1e-30, 1, 1] },
    model = { name: 'Model', geometry: quad() },
    cels = [{ name: 'Cel1', geometry: quad() }, { name: 'Cel2' }],
    placed = { name: 'Placed', geometry: quad() },
    m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 16_777_217, -16_777_217, 0.1, 1],
    poses = [pose, { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
    before = structuredClone(poses);
  const channels = [
    ...animateTransforms(model, clip, poses),
    ...animateCels(cels, clip, [1, 0]),
    ...animatePlacements(placed, clip, [m, null]),
  ];
  assert.deepEqual(poses, before, 'poses unchanged');
  const glb = exportGLB({ nodes: [model, { name: 'Cels', children: cels }, placed], animations: [{ channels }] }),
    report = await validate(glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  const { json, bin } = readGLB(glb),
    node = (name) => json.nodes.find((n) => n.name === name);
  assert.deepEqual(node('Model').translation, big);
  assert.deepEqual(node('Model').rotation, turn);
  assert.deepEqual(node('Model').scale, [1e-30, 1, 1]);
  assert.deepEqual(node('Cel1').scale, [0, 0, 0]);
  assert.deepEqual(node('Cel2').scale, [1, 1, 1], 'shown at the first key, written as set');
  assert.deepEqual(node('Placed').translation, big);
  // The binary keys are Float32 accessors: 16,777,217 is stored as 16,777,216.
  const channel = json.animations[0].channels.find(
      (c) => c.target.node === json.nodes.indexOf(node('Model')) && c.target.path === 'translation',
    ),
    sampler = json.animations[0].samplers[channel.sampler];
  assert.equal(json.accessors[sampler.output].componentType, 5126);
  assert.deepEqual([...accessor(json, bin, sampler.output)].slice(0, 3), big.map(Math.fround));
});

test('material factors are exact JSON numbers; given transform fields are written even at their defaults', async () => {
  const material = { color: [0.1, 0.2, 0.3, 1], metalness: 0.8, roughness: 0.35, emissive: [0.65, 0, 0.1] },
    glb = exportGLB({
      nodes: [
        {
          name: 'Given',
          translation: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
          geometry: quad(),
          material,
        },
        { name: 'Omitted', geometry: quad() },
      ],
    }),
    report = await validate(glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  const { json } = readGLB(glb);
  assert.deepEqual(json.materials[0].pbrMetallicRoughness, {
    baseColorFactor: [0.1, 0.2, 0.3, 1],
    metallicFactor: 0.8,
    roughnessFactor: 0.35,
  });
  assert.deepEqual(json.materials[0].emissiveFactor, [0.65, 0, 0.1]);
  assert.deepEqual(
    [json.nodes[0].translation, json.nodes[0].rotation, json.nodes[0].scale],
    [
      [0, 0, 0],
      [0, 0, 0, 1],
      [1, 1, 1],
    ],
  );
  assert.deepEqual(Object.keys(json.nodes[1]), ['name', 'mesh']);
});
