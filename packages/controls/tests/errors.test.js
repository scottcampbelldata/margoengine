// Controls errors carry a stable code or class, and every message names its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { OrbitControls, stepLocomotion } from '../dist/index.js';
import { WalkControls } from '../dist/walk.js';

class FakeElement {
  constructor() {
    this.clientWidth = this.width = 800;
    this.clientHeight = this.height = 600;
    this.style = { touchAction: 'auto' };
    this.ownerDocument = null;
  }
  addEventListener() {}
  removeEventListener() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
}

test('connecting disposed controls throws a disposed MargoError that says what to do', () => {
  const control = new OrbitControls(new Camera({ position: [0, 0, 10], target: [0, 0, 0] }), new FakeElement());
  control.dispose();
  assert.throws(
    () => control.connect(new FakeElement()),
    (error) => error.name === 'MargoError' && error.code === 'disposed' && /; create new controls/.test(error.message),
  );
});

test('stepLocomotion rejects bad inputs with a RangeError that names the fix', () => {
  assert.throws(
    () => stepLocomotion(new Float32Array(8), new Float32Array(5), NaN, () => 0),
    (error) => error instanceof RangeError && /; pass finite numbers/.test(error.message),
  );
});

test('WalkControls.setMode rejects an unknown mode and lists the valid ones', async () => {
  const engine = new Runtime(
    new FakeElement(),
    await TransformStore.create(64),
    { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 1.7, 0], target: [0, 1.7, 1] },
    null,
  );
  const walk = new WalkControls(engine);
  assert.throws(
    () => walk.setMode('fly'),
    (error) => error instanceof RangeError && /use 'walk' or 'dollhouse'/.test(error.message),
  );
  walk.dispose();
});
