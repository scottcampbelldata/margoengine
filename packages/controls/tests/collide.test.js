import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { box } from '@margoengine/core';
import { Raycaster } from '@margoengine/bvh';
import { OrbitControls, MapControls } from '../dist/collide.js';
import { FakeElement, close, closeVec, pointer } from './control-fakes.js';
const rig = async (Control = OrbitControls, options = {}) => {
  const el = new FakeElement(),
    engine = new Engine(
      el,
      await TransformStore.create(32),
      { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
      undefined,
      null,
    );
  engine.camera.position = [0, 0, 10];
  engine.camera.target = [0, 0, 0];
  const wall = engine.createMesh().setGeometry(box()).setScale([10, 10, 0.2]).setPosition([0, 0, 3]);
  const control = new Control(engine, { colliders: [wall], ...options });
  return { engine, el, wall, control, cam: engine.camera };
};
for (const Control of [OrbitControls, MapControls])
  test(`${Control.name}: retract immediately, retain desired orbit, restore after clear`, async () => {
    const { control, cam, wall, engine } = await rig(Control);
    control.update();
    close(cam.position[2], 2.89, 1e-7);
    close(control.desiredDistance, 10, 1e-12);
    assert.equal(control.rays, 5);
    for (let i = 0; i < 30; i++) control.update();
    close(cam.position[2], 2.89, 1e-7);
    close(control.desiredDistance, 10, 1e-12);
    wall.setPosition([20, 0, 3]);
    control.update(0.1);
    assert.ok(cam.position[2] > 2.89 && cam.position[2] < 10);
    for (let i = 0; i < 300; i++) control.update(1 / 60);
    close(control.armLength, 10, 1e-9);
    wall.setPosition([0, 0, 2]);
    control.update();
    assert.ok(control.armLength < 1.9);
    engine.dispose();
  });
test('near-plane corners catch blockers the eye-centre ray misses', async () => {
  const { control, cam, wall, engine } = await rig(OrbitControls, { returnTime: 0 });
  cam.near = 1;
  const half = Math.tan((cam.fov * Math.PI) / 360);
  wall.setScale([0.05, 0.05, 0.2]).setPosition([(half * 4) / 3, half, 3]);
  control.update();
  close(control.armLength, 2.89, 1e-7);
  assert.equal(control.rays, 5);
  engine.dispose();
});
test('collision events observe the final camera, not an unclipped intermediate pose', async () => {
  const { control, cam, engine } = await rig();
  const positions = [];
  control.addEventListener('change', () => positions.push([...cam.position]));
  control.update();
  assert.equal(positions.length, 1);
  assert.ok(positions[0][2] < 3);
  control.update();
  assert.equal(positions.length, 1);
  engine.dispose();
});
test('external teleport and a translated camera/target preserve the appropriate requested arm', async () => {
  const { control, cam, wall, engine } = await rig(OrbitControls, { returnTime: 0 });
  control.update();
  cam.position = [cam.position[0] + 100, cam.position[1], cam.position[2]];
  cam.target = [100, 0, 0];
  wall.setPosition([100, 0, 3]);
  control.update();
  close(control.desiredDistance, 10, 1e-12);
  close(control.armLength, 2.89, 1e-7);
  cam.position = [100, 0, 8];
  control.update();
  close(control.desiredDistance, 8, 1e-12);
  wall.dispose();
  control.update();
  close(control.armLength, 8, 1e-12);
  engine.dispose();
});
test('query settings are restored, hidden/nonselected meshes do not block and filters are honored', async () => {
  const ray = new Raycaster([1, 2, 3], [1, 0, 0], 2, 4);
  ray.side = 'double';
  ray.firstHitOnly = false;
  const { control, wall, engine } = await rig(OrbitControls, { raycaster: ray, returnTime: 0 });
  control.update();
  close(control.armLength, 2.89, 1e-7);
  closeVec([...ray.origin], [1, 2, 3], 0);
  closeVec([...ray.direction], [1, 0, 0], 0);
  assert.equal(ray.near, 2);
  assert.equal(ray.far, 4);
  assert.equal(ray.firstHitOnly, false);
  wall.visible = false;
  control.update();
  close(control.armLength, 10, 1e-12);
  wall.visible = true;
  ray.filter = () => false;
  control.update();
  close(control.armLength, 10, 1e-12);
  ray.filter = null;
  control.colliders = [];
  control.update();
  assert.equal(control.rays, 0);
  control.colliders = null;
  control.update();
  assert.ok(control.armLength < 3);
  engine.dispose();
});
test('wheel and orbit remain responsive while clipped, with no stale camera after disposal', async () => {
  const { control, el, cam, engine } = await rig();
  control.update();
  el.dispatch('wheel', { deltaY: -100, deltaMode: 0, clientX: 400, clientY: 300 });
  control.update();
  assert.ok(control.desiredDistance < 10 && control.desiredDistance > 3);
  pointer(el, 'pointerdown', 400, 300);
  pointer(el, 'pointermove', 440, 300);
  control.update();
  pointer(el, 'pointerup', 440, 300);
  assert.notEqual(cam.position[0], 0);
  assert.throws(() => control.update(NaN), RangeError);
  engine.dispose();
  assert.equal(el.listenerCount, 0);
  assert.equal(control.update(), false);
});
test('a failed custom query restores both its ray settings and the last safe pose, and propagates the error', async () => {
  const { control, cam, engine } = await rig();
  control.update();
  const before = [...cam.position],
    ray = control.raycaster,
    query = ray.intersectObjects,
    error = new Error('custom scene query failed');
  ray.set([1, 2, 3], [0, 1, 0]);
  ray.near = 2;
  ray.far = 8;
  ray.intersectObjects = () => {
    throw error;
  };
  assert.throws(
    () => control.update(),
    (e) => e === error,
  );
  closeVec(cam.position, before, 0);
  closeVec([...ray.origin], [1, 2, 3], 0);
  closeVec([...ray.direction], [0, 1, 0], 0);
  assert.equal(ray.near, 2);
  assert.equal(ray.far, 8);
  ray.intersectObjects = query;
  engine.dispose();
});
