import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { ArcballControls } from '../dist/arcball.js';
import { DragControls } from '../dist/drag.js';
import { FakeElement, camera } from './control-fakes.js';
import { controlReplay } from './workcount-replay.js';

test('controls preserve every replayed camera and transform byte from the pre-workcount implementation', async () => {
  assert.equal(await controlReplay(), 'bab1b21b918c4d8f593bd9b63e2934e782211e421b3b37a00023756bf56904fd');
});

test('arcball does not rebuild the screen basis on 10000 idle follow-up updates', () => {
  const control = new ArcballControls(camera(), new FakeElement());
  let bases = 0;
  const screenUp = control.screenUp.bind(control);
  control.screenUp = () => { bases++; return screenUp(); };
  for (let i = 0; i < 10000; i++) assert.equal(control.update(), false);
  assert.equal(bases, 0);
  // A live limit change must still clamp without pending input.
  control.maxDistance = 5;
  assert.equal(control.update(), true);
  assert.deepEqual([...control.camera.position], [0, 0, 5]);
  control.dispose();
});

test('drag reuses its carried list for 200 moves, including removal of a disposed group member', async () => {
  const canvas = Object.assign(new FakeElement(), { width: 800, height: 600 });
  const engine = new Engine(canvas, await TransformStore.create(32),
    { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 10], target: [0, 0, 0] }, null);
  const objects = [0, 2, 4].map((x) => engine.createMesh().setGeometry(box()).setPosition([x, 0, 0]));
  const control = new DragControls(engine, objects, { group: objects });
  engine.store.tick(false);
  assert.equal(control.pointerDown(400, 300), true);
  const carried = control.drag.carried;
  let replacements = 0;
  for (let i = 0; i < 200; i++) {
    if (i === 100) objects[1].dispose();
    control.pointerMove(400 + 2 * i, 300 + i);
    if (control.drag.carried !== carried) replacements++;
  }
  assert.equal(replacements, 0);
  assert.deepEqual(carried.map((c) => c.object), [objects[0], objects[2]]);
  control.dispose();
  engine.dispose();
});
