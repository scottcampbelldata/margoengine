import test from 'node:test';
import assert from 'node:assert/strict';
import { CompatDevice, CompatBuffer } from '../dist/device.js';

// Chrome on Windows runs scheduler.postTask's delayed tasks on the system timer tick: a poll with delay 1 took 15.1 ms
// where a port message and then setTimeout(1) from that task took 2.0 ms (Chrome 157, 2026-11-18), so every fence wait
// of the layer cost about 13 ms more than it had to (KB-COMPAT-POSTTASK1). The page here has a scheduler whose postTask
// fails the test, and setTimeout is watched: each poll is one port task and a 1 ms timer set from it, which carries no
// timer nesting level (HTML's 4 ms clamp applies only to timers set from timers).
const installScheduler = (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'scheduler');
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'scheduler', previous);
    else delete globalThis.scheduler;
  });
  Object.defineProperty(globalThis, 'scheduler', {
    configurable: true,
    value: {
      postTask() {
        throw new Error('GPU polls must not use scheduler.postTask delays (15 ms on Windows Chrome)');
      },
    },
  });
};

/** Watches setTimeout: every delay a poll asks for, each from a port message task, never from a timer callback. */
const watchTimers = (t) => {
  const native = globalThis.setTimeout,
    delays = [];
  let inTimer = 0;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...rest) => {
    assert.equal(inTimer, 0, 'a GPU poll timer is never set from a timer callback (HTML clamps nested timers to 4 ms)');
    delays.push(delay);
    return native(
      (...a) => {
        inTimer++;
        try {
          return fn(...a);
        } finally {
          inTimer--;
        }
      },
      delay,
      ...rest,
    );
  });
  return delays;
};

test('serial fence waits yield tasks without nested timers; pending work and loss remain ordered', async (t) => {
  installScheduler(t);
  const delays = watchTimers(t);
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
  // One 1 ms timer a poll that found the fence pending, set from a port task: an idle interval for WebGL fence status.
  assert.ok(delays.length > 0 && delays.every((d) => d === 1), `poll delays ${delays}`);
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
  const delays = watchTimers(t);
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
  assert.ok(delays.length > 0 && delays.every((d) => d === 1), `poll delays ${delays}`);
  buffer.device.destroyed = true;
  await assert.rejects(CompatBuffer.prototype.mapAsync.call(buffer, 1), { name: 'AbortError' });
});

// KB-SHOT-COMPATLOST1: a buffer destroyed while its map waited was rejected as "The device was lost", so a page that
// destroyed its own readback buffer was sent looking for a device loss that never happened.
test('a map aborted by its own buffer destroy names the destroy, and a device loss names the loss', async () => {
  const pending = (destroy) => {
    const buffer = {
      destroyed: false,
      device: { destroyed: false, queue: {}, gl: { flush() {} } },
      readbacks: [{}],
      shadowValid: true,
      mapState: 'unmapped',
      size: 4,
      usage: 1,
      shadow: new Uint8Array(4),
      settle: () => {
        destroy(buffer);
        return false;
      },
    };
    return CompatBuffer.prototype.mapAsync.call(buffer, 1);
  };
  await assert.rejects(
    pending((b) => {
      b.destroyed = true;
      b.mapState = 'unmapped';
    }),
    { name: 'AbortError', message: 'The buffer was destroyed before it mapped' },
  );
  await assert.rejects(
    pending((b) => (b.device.destroyed = true)),
    { name: 'AbortError', message: /^The device was lost before the buffer mapped/ },
  );
  // KB-COMPAT-LOSTWHY1: the abort names why the device was lost, so an intermittent loss is diagnosable.
  await assert.rejects(
    pending((b) => {
      b.device.destroyed = true;
      b.device.lostMessage = 'The WebGL2 context was lost';
    }),
    {
      name: 'AbortError',
      message: /^The device was lost before the buffer mapped \(The WebGL2 context was lost\); map it again/,
    },
  );
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
