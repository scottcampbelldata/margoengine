import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MeshBVH } from '@margoengine/bvh/tree';
import { buildSleeve, clearGarmentLayer, inspectGarment, measureCuff } from '../dist/wardrobe.js';

const stations = [
  { centre: [0, 0, 0], radii: [0.07, 0.06], forearm: 0 },
  { centre: [0, 0, 0.25], radii: [0.06, 0.05], forearm: 0.5 },
  { centre: [0, 0, 0.5], radii: [0.04, 0.035], forearm: 1 },
];
const options = { segments: 16, thickness: 0.003, turnback: 0.012, upperJoint: 18, forearmJoint: 19 };

test('a tailored sleeve has a sewn armhole and an open wrist with a folded lip', () => {
  const sleeve = buildSleeve(stations, options);
  const topology = inspectGarment(sleeve);
  assert.equal(topology.zeroAreaFaces, 0);
  assert.equal(topology.nonManifoldEdges, 0);
  assert.equal(topology.inconsistentEdges, 0);
  assert.deepEqual(
    topology.openings.map((ring) => ring.length),
    [16, 16],
  );
  const wrist = measureCuff(sleeve.positions, topology.openings[1], [0, 0, 0.25], [0, 0, 0.5]);
  assert.ok(Math.abs(wrist.axialOffset + 0.012) < 1e-6);
  assert.ok(wrist.radialOffset < 1e-6);
  assert.ok(wrist.minimumRadius >= 0.032 * Math.cos(Math.PI / 16) - 1e-6);
  assert.ok(wrist.minimumRadius < 0.032);
  const elbowVertex = (options.segments + 1) * 4;
  assert.deepEqual(Array.from(sleeve.joints.slice(elbowVertex, elbowVertex + 4)), [18, 19, 0, 0]);
  assert.deepEqual(Array.from(sleeve.weights.slice(elbowVertex, elbowVertex + 4)), [0.5, 0.5, 0, 0]);
});

test('an otherwise centred sleeve can still end high on the forearm', () => {
  const shortened = stations.map(({ centre, ...station }) => ({
    ...station,
    centre: [centre[0], centre[1], centre[2] * 0.8],
  }));
  const sleeve = buildSleeve(shortened, options);
  const opening = inspectGarment(sleeve).openings[1];
  const wrist = measureCuff(sleeve.positions, opening, [0, 0, 0.25], [0, 0, 0.5]);
  assert.ok(Math.abs(wrist.axialOffset + 0.112) < 1e-6);
  assert.ok(wrist.radialOffset < 1e-6);
});

test('closed generated shells and malformed topology report different results', () => {
  const positions = new Float32Array([0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]);
  assert.deepEqual(inspectGarment({ positions, indices }).openings, []);
  const doubled = Uint32Array.from([...indices, 0, 2, 1, 0, 0, 1]);
  const report = inspectGarment({ positions, indices: doubled });
  assert.equal(report.nonManifoldEdges, 3);
  assert.equal(report.zeroAreaFaces, 1);
  assert.throws(() => inspectGarment({ positions, indices: [0, 1, 4] }), RangeError);
});

test('clearance follows the outermost posed layer even when the ray crosses separated pieces', () => {
  const positions = new Float32Array([0.1, -1, -1, 0.1, 1, -1, 0.1, 0, 1, 0.4, -1, -1, 0.4, 1, -1, 0.4, 0, 1]);
  const tree = MeshBVH.build({ positions, indices: new Uint32Array([0, 1, 2, 3, 4, 5]) });
  const coat = new Float32Array([0.24, 0, 0, 0.22, 0, 0, 0.5, 0, 0]);
  const fit = clearGarmentLayer(coat, tree, {
    origin: [0, 0, 0],
    axis: [0, 1, 0],
    maxPush: 0.2,
    ease: 0.025,
    vertices: [0, 2],
  });
  assert.ok(Math.abs(fit.positions[0] - 0.425) < 1e-6);
  assert.ok(Math.abs(fit.positions[3] - 0.22) < 1e-6);
  assert.equal(fit.positions[6], 0.5);
  assert.equal(fit.corrected, 1);
  assert.equal(fit.limited, 0);
  const limited = clearGarmentLayer(coat, tree, { origin: [0, 0, 0], axis: [0, 1, 0], maxPush: 0.05 });
  assert.equal(limited.limited, 2);
  assert.ok(Math.abs(limited.positions[0] - 0.29) < 1e-6);
});
