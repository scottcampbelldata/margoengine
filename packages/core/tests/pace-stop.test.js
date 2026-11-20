// KB-STRESS-3 (core stress check, seed 182, 2026-11-15): stop() called inside engine.pace while pace returned false
// still scheduled a frame. The frame's pace branch rescheduled without testing `running` (its tail did test it), so a
// later start() scheduled a second frame beside the stray one: two loops, two draws per display refresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../dist/index.js';
import { frames, install } from './fake-gpu.js';

test('stop() inside pace that returns false leaves no frame waiting, and a later start() runs one loop', async () => {
  const gpu = install(),
    raf = frames();
  try {
    const engine = await Engine.create(gpu.canvas, { capacity: 8 });
    let stopNow = false;
    engine.pace = () => {
      if (stopNow) engine.stop();
      return !stopNow;
    };
    engine.start();
    raf.refresh(16);
    assert.equal(gpu.devices[0].submits, 1, 'a paced frame draws');
    stopNow = true;
    raf.refresh(32);
    assert.equal(raf.queue.size, 0, 'stopped inside pace: no frame waits');
    stopNow = false;
    engine.start();
    assert.equal(raf.queue.size, 1, 'start() schedules one frame');
    raf.refresh(48);
    assert.equal(raf.queue.size, 1, 'one loop: one frame waits after a refresh');
    assert.equal(gpu.devices[0].submits, 2, 'one draw per refresh');
    engine.dispose();
  } finally {
    raf.uninstall();
    gpu.uninstall();
  }
});

test('a frame pace skips keeps the loop running, and dispose() inside pace ends it', async () => {
  const gpu = install(),
    raf = frames();
  try {
    const engine = await Engine.create(gpu.canvas, { capacity: 8 });
    let mode = 'skip';
    engine.pace = () => (mode === 'dispose' ? (engine.dispose(), false) : mode === 'draw');
    engine.start();
    raf.refresh(16);
    assert.equal(raf.queue.size, 1, 'a skipped frame schedules the next');
    assert.equal(gpu.devices[0].submits, 0, 'a skipped frame draws nothing');
    mode = 'draw';
    raf.refresh(32);
    assert.equal(gpu.devices[0].submits, 1);
    mode = 'dispose';
    raf.refresh(48);
    assert.equal(raf.queue.size, 0, 'disposed inside pace: no frame waits');
  } finally {
    raf.uninstall();
    gpu.uninstall();
  }
});
