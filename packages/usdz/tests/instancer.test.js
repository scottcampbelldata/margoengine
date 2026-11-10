import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUSDA } from '../dist/index.js';
import { pointInstancers } from '../dist/instancer.js';
import { composition } from '../dist/compose.js';
import { readFileSync } from 'node:fs';
import { pose } from './pose.js';

test('sampled transforms and masks match OpenUSD 26.11 public API', () => {
  const text = readFileSync(new URL('./fixtures/instancer.usda', import.meta.url), 'utf8');
  const truth = JSON.parse(readFileSync(new URL('./fixtures/instancer-openusd.json', import.meta.url), 'utf8'));
  for (const [timeCode, expected] of Object.entries(truth)) {
    const asset = parseUSDA(text, { extensions: [composition(), pointInstancers({ timeCode: Number(timeCode) })] });
    const state = pose(asset, 0);
    const actual = asset.document.nodes.flatMap((node, id) =>
      node.mesh !== undefined && state.world[id] ? [state.world[id]] : [],
    );
    assert.equal(actual.length, expected.length);
    actual.forEach((m, i) =>
      m.forEach((v, k) =>
        assert.ok(Math.abs(v - expected[i][k]) < 1e-5, `${timeCode} matrix ${k}: ${v} != ${expected[i][k]}`),
      ),
    );
  }
});
const mesh = `def Mesh "Prop" {
 uniform token subdivisionScheme = "none"
 point3f[] points = [(0,0,0),(1,0,0),(0,1,0)]
 int[] faceVertexCounts = [3]
 int[] faceVertexIndices = [0,1,2]
 double3 xformOp:translate = (0,0,2)
 uniform token[] xformOpOrder = ["xformOp:translate"]
}`;
const stage = (attrs, options) =>
  parseUSDA(
    `#usda 1.0
(metersPerUnit = 1 upAxis = "Y" timeCodesPerSecond = 24)
def PointInstancer "Scatter" {
 rel prototypes = </Scatter/Prop>
 ${attrs}
 ${mesh}
}`,
    { extensions: [composition(), pointInstancers(options)] },
  );
test('scatter shares mesh and preserves prototype transforms, masks stable IDs and removes prototype draw', () => {
  const { document: d, meshes } = stage(`int[] protoIndices = [0,0,0]
 point3f[] positions = [(1,2,3),(4,5,6),(7,8,9)]
 float3[] scales = [(2,3,4),(1,1,1),(1,1,1)]
 int64[] ids = [10,20,30]
 int64[] invisibleIds = [20]
 quath[] orientations = [(0.70710678,0,0,0.70710678),(1,0,0,0),(1,0,0,0)]`);
  const scatter = d.nodes[1],
    instances = scatter.children.map((i) => d.nodes[i]);
  assert.equal(instances.length, 2);
  assert.equal(meshes.length, 1);
  assert.equal(d.meshes.length, 1);
  assert.deepEqual(
    instances.map((n) => n.extras.usdInstanceId),
    [10, 30],
  );
  assert.deepEqual(instances[0].translation, [1, 2, 3]);
  assert.deepEqual(instances[0].scale, [2, 3, 4]);
  assert.ok(Math.abs(instances[0].rotation[2] - Math.SQRT1_2) < 1e-6);
  for (const n of instances) {
    const proto = d.nodes[n.children[0]];
    assert.equal(proto.mesh, 0);
    assert.equal(proto.matrix[14], 2);
  }
  assert.ok(!scatter.children.includes(2));
});
test('sample interpolation, velocity and acceleration use stage seconds', () => {
  const attrs = `int[] protoIndices = [0]
 point3f[] positions.timeSamples = {0:[(0,0,0)],24:[(24,0,0)]}
 vector3f[] velocities = [(2,0,0)]
 vector3f[] accelerations = [(4,0,0)]`;
  const d = stage(attrs, { timeCode: 12 }).document;
  const n = d.nodes.find((n) => n.extras?.usdInstanceId === 0);
  assert.deepEqual(n.translation, [1.5, 0, 0]);
  const interpolated = stage(attrs.replace('vector3f[] velocities = [(2,0,0)]', ''), { timeCode: 12 }).document;
  assert.equal(interpolated.nodes.find((n) => n.extras?.usdInstanceId === 0).translation[0], 12);
});
test('reject malformed arrays, selector, orientation and expansion budget', () => {
  assert.throws(() => stage('int[] protoIndices = [0] point3f[] positions = []'), /count/);
  assert.throws(() => stage('int[] protoIndices = [1] point3f[] positions = [(0,0,0)]'), /index/);
  assert.throws(() => stage('int[] protoIndices = [0] point3f[] positions = [(0,0,0)]', { maxNodes: 1 }), /budget/);
  assert.throws(() => pointInstancers({ timeCode: NaN }), RangeError);
});
test('angular velocity uses orientationsf sample time and the lower orientation', () => {
  const d = stage(
    `int[] protoIndices = [0]
point3f[] positions = [(0,0,0)]
quatf[] orientationsf.timeSamples = {0:[(1,0,0,0)],24:[(0.70710678,0,0,0.70710678)]}
vector3f[] angularVelocities = [(0,0,90)]`,
    { timeCode: 12 },
  ).document;
  const q = d.nodes.find((n) => n.extras?.usdInstanceId === 0).rotation;
  assert.ok(Math.abs(q[2] - Math.sin(Math.PI / 8)) < 1e-6);
  assert.ok(Math.abs(q[3] - Math.cos(Math.PI / 8)) < 1e-6);
});
test('arbitrary prototype hierarchy shares descendants and external prototypes stay in the scene', () => {
  const a = parseUSDA(
    `#usda 1.0
 ${mesh}
 def PointInstancer "Scatter" {
 rel prototypes = </Prop>
 int[] protoIndices = [0,0]
 point3f[] positions = [(0,0,0),(2,0,0)]
 }`,
    { extensions: [pointInstancers()] },
  );
  assert.equal(a.document.nodes[0].children.length, 2);
  assert.equal(a.document.nodes.filter((n) => n.mesh === 0).length, 3);
});
