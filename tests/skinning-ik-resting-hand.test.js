import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset } from '../packages/gltf-pro/dist/index.js';
import { invertMatrixStable, multiplyMatrices } from '@margoengine/math/mat4';
import { meshSurfaceDistance, triangleTree, transformPoint } from './support/skinning-ik-clearance.js';

// The override permits checking a Blender candidate before replacing the asset.
const url = process.env.MARGO_HAND_TEST_ASSET
  ? pathToFileURL(resolve(process.env.MARGO_HAND_TEST_ASSET))
  : new URL('../examples/assets/skinning-ik.glb', import.meta.url);
const bytes = readFileSync(url), jsonLength = bytes.readUInt32LE(12);
const doc = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
const asset = new GLTFAsset(doc, [bytes.subarray(28 + jsonLength)]);
const skin = doc.skins[0], handSlot = skin.joints.findIndex(index => doc.nodes[index].name === 'RightHand');
const parts = doc.nodes.flatMap(node => JSON.parse(node.extras?.authored_parts ?? '[]'));
const materialName = primitive => doc.materials[primitive.material].name;
const rows = [];
for (const node of doc.nodes) {
  if (node.skin !== 0 || node.mesh === undefined) continue;
  for (const primitive of doc.meshes[node.mesh].primitives) {
    const attrs = primitive.attributes;
    rows.push({
      primitive, material: materialName(primitive),
      positions: asset.accessor(attrs.POSITION, 'VEC3'),
      normals: asset.accessor(attrs.NORMAL, 'VEC3'),
      joints: asset.accessor(attrs.JOINTS_0, 'VEC4'),
      weights: asset.accessor(attrs.WEIGHTS_0, 'VEC4'),
      indices: asset.accessor(primitive.indices, 'SCALAR'),
    });
  }
}
const position = (row, index) => Array.from(row.positions.subarray(index * 3, index * 3 + 3));
const weightFor = (row, index, slot) => {
  let weight = 0;
  for (let i = 0; i < 4; i++) if (row.joints[index * 4 + i] === slot) weight += row.weights[index * 4 + i];
  return weight;
};
const handPoints = rows.flatMap(row => Array.from({ length: row.positions.length / 3 }, (_, index) =>
  weightFor(row, index, handSlot) > 0.999 ? { row, index, point: position(row, index) } : null).filter(Boolean));
function trianglesFor(slots, predicate = () => true) {
  const triangles = [];
  for (const row of rows) for (let i = 0; i < row.indices.length; i += 3) {
    const indices = Array.from(row.indices.subarray(i, i + 3));
    if (!indices.every(index => slots.some(slot => weightFor(row, index, slot) > 0.999))) continue;
    const triangle = indices.map(index => position(row, index));
    if (predicate(triangle, row.material)) triangles.push(triangle);
  }
  return triangles;
}
const handTriangles = trianglesFor([handSlot]);
const bounds = points => [0, 1, 2].map(axis => [Math.min(...points.map(p => p[axis])), Math.max(...points.map(p => p[axis]))]);
const area = triangle => {
  const a = triangle[1].map((v, i) => v - triangle[0][i]);
  const b = triangle[2].map((v, i) => v - triangle[0][i]);
  return Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]) / 2;
};

test('resting hand retains the existing skeleton and exports its articulated parts in the robot palette', () => {
  assert.equal(doc.skins.length, 1);
  assert.deepEqual(skin.joints, [16, 15, 8, 11, 10, 9, 14, 13, 12], 'repair must not reorder existing joint slots');
  assert.deepEqual(skin.joints.map(index => doc.nodes[index].name),
    ['Root', 'Body', 'Head', 'RightUpperArm', 'RightForearm', 'RightHand', 'UpperArm', 'Forearm', 'Hand']);
  assert.deepEqual(doc.nodes[11].children, [10]);
  assert.deepEqual(doc.nodes[10].children, [9]);
  assert.equal(handSlot, 5);
  for (const prefix of ['Right curved resting palm', 'Right palm porcelain back armor',
    'Right relaxed finger phalange 0', 'Right relaxed finger phalange 1', 'Right relaxed finger phalange 2',
    'Right relaxed finger pad', 'Right opposing relaxed thumb phalange', 'Right opposing relaxed thumb pad'])
    assert.ok(parts.some(name => name.startsWith(prefix)), prefix);
  const materials = new Set(handPoints.map(value => value.row.material));
  assert.deepEqual([...materials].sort(), ['Light keeper / copper joints', 'Light keeper / flexible charcoal bellows',
    'Light keeper / oxidized teal', 'Light keeper / porcelain enamel'].sort());
  for (const row of rows.filter(row => handPoints.some(value => value.row === row))) {
    const material = doc.materials[row.primitive.material];
    assert.equal(material.alphaMode ?? 'OPAQUE', 'OPAQUE');
    assert.equal(material.doubleSided, true);
  }
});

test('actual resting-hand surfaces contain three separated fingers, an opposed thumb, a palm and a backplate', () => {
  // An actual horizontal triangle cross-section below the cuff distinguishes
  // three fingers from a renamed block or three coincident pieces.
  const intervals = [], height = 0.599;
  for (const triangle of handTriangles) {
    const hits = [];
    for (let i = 0; i < 3; i++) {
      const a = triangle[i], b = triangle[(i + 1) % 3];
      if ((a[1] < height) === (b[1] < height) || a[1] === b[1]) continue;
      const t = (height - a[1]) / (b[1] - a[1]);
      hits.push(a[0] + (b[0] - a[0]) * t);
    }
    if (hits.length >= 2) intervals.push([Math.min(...hits), Math.max(...hits)]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const bands = [];
  for (const interval of intervals) {
    const previous = bands.at(-1);
    if (previous && interval[0] <= previous[1] + 1e-5) previous[1] = Math.max(previous[1], interval[1]);
    else bands.push([...interval]);
  }
  assert.equal(bands.length, 3, JSON.stringify(bands));
  for (let i = 0; i < 3; i++) {
    assert.ok(bands[i][1] - bands[i][0] > 0.008, 'each finger has real surface width');
    assert.ok(bands[i][1] - bands[i][0] < 0.03);
    if (i) assert.ok(bands[i][0] - bands[i - 1][1] > 0.006, 'fingers remain visibly separated');
  }
  const thumb = handTriangles.filter(triangle => triangle.every(point => point[0] > 0.344 && point[1] < 0.666));
  assert.ok(thumb.reduce((sum, triangle) => sum + area(triangle), 0) > 0.001, 'thumb extends to the opposite side as a surface');
  assert.ok(bounds(thumb.flat())[0][1] > 0.37, 'opposed thumb extends beyond the palm');
  const palm = trianglesFor([handSlot], (triangle, material) => material.endsWith('charcoal bellows')
    && triangle.every(point => point[1] > 0.632 && point[1] < 0.669 && point[2] > -0.124 && point[2] < -0.060));
  const palmBounds = bounds(palm.flat());
  assert.ok(palmBounds[0][1] - palmBounds[0][0] > 0.09, 'palm spans the finger roots');
  assert.ok(palm.reduce((sum, triangle) => sum + area(triangle), 0) > 0.004, 'palm is a curved surface, not a marker');
  const back = trianglesFor([handSlot], (triangle, material) => material.endsWith('porcelain enamel')
    && triangle.every(point => point[1] > 0.628 && point[1] < 0.682 && point[2] > -0.047 && point[2] < -0.023));
  const backBounds = bounds(back.flat());
  assert.ok(backBounds[0][1] - backBounds[0][0] > 0.08 && backBounds[1][1] - backBounds[1][0] > 0.04);
  assert.ok(back.reduce((sum, triangle) => sum + area(triangle), 0) > 0.004);
});

test('resting-hand vertices stay finite and rigidly assigned to RightHand, with free digits clear of the arm and body', () => {
  assert.ok(handPoints.length > 0);
  for (const { row, index, point } of handPoints) {
    assert.ok(point.every(Number.isFinite));
    assert.ok(Array.from(row.normals.subarray(index * 3, index * 3 + 3)).every(Number.isFinite));
    assert.equal(weightFor(row, index, handSlot), 1);
    for (let i = 0; i < 4; i++) {
      const weight = row.weights[index * 4 + i];
      assert.ok(Number.isFinite(weight) && weight >= 0);
      if (weight > 0) assert.equal(row.joints[index * 4 + i], handSlot);
    }
  }
  const box = bounds(handPoints.map(value => value.point));
  assert.ok(box[0][0] > 0.23 && box[0][1] < 0.39 && box[1][0] > 0.55 && box[1][1] < 0.76);
  assert.ok(box[2][0] > -0.16 && box[2][1] < 0);
  const bodySlot = skin.joints.findIndex(index => doc.nodes[index].name === 'Body');
  const forearmSlot = skin.joints.findIndex(index => doc.nodes[index].name === 'RightForearm');
  const digits = handTriangles.filter(triangle => triangle.every(point => point[1] < 0.625));
  assert.ok(digits.length > 0);
  assert.ok(meshSurfaceDistance(digits, triangleTree(trianglesFor([forearmSlot]))) > 0.015,
    'free fingers must not emerge inside the forearm; the bonded wrist bearing is intentionally excluded');
  assert.ok(meshSurfaceDistance(handTriangles, triangleTree(trianglesFor([bodySlot]))) > 0.02,
    'resting hand must clear the actual torso surface');
});

test('resting-hand surfaces clear fixed Root-weighted hips and thighs at sampled torso-assist poses', (t) => {
  const rootSlot = skin.joints.findIndex(index => doc.nodes[index].name === 'Root');
  const lowerBody = triangleTree(trianglesFor([rootSlot]));
  // Body's authored rest axes are model-aligned. TorsoAim rotates this frame
  // about Y; the inactive arm has no independent flare in the current adapter.
  const body = doc.nodes.find(node => node.name === 'Body');
  assert.deepEqual(body.rotation ?? [0, 0, 0, 1], [0, 0, 0, 1]);
  const pivot = body.translation;
  let minimum = Infinity, worstYaw = 0;
  const yawSamples = [...Array.from({ length: 13 }, (_, index) => -index * (46 * Math.PI / 180) / 12), -0.85];
  for (const yaw of yawSamples) {
    const cosine = Math.cos(yaw), sine = Math.sin(yaw);
    const posed = handTriangles.map(triangle => triangle.map(point => {
      const x = point[0] - pivot[0], z = point[2] - pivot[2];
      return [pivot[0] + cosine * x + sine * z, point[1], pivot[2] - sine * x + cosine * z];
    }));
    const gap = meshSurfaceDistance(posed, lowerBody);
    assert.ok(gap > 0.003, `hand/Root clearance ${gap} at torso yaw ${yaw}`);
    if (gap < minimum) { minimum = gap; worstYaw = yaw; }
  }
  t.diagnostic(`minimum hand/Root gap ${(minimum * 1000).toFixed(3)} mm at ${(worstYaw * 180 / Math.PI).toFixed(3)} degrees`);
});

test('exported resting-hand skin follows torso and arm transforms without changing its rigid dimensions', async () => {
  const store = await TransformStore.create(doc.nodes.length + 8);
  const engine = new Engine({ width: 1, height: 1, clientWidth: 1, clientHeight: 1 }, store,
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} });
  try {
    const root = engine.createMesh();
    const nodes = doc.nodes.map(node => engine.createMesh().setParent(root)
      .setPosition(node.translation ?? [0, 0, 0]).setQuaternion(node.rotation ?? [0, 0, 0, 1]).setScale(node.scale ?? [1, 1, 1]));
    doc.nodes.forEach((node, parent) => node.children?.forEach(child => nodes[child].setParent(nodes[parent])));
    store.tick(false);
    const inverseRest = new Float64Array(16), workspace = new Float64Array(52);
    assert.ok(invertMatrixStable(nodes[9].matrix, inverseRest, workspace));
    const bind = asset.accessor(skin.inverseBindMatrices, 'MAT4').subarray(handSlot * 16, handSlot * 16 + 16);
    const palette = new Float32Array(16);
    const restUpper = doc.nodes[11].rotation;
    for (let step = 0; step < 24; step++) {
      root.setPosition([1.2, -0.4, 2]).setRotation([0.2, -0.4, 0.3]).setScale([1.7, 1.7, 1.7]);
      nodes[15].setRotation([0, step * (46 * Math.PI / 180) / 23, 0]);
      const sine = Math.sin(step * 0.003), cosine = Math.cos(step * 0.003);
      nodes[11].setQuaternion([restUpper[0] * cosine + restUpper[3] * sine,
        restUpper[1] * cosine - restUpper[2] * sine, restUpper[2] * cosine + restUpper[1] * sine,
        restUpper[3] * cosine - restUpper[0] * sine]);
      store.tick(false);
      multiplyMatrices(nodes[9].matrix, bind, palette);
      for (const { point } of handPoints) {
        const skinned = transformPoint(palette, point);
        const expected = transformPoint(nodes[9].matrix, transformPoint(inverseRest, point));
        assert.ok(skinned.every(Number.isFinite));
        assert.ok(Math.hypot(...skinned.map((value, axis) => value - expected[axis])) < 2e-6,
          'all hand surfaces must follow the existing wrist bind frame');
      }
    }
  } finally { engine.dispose(); }
});
