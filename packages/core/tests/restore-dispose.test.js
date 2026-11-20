// KB-STRESS-1 (core stress check, seed 3668340200, 2026-11-15): dispose() did not stop an automatic device restore in
// flight. rebootDevice passed no signal to GPURenderer.create and dispose() had nothing to abort, so after dispose the
// restore still asked for a device, compiled both pipelines and built a renderer (buffers, bind groups, listeners) for
// an engine that was gone, and only then destroyed it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../dist/index.js';
import { install, settle } from './fake-gpu.js';

test('dispose() during an automatic restore stops it before it compiles anything, and reports nothing', async () => {
  const gpu = install();
  try {
    const engine = await Engine.create(gpu.canvas, { capacity: 8 }),
      errors = [];
    engine.onError = (error) => errors.push(error);
    gpu.devices[0].lose('the loss that starts a restore');
    // Two turns: the loss handler has run and the restore is waiting on its adapter.
    await Promise.resolve();
    await Promise.resolve();
    engine.dispose();
    await settle();
    assert.equal(gpu.pipelines, 2, 'only the two pipelines of Engine.create: none for the restore');
    for (const record of gpu.devices) assert.equal(record.destroyed, true, `device ${record.id} destroyed`);
    assert.deepEqual(errors, [], 'a restore that dispose() ended is not reported');
  } finally {
    gpu.uninstall();
  }
});

test('rebootDevice() rejects with the disposed error when dispose() ends it', async () => {
  const gpu = install();
  try {
    const engine = await Engine.create(gpu.canvas, { capacity: 8 }),
      restore = engine.rebootDevice();
    engine.dispose();
    await assert.rejects(restore, { code: 'disposed' });
    await settle();
    assert.equal(gpu.pipelines, 2, 'no pipeline compiled for the restore after dispose');
    for (const record of gpu.devices) assert.equal(record.destroyed, true, `device ${record.id} destroyed`);
  } finally {
    gpu.uninstall();
  }
});

test('a restore that finishes before dispose() still restores', async () => {
  const gpu = install();
  try {
    const engine = await Engine.create(gpu.canvas, { capacity: 8 });
    await engine.rebootDevice();
    assert.equal(gpu.pipelines, 4, 'the restore compiled its two pipelines');
    engine.render();
    assert.equal(gpu.devices.at(-1).submits, 1, 'the restored device draws');
    engine.dispose();
  } finally {
    gpu.uninstall();
  }
});
