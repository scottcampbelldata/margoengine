// Synchronous current-pose picking of a skinned mesh: Raycaster.intersectPosed over Skin.picking (CPU skinning).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Raycaster } from '../../bvh/dist/index.js';
import { Skeleton, Skin } from '../dist/index.js';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function rig() {
  const store = {
    matrices: new Float32Array(256),
    parents: new Float32Array(16).fill(-1),
    hidden: new Uint8Array(16),
    tick() {},
  };
  const engine = { store, meshes: new Map(), disposed: false };
  const make = (id) => {
    const mesh = { engine, id, geometry: null, matrix: identity(), material: { data: new Float32Array(8) } };
    engine.meshes.set(id, mesh);
    store.matrices.set(mesh.matrix, id * 16);
    return mesh;
  };
  const root = make(0),
    node = make(1);
  const vertices = new Float32Array(60);
  [
    [-1, -1, 0],
    [1, -1, 0],
    [0, 1, 0],
  ].forEach((p, i) => {
    vertices.set(p, i * 20);
    vertices[i * 20 + 3] = 1;
    vertices.set([0, 0, 1], i * 20 + 4);
  });
  const mesh = {
    root,
    disposed: false,
    primitives: [{ node, vertices, indices: new Uint32Array([0, 1, 2]), material: { settings: new Float32Array(3) } }],
  };
  const skeleton = new Skeleton([{ name: 'root', parent: -1 }]);
  const skin = new Skin(skeleton, new Array(12).fill(0), [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  skin.mesh = mesh;
  return { skeleton, skin };
}

test('intersectPosed hits the mesh where the skeleton has moved it, synchronously', () => {
  const { skeleton, skin } = rig();
  const ray = new Raycaster([0, 0, 10], [0, 0, -1]);
  assert.equal(ray.intersectPosed(skin.picking)[0].distance, 10);
  skeleton.setPose(0, { translation: [0, 0, 5] });
  assert.ok(Math.abs(ray.intersectPosed(skin.picking)[0].distance - 5) < 1e-5);
  skeleton.setPose(0, { translation: [20, 0, 0] });
  assert.equal(ray.intersectPosed(skin.picking).length, 0, 'the bind pose no longer answers');
});

test('posed vertices are skinned once per pose, and again after the pose or influences change', () => {
  const { skeleton, skin } = rig();
  const a = skin.picking.posePickingGeometry();
  assert.equal(skin.picking.posePickingGeometry(), a);
  skeleton.setPose(0, { translation: [0, 0, 1] });
  assert.notEqual(skin.picking.posePickingGeometry(), a);
  const b = skin.picking.posePickingGeometry();
  skin.setInfluences(0, [0, 0, 0, 0], [1, 0, 0, 0]);
  assert.notEqual(skin.picking.posePickingGeometry(), b);
});

test('intersectPosed rejects a source that is not posed, and an unattached skin', () => {
  const ray = new Raycaster([0, 0, 10], [0, 0, -1]);
  assert.throws(() => ray.intersectPosed({}), TypeError);
  const skin = new Skin(new Skeleton([{ name: 'r', parent: -1 }]), [0, 0, 0, 0], [1, 0, 0, 0]);
  assert.throws(() => skin.picking.posePickingGeometry(), { code: 'state' });
});
