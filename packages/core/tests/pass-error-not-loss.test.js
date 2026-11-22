// B2 (core audit, 2026-11-11): a pass or plugin that threw a DOMException named InvalidStateError or OperationError was
// taken as a lost device. The renderer marked its healthy device lost, so no later frame drew, and the engine asked for
// a new device, while the error itself was never reported. Such errors are ordinary failures (a buffer mapped twice, a
// canvas not configured); a real loss arrives through device.lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../dist/index.js';
import { install, settle } from './fake-gpu.js';

for (const name of ['InvalidStateError', 'OperationError'])
  test(`a pass that throws ${name} on a healthy device is reported once; the device stays and draws again`, async () => {
    const gpu = install();
    try {
      const engine = await Engine.create(gpu.canvas, { capacity: 8 }),
        error = new DOMException('thrown by a pass', name);
      let calls = 0;
      engine.frameGraph.add({
        name: 'thrower',
        order: 1,
        execute() {
          if (++calls === 1) throw error;
        },
      });
      assert.throws(
        () => engine.render(),
        (thrown) => thrown === error,
        'the error reaches the caller',
      );
      await settle();
      const submits = gpu.devices[0].submits;
      engine.render();
      assert.equal(calls, 2, 'the next frame runs the pass again');
      assert.ok(gpu.devices[0].submits > submits, 'the next frame draws on the same device');
      assert.equal(gpu.adapters, 1, 'no new device is asked for');
      assert.equal(gpu.devices[0].destroyed, false);
      engine.dispose();
    } finally {
      gpu.uninstall();
    }
  });
