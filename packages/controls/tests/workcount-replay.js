import { createHash } from 'node:crypto';
import { box } from '@margoengine/core';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { ArcballControls } from '../dist/arcball.js';
import { DragControls } from '../dist/drag.js';
import { FakeElement, camera, pointer } from './control-fakes.js';

// Hash raw Float64/Float32 bytes after every step, rather than rounded final positions.
export async function controlReplay() {
  const hash = createHash('sha256');
  const record = (values) => hash.update(Buffer.from(values.buffer, values.byteOffset, values.byteLength));
  for (const damping of [false, true]) {
    for (const position of [[0, 0, 10], [3, 5, -9], [0, 10, 0]]) {
      const cam = camera({ position }), el = new FakeElement(), control = new ArcballControls(cam, el);
      control.enableDamping = damping;
      let changes = 0;
      control.addEventListener('change', () => changes++);
      pointer(el, 'pointerdown', 250, 250);
      for (let i = 0; i < 200; i++) {
        pointer(el, 'pointermove', 400 + 150 * Math.sin(i * 0.17), 300 + 100 * Math.cos(i * 0.13));
        const moved = control.update(1 / 60);
        record(new Float64Array([...cam.position, ...cam.target, ...cam.up, +moved, changes]));
      }
      pointer(el, 'pointerup', 400, 300);
      for (let i = 0; i < 400; i++) {
        if (i === 50) control.pan(15, -9);
        if (i === 100) control.dollyIn(0.8);
        if (i === 200) control.maxDistance = 5;
        if (i === 300) control.minDistance = 6;
        const moved = control.update(1 / 60);
        record(new Float64Array([...cam.position, ...cam.target, ...cam.up, +moved, changes]));
      }
      control.dispose();
    }
  }
  for (const mode of ['translate', 'rotate']) {
    const canvas = Object.assign(new FakeElement(), { width: 800, height: 600 });
    const engine = new Engine(canvas, await TransformStore.create(32),
      { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 10], target: [0, 0, 0] }, null);
    const objects = Array.from({ length: 4 }, (_, i) =>
      engine.createMesh().setGeometry(box()).setPosition([i * 2, 0, 0]));
    const control = new DragControls(engine, objects, { group: objects, mode });
    engine.store.tick(false);
    if (!control.pointerDown(400, 300)) throw new Error('replay missed its box');
    for (let i = 0; i < 200; i++) {
      if (i === 50) objects[1].dispose();
      if (i === 100) objects[3].dispose();
      control.pointerMove(400 + i * 2, 300 + i);
      engine.store.tick(false);
      record(engine.store.matrices);
    }
    control.dispose();
    engine.dispose();
  }
  return hash.digest('hex');
}
