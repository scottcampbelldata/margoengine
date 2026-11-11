// Work on a destroyed buffer or texture (KB-C34c). WebGPU refuses it with a validation error and runs none of it: a
// queue write to a destroyed resource does nothing, and a submit whose command buffers use one runs none of them. The
// layer used to make the WebGL2 calls anyway, on the deleted objects; GL answered with INVALID_OPERATION, which stayed
// queued until the next allocation's getError and was reported there as an `internal` error of that unrelated buffer
// or texture. Under the restore fault sweep (one failed allocation is a destroyed object) core then faulted every frame.
// The stand-in context below answers as GL does: any call naming a deleted object raises INVALID_OPERATION.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPAT_LIMITS } from '../dist/index.js';
import { createCompatGPU } from '../dist/device.js';

const INVALID_OPERATION = 0x0502;
const BUFFER_USAGE = { COPY_SRC: 0x4, COPY_DST: 0x8, VERTEX: 0x20 };

/** A WebGL2 stand-in that records each call and raises INVALID_OPERATION for one that names a deleted object. */
function recordingContext() {
  const enums = Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, 0x1000 + i]));
  const values = new Map(COMPAT_LIMITS.map((_, i) => [0x1000 + i, 4096]));
  const errors = [],
    deleted = new WeakSet(),
    calls = [];
  const context = {
    ...enums,
    RENDERER: 0x1f01,
    HIGH_FLOAT: 0x8df2,
    calls,
    getExtension: (name) =>
      name === 'EXT_color_buffer_float' ? {} : name === 'WEBGL_lose_context' ? { loseContext() {} } : null,
    getParameter: (p) => (p === 0x1f01 ? 'Stand-in renderer' : (values.get(p) ?? '')),
    getShaderPrecisionFormat: (_shader, type) =>
      type === 0x8df2 ? { precision: 23, rangeMin: 127, rangeMax: 127 } : { precision: 0, rangeMin: 31, rangeMax: 30 },
    getError: () => errors.shift() ?? 0,
    isContextLost: () => false,
  };
  return new Proxy(context, {
    get(c, key) {
      if (key in c) return c[key];
      if (typeof key !== 'string') return undefined;
      // Any other enum gets a value of its own.
      if (/^[A-Z0-9_]+$/.test(key)) return (c[key] = 0x9000 + Object.keys(c).length);
      return (...args) => {
        calls.push(key);
        if (key.startsWith('delete')) {
          if (args[0]) deleted.add(args[0]);
          return undefined;
        }
        if (args.some((a) => a && typeof a === 'object' && deleted.has(a))) errors.push(INVALID_OPERATION);
        return {};
      };
    },
  });
}

/** One task: the layer dispatches uncapturederror in a task of its own, as WebGPU does. */
const task = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup() {
  const gl = recordingContext();
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  const device = await adapter.requestDevice();
  const uncaptured = [];
  device.addEventListener('uncapturederror', (event) => (event.preventDefault(), uncaptured.push(event.error)));
  return { gl, device, uncaptured };
}

/** A clean allocation inside internal and out-of-memory scopes: what the layer's getError check reports for it. */
async function allocationErrors(device) {
  device.pushErrorScope('internal');
  device.pushErrorScope('out-of-memory');
  device.createBuffer({ label: 'next', size: 256, usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.VERTEX });
  return [await device.popErrorScope(), await device.popErrorScope()].filter(Boolean);
}

test('a queue write to a destroyed buffer or texture is a validation error and makes no GL call', async () => {
  const { gl, device, uncaptured } = await setup();
  try {
    const buffer = device.createBuffer({ label: 'gone', size: 64, usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.VERTEX });
    const texture = device.createTexture({ label: 'gone map', size: [4, 4], format: 'rgba8unorm', usage: 0x2 | 0x4 });
    buffer.destroy();
    texture.destroy();
    const before = gl.calls.length;

    device.pushErrorScope('validation');
    device.queue.writeBuffer(buffer, 0, new Float32Array(16));
    const write = await device.popErrorScope();
    assert.equal(write?.name, 'GPUValidationError');
    assert.match(write.message, /writeBuffer uses 'gone', which is destroyed/);

    device.pushErrorScope('validation');
    device.queue.writeTexture({ texture }, new Uint8Array(64), { bytesPerRow: 16 }, [4, 4]);
    const upload = await device.popErrorScope();
    assert.equal(upload?.name, 'GPUValidationError');
    assert.match(upload.message, /writeTexture uses 'gone map', which is destroyed/);

    assert.deepEqual(gl.calls.slice(before), [], 'no GL call names the deleted objects');
    // The next, unrelated allocation is not blamed for them.
    assert.deepEqual(await allocationErrors(device), []);
    await task();
    assert.deepEqual(uncaptured, []);
  } finally {
    device.destroy();
  }
});

test('a submit that uses a destroyed buffer runs none of its command buffers', async () => {
  const { gl, device, uncaptured } = await setup();
  try {
    const usage = BUFFER_USAGE.COPY_SRC | BUFFER_USAGE.COPY_DST | BUFFER_USAGE.VERTEX;
    const live = device.createBuffer({ label: 'live', size: 64, usage }),
      gone = device.createBuffer({ label: 'gone', size: 64, usage });
    gone.destroy();
    const first = device.createCommandEncoder();
    first.clearBuffer(live);
    const second = device.createCommandEncoder({ label: 'copy' });
    second.copyBufferToBuffer(live, 0, gone, 0, 64);
    const buffers = [first.finish(), second.finish({ label: 'copy' })];
    const before = gl.calls.length;

    device.pushErrorScope('validation');
    device.queue.submit(buffers);
    const error = await device.popErrorScope();
    assert.equal(error?.name, 'GPUValidationError');
    assert.match(error.message, /submit: command buffer 'copy' uses 'gone', which is destroyed/);
    assert.deepEqual(gl.calls.slice(before), [], 'neither command buffer ran');
    assert.deepEqual(await allocationErrors(device), []);

    // Both command buffers are spent, as WebGPU invalidates every one of a failed submit.
    device.pushErrorScope('validation');
    device.queue.submit([buffers[0]]);
    assert.match((await device.popErrorScope())?.message ?? '', /submitted once/);

    // The same work on live buffers runs.
    const again = device.createCommandEncoder();
    again.clearBuffer(live);
    device.pushErrorScope('validation');
    device.queue.submit([again.finish()]);
    assert.equal(await device.popErrorScope(), null);
    assert.ok(gl.calls.slice(before).includes('bufferSubData'));
    await task();
    assert.deepEqual(uncaptured, []);
  } finally {
    device.destroy();
  }
});

test('a bind group or render bundle over a destroyed resource fails the submit that uses it', async () => {
  const { gl, device, uncaptured } = await setup();
  try {
    const usage = BUFFER_USAGE.COPY_DST | BUFFER_USAGE.VERTEX | 0x40;
    const uniform = device.createBuffer({ label: 'params', size: 64, usage });
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 0x1, buffer: {} }] });
    const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
    const target = device.createTexture({ label: 'target', size: [4, 4], format: 'rgba8unorm', usage: 0x10 });
    const vertices = device.createBuffer({ label: 'vertices', size: 64, usage });
    const bundleEncoder = device.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] });
    bundleEncoder.setVertexBuffer(0, vertices);
    const bundle = bundleEncoder.finish();

    const record = (useBundle) => {
      const encoder = device.createCommandEncoder({ label: useBundle ? 'bundle' : 'group' });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
      });
      if (useBundle) pass.executeBundles([bundle]);
      else pass.setBindGroup(0, group);
      pass.end();
      return encoder.finish({ label: useBundle ? 'bundle' : 'group' });
    };
    const groupWork = record(false),
      bundleWork = record(true);
    uniform.destroy();
    vertices.destroy();
    const before = gl.calls.length;
    for (const [work, label, name] of [
      [groupWork, 'group', 'params'],
      [bundleWork, 'bundle', 'vertices'],
    ]) {
      device.pushErrorScope('validation');
      device.queue.submit([work]);
      const error = await device.popErrorScope();
      assert.match(error?.message ?? '', new RegExp(`command buffer '${label}' uses '${name}', which is destroyed`));
    }
    assert.deepEqual(gl.calls.slice(before), [], 'no pass ran');
    assert.deepEqual(await allocationErrors(device), []);
    await task();
    assert.deepEqual(uncaptured, []);
  } finally {
    device.destroy();
  }
});

test('a resource destroyed while the queue waits for a lazy chunk is refused at once, inside the caller scope', async () => {
  const { gl, device, uncaptured } = await setup();
  try {
    const buffer = device.createBuffer({
      label: 'later',
      size: 64,
      usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.VERTEX,
    });
    let release;
    // What a submit that needs the compute runtime does: the queue holds everything after it until the chunk loads.
    device.queue.hold(new Promise((resolve) => (release = resolve)));
    device.queue.writeBuffer(buffer, 0, new Float32Array(16));
    buffer.destroy();
    assert.equal(buffer.destroyed, false, 'its GL objects wait for the queued write');
    device.pushErrorScope('validation');
    device.queue.writeBuffer(buffer, 0, new Float32Array(16));
    const error = await device.popErrorScope();
    assert.match(error?.message ?? '', /writeBuffer uses 'later', which is destroyed/);
    release();
    await device.queue.waiting;
    assert.equal(buffer.destroyed, true);
    assert.equal(
      gl.calls.filter((name) => name === 'bufferSubData').length,
      1,
      'the write queued before destroy() ran',
    );
    assert.deepEqual(await allocationErrors(device), []);
    await task();
    assert.deepEqual(uncaptured, []);
  } finally {
    device.destroy();
  }
});

// Found by the restore fault sweep on the layer: core destroys a device whose allocation failed and restores onto a new
// one in later tasks, while the page waited on onSubmittedWorkDone in a loop. On a destroyed device the layer resolved
// it at once, so the loop ran on microtasks alone and starved every timer and task, the restore and pipeline polls
// included, for its whole 20 s limit. WebGPU resolves it in a task, also on a destroyed device.
test('onSubmittedWorkDone resolves in a later task, also on a destroyed device', async () => {
  const { device } = await setup();
  device.destroy();
  let fired = false;
  setTimeout(() => (fired = true), 0);
  for (let i = 0; i < 20 && !fired; i++) await device.queue.onSubmittedWorkDone();
  assert.equal(fired, true, 'a timer runs while the page waits for the queue');
});
