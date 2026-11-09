import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { ComputeFrame } from '../dist/frame.js';

for (const remove of [false, true])
  test(`ComputeFrame ${remove ? 'owner removal' : 'direct disposal'} removes only its actual scene registration`, async (t) => {
    const e = await engine(t),
      scene = e.createScene('compute-owner');
    let restored = 0,
      primaryDisposals = 0;
    const frame = new ComputeFrame({
      onRestored() {
        restored++;
      },
    });
    scene.use(frame);
    const before = frame.gpu,
      oldArray = before.zeros(4);
    const primary = {
      name: frame.name,
      setup() {},
      dispose() {
        primaryDisposals++;
      },
    };
    e.use(primary);
    frame.onDeviceRestored(e);
    assert.equal(restored, 1);
    assert.equal(before.disposed, true);
    assert.equal(oldArray.disposed, true);
    assert.equal(e.sceneOf(frame) === scene, true);
    const context = frame.gpu,
      array = context.zeros(4),
      device = context.device;
    if (remove) scene.removePlugin(frame.name);
    else frame.dispose();
    frame.dispose();
    assert.equal(e.sceneOf(frame) === undefined, true, 'disposed frame remains registered');
    assert.equal(scene.plugins.size, 0);
    assert.equal(context.disposed, true);
    assert.equal(array.disposed, true);
    assert.equal(device === e.gpu, true);
    assert.equal(primaryDisposals, 0);
    assert.equal(e.scene.plugins.get(primary.name) === primary, true);
    const replacement = { name: frame.name, setup() {}, dispose() {} };
    scene.use(replacement);
    frame.dispose();
    assert.equal(scene.plugins.get(frame.name) === replacement, true);
    scene.removePlugin(frame.name);
  });
