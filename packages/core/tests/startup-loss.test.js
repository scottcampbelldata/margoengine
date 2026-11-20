// B3 (core audit, 2026-11-11): a device lost during startup was never restored. The renderer called its loss hook from
// device.lost before the engine had set that hook (during Engine.create, or during a restore before the restored
// renderer was watched), so the loss went nowhere: no restore, no report, and no frame ever drew again. A device lost
// while the restore that brought it in was still ending was dropped too, since that restore was still in flight.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../dist/index.js';
import { install, settle } from './fake-gpu.js';

test('a device that comes back lost from Engine.create is restored and the next frame draws', async () => {
  const gpu = install();
  try {
    gpu.loseAtStart(0);
    const engine = await Engine.create(gpu.canvas, { capacity: 8 }),
      errors = [];
    engine.onError = (error) => errors.push(error);
    await settle();
    assert.equal(gpu.adapters, 2, 'a restore asked for a new device');
    engine.render();
    assert.equal(gpu.devices.at(-1).submits, 1, 'the restored device draws');
    assert.deepEqual(errors, []);
    engine.dispose();
  } finally {
    gpu.uninstall();
  }
});

test('a device that comes back lost from a restore is restored again and the next frame draws', async () => {
  const gpu = install();
  try {
    const engine = await Engine.create(gpu.canvas, { capacity: 8 }),
      errors = [];
    engine.onError = (error) => errors.push(error);
    gpu.loseAtStart(1);
    gpu.devices[0].lose('the loss that starts a restore');
    await settle();
    assert.equal(gpu.adapters, 3, 'the lost restored device is replaced too');
    engine.render();
    assert.equal(gpu.devices.at(-1).submits, 1, 'the device of the second restore draws');
    assert.deepEqual(errors, []);
    engine.dispose();
  } finally {
    gpu.uninstall();
  }
});

test('a device lost while the restore that brought it in is ending is restored again', async () => {
  const gpu = install();
  try {
    const engine = await Engine.create(gpu.canvas, { capacity: 8 }),
      errors = [];
    engine.onError = (error) => errors.push(error);
    // A plugin hears of the first restore inside it, before it ends, and the new device is lost right there.
    let restores = 0;
    engine.use({
      name: 'loser',
      setup() {},
      onDeviceRestored: () => restores++ || gpu.devices.at(-1).lose('lost while restoring'),
    });
    gpu.devices[0].lose('the loss that starts a restore');
    await settle();
    assert.equal(gpu.adapters, 3, 'the device lost inside its restore is replaced');
    assert.equal(restores, 2);
    engine.render();
    assert.equal(gpu.devices.at(-1).submits, 1, 'the device of the second restore draws');
    assert.deepEqual(errors, []);
    engine.dispose();
  } finally {
    gpu.uninstall();
  }
});
