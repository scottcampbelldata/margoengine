import test from 'node:test';
import assert from 'node:assert/strict';
import { Hotspot } from '@margoengine/labels';

const verts = (pts) => {
  const v = new Float32Array(pts.length * 20);
  pts.forEach((p, i) => v.set(p, i * 20));
  return v;
};
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const rig = () => {
  const snap = {
    vertices: verts([
      [0, 0, 0],
      [2, 0, 0],
      [0, 2, 0],
    ]),
    indices: new Uint32Array([0, 1, 2]),
    matrix: identity.slice(),
  };
  return { snap, source: { posePickingGeometry: () => [snap] } };
};
const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-6, `${a} vs ${b}`));

test('the world position is the barycentric blend of the posed corners and follows the pose', () => {
  const { snap, source } = rig();
  const h = new Hotspot(source, { face: 0, barycentric: [0.5, 0.25, 0.25] });
  near(h.worldPosition(), [0.5, 0.5, 0]);
  snap.vertices = verts([
    [0, 0, 0],
    [2, 0, 0],
    [0, 2, 4],
  ]); // the third corner is bent up
  near(h.worldPosition(), [0.5, 0.5, 1]);
  snap.matrix[12] = 10; // the node moves
  near(h.worldPosition(), [10.5, 0.5, 1]);
});
test('fromHit takes a Raycaster hit and the default is the centre', () => {
  const { source } = rig();
  near(Hotspot.fromHit(source, { faceIndex: 0, barycoord: [0, 1, 0] }).worldPosition(), [2, 0, 0]);
  near(new Hotspot(source, { face: 0 }).worldPosition(), [2 / 3, 2 / 3, 0]);
});
test('project gives CSS pixels and pin moves a label', () => {
  const { source } = rig();
  const h = new Hotspot(source, { face: 0, barycentric: [1, 0, 0] });
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 1];
  const p = h.project(m, 200, 100);
  assert.equal(p.inFront, true);
  assert.equal(p.x, 100);
  assert.equal(p.y, 50);
  let seen;
  h.pin({ setPosition: (v) => (seen = v) });
  near(seen, [0, 0, 0]);
});
test('bad options and unknown faces throw a RangeError that names the fix', () => {
  const { source } = rig();
  for (const o of [
    { face: -1 },
    { face: 0, barycentric: [1, 1, 1] },
    { face: 0, barycentric: [NaN, 0, 0] },
    { face: 5 },
    { face: 0, primitiveIndex: 3 },
  ])
    assert.throws(
      () => new Hotspot(source, o),
      (e) => e instanceof RangeError && /fix the options|that exist/.test(e.message),
    );
});
