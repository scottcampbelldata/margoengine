import test from 'node:test';
import assert from 'node:assert/strict';
import { CompatDevice, CompatBuffer } from '../dist/device.js';

const installScheduler = (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'scheduler');
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'scheduler', previous);
    else delete globalThis.scheduler;
  });
  Object.defineProperty(globalThis, 'scheduler', {
    configurable: true,
    value: {
      postTask(callback, options) {
        assert.equal(options.delay, 1, 'polls leave an idle interval for WebGL fence status');
        return new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            callback();
            resolve();
          };
          channel.port2.postMessage(null);
        });
      },
    },
  });
};

test('serial fence waits yield tasks without nested timers; pending work and loss remain ordered', async (t) => {
  installScheduler(t);
  t.mock.method(globalThis, 'setTimeout', () => {
    throw new Error('GPU readiness must not depend on a clamped timer');
  });
  let checks = 0,
    deleted = 0,
    flushed = 0;
  const device = {
    destroyed: false,
    queue: {},
    gl: {
      SYNC_GPU_COMMANDS_COMPLETE: 1,
      TIMEOUT_EXPIRED: 2,
      fenceSync: () => ({}),
      createBuffer: () => ({}),
      bindBuffer() {},
      bufferData() {},
      copyBufferSubData() {},
      flush: () => flushed++,
      isContextLost: () => false,
      clientWaitSync: () => (++checks % 3 ? 2 : 3),
      deleteSync: () => deleted++,
    },
  };
  device.idle = CompatDevice.prototype.idle.bind(device);
  for (let i = 0; i < 32; i++) await device.idle();
  assert.equal(checks, 96);
  assert.equal(deleted, 32);
  assert.equal(flushed, 32);
  let landed = false;
  device.queue.waiting = Promise.resolve().then(() => {
    landed = true;
    device.queue.waiting = undefined;
  });
  await device.idle();
  assert.ok(landed);
  device.destroyed = true;
  await device.idle();
  assert.equal(deleted, 33);
});

// Regression (2026-11-11, Chrome 157 on ANGLE Direct3D 11, RTX A6000): a fence followed only by gl.flush() on a
// context that shows no frame stayed unsignaled for about 270 ms (17 polls), so every onSubmittedWorkDone() after work
// drawn into textures cost that much, and the materials owner/lifetime check ran past its 180 s limit on the layer.
// A command after the fence makes it observable on the next poll: the device sends a 4-byte buffer copy after it.
test('a device fence is followed by a command of its own before the flush, with probe buffers made once', async (t) => {
  installScheduler(t);
  const calls = [];
  let made = 0;
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 1,
    TIMEOUT_EXPIRED: 2,
    COPY_READ_BUFFER: 3,
    COPY_WRITE_BUFFER: 4,
    STATIC_DRAW: 5,
    fenceSync: () => (calls.push('fence'), {}),
    createBuffer: () => ({ id: ++made }),
    bindBuffer: () => {},
    bufferData: () => {},
    copyBufferSubData: (read, write, from, to, size) => calls.push(`copy ${read} ${write} ${from} ${to} ${size}`),
    flush: () => calls.push('flush'),
    isContextLost: () => false,
    clientWaitSync: () => 3,
    deleteSync: () => {},
  };
  const device = { destroyed: false, queue: {}, gl };
  device.idle = CompatDevice.prototype.idle.bind(device);
  for (let i = 0; i < 3; i++) await device.idle();
  assert.deepEqual(calls, Array(3).fill(['fence', 'copy 3 4 0 0 4', 'flush']).flat());
  assert.equal(made, 2, 'the two probe buffers belong to the context, made on its first fence');
  const lost = { ...gl, fenceSync: () => null, copyBufferSubData: () => assert.fail('no probe without a fence') };
  const gone = { destroyed: false, queue: {}, gl: lost };
  await CompatDevice.prototype.idle.call(gone);
});

test('map readiness also yields a port task, checks every pending result and rejects loss', async (t) => {
  installScheduler(t);
  t.mock.method(globalThis, 'setTimeout', () => {
    throw new Error('readback polls must not use a clamped timer');
  });
  let checks = 0;
  const buffer = {
    destroyed: false,
    device: {
      destroyed: false,
      queue: {},
      gl: { flush() {} },
      idle: () => {
        throw new Error('readback must wait its own fence, not add a device fence');
      },
    },
    readbacks: [{}],
    shadowValid: true,
    mapState: 'unmapped',
    // A 4-byte MAP_READ buffer: mapAsync checks the mode and range against them (KB5128a).
    size: 4,
    usage: 1,
    shadow: new Uint8Array(4),
    settle: () => ++checks % 4 === 0,
  };
  for (let i = 0; i < 16; i++) {
    await CompatBuffer.prototype.mapAsync.call(buffer, 1);
    assert.equal(buffer.mapState, 'mapped');
    buffer.mapState = 'unmapped';
  }
  assert.equal(checks, 64);
  buffer.device.destroyed = true;
  await assert.rejects(CompatBuffer.prototype.mapAsync.call(buffer, 1), { name: 'AbortError' });
});

test('nonforcing settlement does not block on a readback and leaves every later write queued', () => {
  let applied = 0;
  const buffer = {
    device: { gl: {}, stalls: 0 },
    shadowValid: true,
    readbacks: [
      { ready: () => false, forcible: true, apply: () => applied++ },
      { ready: () => true, forcible: true, apply: () => applied++ },
    ],
  };
  assert.equal(CompatBuffer.prototype.settle.call(buffer, false), false);
  assert.equal(applied, 0);
  assert.equal(buffer.readbacks.length, 2);
  assert.equal(buffer.device.stalls, 0);
  assert.equal(CompatBuffer.prototype.settle.call(buffer), true);
  assert.equal(applied, 2);
  assert.equal(buffer.device.stalls, 1);
});

test('mapping waits queued writes first and retains the fence for an invalid GPU-only shadow', async () => {
  let submitted = false,
    fenced = false;
  const buffer = {
    destroyed: false,
    mapState: 'unmapped',
    // A 4-byte MAP_READ buffer: mapAsync checks the mode and range against them (KB5128a).
    size: 4,
    usage: 1,
    shadow: new Uint8Array(4),
    shadowValid: false,
    readbacks: [],
    device: {
      destroyed: false,
      queue: {
        waiting: Promise.resolve().then(() => {
          submitted = true;
        }),
      },
      gl: {},
      idle: async () => {
        assert.ok(submitted);
        fenced = true;
      },
    },
    settle(force) {
      assert.equal(force, false);
      assert.ok(fenced);
      return true;
    },
  };
  await CompatBuffer.prototype.mapAsync.call(buffer, 1);
  assert.equal(buffer.mapState, 'mapped');
});

test('the scheduler fallback yields an idle interval and does not leave Node message ports referenced', async () => {
  let polls = 0;
  const device = {
    destroyed: false,
    queue: {},
    gl: {
      SYNC_GPU_COMMANDS_COMPLETE: 1,
      TIMEOUT_EXPIRED: 2,
      fenceSync: () => ({}),
      createBuffer: () => ({}),
      bindBuffer() {},
      bufferData() {},
      copyBufferSubData() {},
      flush() {},
      isContextLost: () => false,
      clientWaitSync: () => (++polls < 3 ? 2 : 3),
      deleteSync() {},
    },
  };
  await CompatDevice.prototype.idle.call(device);
  assert.equal(polls, 3);
});
