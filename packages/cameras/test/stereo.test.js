import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core/extension';
import { StereoRig, StereoOutput } from '../dist/stereo.js';
import { CameraProjection } from '../dist/index.js';
const project = (camera, p, aspect = 1, webgpu = true) => {
  camera.update(aspect, webgpu);
  const m = camera.matrix,
    w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [0, 1, 2].map((r) => (m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]) / w);
};

test('parallel off-axis eyes have zero disparity at focus, opposite near/far disparities and no vertical disparity', () => {
  for (const webgpu of [true, false])
    for (const aspect of [0.5, 1, 2]) {
      const source = new Camera({ position: [0, 0, 0], target: [0, 0, -5] }),
        rig = new StereoRig({ eyeSeparation: 0.2 });
      rig.update(source, aspect);
      for (const z of [-2, -5, -10]) {
        const l = project(rig.left, [0, 0.3, z], aspect, webgpu),
          r = project(rig.right, [0, 0.3, z], aspect, webgpu);
        assert.ok(Math.abs(l[1] - r[1]) < 1e-7);
        if (z === -5) assert.ok(Math.abs(l[0] - r[0]) < 1e-7);
        else assert.equal(Math.sign(l[0] - r[0]), z === -2 ? 1 : -1);
      }
      assert.deepEqual(source.position, [0, 0, 0]);
      assert.deepEqual(source.target, [0, 0, -5]);
      assert.equal(source.project, undefined);
    }
});
test('rolled and vertical cameras offset along their own right axis; lazy aspect and infinite focus work', () => {
  const camera = new Camera({ position: [0, 5, 0], target: [0, 0, 0] });
  camera.up = [0, 0, -1];
  const rig = new StereoRig({ eyeSeparation: 0.2, focusDistance: Infinity });
  let aspect = 1;
  rig.update(camera, () => aspect);
  assert.ok(Math.abs(rig.left.position[0] + 0.1) < 1e-12);
  assert.ok(Math.abs(rig.right.position[0] - 0.1) < 1e-12);
  let p = project(rig.left, [0, 0, 0]);
  aspect = 2;
  const q = project(rig.left, [0, 0, 0]);
  assert.ok(Math.abs(q[0] - p[0] / 2) < 1e-7);
});
test('existing off-centre/orthographic projection is retained and zero eye separation is mono', () => {
  const camera = new Camera({ position: [0, 0, 5], target: [0, 0, 0] }),
    projection = new CameraProjection({ height: 4 });
  projection.attach(camera);
  const rig = new StereoRig({ eyeSeparation: 0.2 });
  rig.update(camera, 1);
  assert.deepEqual(project(rig.left, [1, 1, 0]), project(rig.right, [1, 1, 0]));
  projection.dispose();
  rig.options.eyeSeparation = 0;
  rig.update(camera, 1);
  assert.deepEqual(project(rig.left, [1, 1, 0]), project(camera, [1, 1, 0]));
});
test('invalid geometry, packing, disposed output and unsupported engines fail clearly', () => {
  const configured = new StereoOutput({}, { eyeSeparation: 0.6, focusDistance: 5 });
  assert.equal(configured.rig.options.eyeSeparation, 0.6);
  assert.equal(configured.rig.options.focusDistance, 5);
  configured.dispose();
  for (const options of [
    { eyeSeparation: -1 },
    { eyeSeparation: Infinity },
    { focusDistance: 0 },
    { focusDistance: NaN },
  ])
    assert.throws(() => new StereoRig(options).update(new Camera()), RangeError);
  const output = new StereoOutput({}, { mode: 'invalid' });
  assert.throws(() => output.render(), TypeError);
  output.dispose();
  output.dispose();
  assert.throws(
    () => output.render(),
    (e) => e.code === 'disposed',
  );
  assert.throws(() => new StereoOutput({}).render(-1), RangeError);
});
