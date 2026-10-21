// computeReadback against a scripted GPU double: settlement (result, abort, loss, disposal, GPU errors, timeout) and
// release of everything the job made. scripts' readback-check runs the same paths on a real adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { storage, uint } from '../dist/index.js';
import { computeReadback } from '../dist/readback.js';

globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, VERTEX: 32, UNIFORM: 64, MAP_READ: 1 };
globalThis.GPUMapMode ??= { READ: 1 };

// A device whose buffers hold bytes; `dispatch(buffers)` plays the compute shader, `map` controls mapAsync.
function fakeDevice({
  dispatch = () => {},
  map = () => Promise.resolve(),
  scope = () => null,
  maxBufferSize = 1 << 28,
} = {}) {
  let lose;
  const log = { buffers: [], dispatches: 0, submits: 0, pushed: 0, popped: 0 };
  const device = {
    limits: { maxBufferSize },
    lost: new Promise((resolve) => (lose = resolve)),
    pushErrorScope: () => log.pushed++,
    popErrorScope: () => (log.popped++, Promise.resolve(scope(log.popped))),
    createShaderModule: ({ code }) => ({ code }),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: ({ entries }) => ({ entries }),
    createBuffer({ label, size }) {
      const buffer = {
        label,
        bytes: new Uint8Array(size),
        destroyed: false,
        mapAsync: () => map(buffer),
        getMappedRange: () => buffer.bytes.buffer,
        unmap() {},
        destroy() {
          buffer.destroyed = true;
        },
      };
      log.buffers.push(buffer);
      return buffer;
    },
    createCommandEncoder() {
      const commands = [];
      return {
        beginComputePass: () => ({
          setPipeline() {},
          setBindGroup(_, group) {
            commands.push(() => dispatch(group.entries.map((entry) => entry.resource.buffer ?? entry.resource)));
          },
          dispatchWorkgroups: () => log.dispatches++,
          end() {},
        }),
        copyBufferToBuffer: (from, at, to, offset, size) =>
          commands.push(() => to.bytes.set(from.bytes.subarray(at, at + size), offset)),
        finish: () => commands,
      };
    },
    queue: {
      writeBuffer: (buffer, offset, data) =>
        buffer.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset),
      submit(list) {
        log.submits++;
        for (const commands of list) for (const command of commands) command();
      },
    },
  };
  return { device, log, lose: (reason = 'unknown', message = 'test loss') => lose({ reason, message }) };
}
// The fake "shader": element i of every bound storage buffer becomes i * 3.
const triple = (buffers) => {
  for (const buffer of buffers) {
    const words = new Uint32Array(buffer.bytes.buffer);
    for (let i = 0; i < words.length; i++) words[i] = i * 3;
  }
};
const body = (output) => (i) => output.store(i, i.mul(uint(3)));
const failedWith =
  (pattern, code = 'failed') =>
  (error) =>
    error.name === 'MargoError' && error.code === code && pattern.test(error.message);

test('one dispatch resolves with an owned copy and releases every buffer it made', async () => {
  const { device, log } = fakeDevice({ dispatch: triple }),
    output = storage(8, 'u32'),
    result = await computeReadback(device, 8, body(output), output, { name: 'job' });
  assert.ok(result.data instanceof Uint32Array);
  assert.deepEqual([...result.data], [0, 3, 6, 9, 12, 15, 18, 21]);
  assert.equal(result.type, 'u32');
  assert.equal(result.count, 8);
  assert.notEqual(result.data, output.data, 'result is not the input array');
  assert.deepEqual([...output.data], [0, 0, 0, 0, 0, 0, 0, 0], 'output.data untouched');
  const readback = log.buffers.find((buffer) => buffer.label === 'job:readback');
  assert.notEqual(result.data.buffer, readback.bytes.buffer, 'result is not the mapped range');
  assert.equal(readback.destroyed, true);
  assert.equal(log.dispatches, 1);
  assert.equal(log.submits, 1);
  assert.equal(log.pushed, 2);
  assert.equal(log.popped, 2);
  // The caller's storage stays the caller's.
  assert.equal(log.buffers.find((buffer) => buffer.label === 'shader:storage').destroyed, false);
  output.dispose();
});

test('uniform buffers the body made are destroyed with the job, and f32 and vec4i read back typed', async () => {
  const { device, log } = fakeDevice(),
    values = storage(new Float32Array([1.5, -2]), 'f32'),
    vectors = storage(new Int32Array([1, -2, 3, -4]), 'vec4i');
  const { uniform } = await import('../dist/index.js'),
    scale = uniform(2);
  const floats = await computeReadback(device, 2, (i) => values.store(i, values.element(i).mul(scale)), values);
  assert.ok(floats.data instanceof Float32Array);
  assert.deepEqual([...floats.data], [1.5, -2], 'the fake runs no shader: uploaded data comes back');
  assert.ok(log.buffers.filter((buffer) => buffer.label === 'shader:uniforms').every((buffer) => buffer.destroyed));
  const ints = await computeReadback(device, 1, (i) => vectors.store(i, vectors.element(i)), vectors);
  assert.ok(ints.data instanceof Int32Array);
  assert.equal(ints.count, 1);
});

test('an already aborted signal rejects with its reason before anything touches the GPU', async () => {
  const controller = new AbortController(),
    reason = new DOMException('user cancelled', 'AbortError');
  controller.abort(reason);
  const untouchable = new Proxy({}, { get: () => assert.fail('device touched') }),
    output = storage(4, 'u32');
  await assert.rejects(
    computeReadback(untouchable, 4, body(output), output, { signal: controller.signal }),
    (e) => e === reason,
  );
});

test('an abort while mapping rejects with the reason, destroys the readback and ignores the late map', async () => {
  let finishMap;
  const { device, log } = fakeDevice({ map: () => new Promise((resolve) => (finishMap = resolve)) }),
    controller = new AbortController(),
    output = storage(4, 'u32'),
    job = computeReadback(device, 4, body(output), output, { signal: controller.signal, name: 'aborted' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(log.submits, 1);
  controller.abort();
  await assert.rejects(job, { name: 'AbortError' });
  assert.equal(log.buffers.find((buffer) => buffer.label === 'aborted:readback').destroyed, true);
  finishMap();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('device loss during the job rejects with its reason; a lost device fails at once', async () => {
  const { device, log, lose } = fakeDevice({ map: () => new Promise(() => {}) }),
    output = storage(4, 'u32'),
    job = computeReadback(device, 4, body(output), output, { name: 'lost' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  lose('unknown', 'driver reset');
  await assert.rejects(job, failedWith(/lost \(unknown: driver reset\).*"lost"/));
  assert.equal(log.buffers.find((buffer) => buffer.label === 'lost:readback').destroyed, true);
  // Already lost: settles from the resolved lost promise, not from the never-settling map.
  await assert.rejects(computeReadback(device, 4, body(output), output), failedWith(/lost/));
});

test('an engine target: disposed, WebGL2 and disposal during the job', async () => {
  const output = storage(4, 'u32');
  await assert.rejects(
    computeReadback({ disposed: true, gpu: null }, 4, body(output), output),
    failedWith(/disposed/, 'disposed'),
  );
  await assert.rejects(
    computeReadback({ disposed: false, gpu: null }, 4, body(output), output),
    failedWith(/WebGPU/, 'unsupported'),
  );
  const { device, lose } = fakeDevice({ map: () => new Promise(() => {}) }),
    engine = { disposed: false, gpu: device },
    job = computeReadback(engine, 4, body(output), output);
  await new Promise((resolve) => setTimeout(resolve, 0));
  engine.disposed = true;
  lose('destroyed', 'Device was destroyed.');
  await assert.rejects(job, failedWith(/Engine was disposed/, 'disposed'));
});

test('validation and memory errors from the GPU reject with the GPU message and release the job', async () => {
  const { device, log } = fakeDevice({ scope: (n) => (n === 1 ? { message: 'Invalid ShaderModule' } : null) }),
    output = storage(4, 'u32');
  await assert.rejects(
    computeReadback(device, 4, body(output), output, { name: 'bad' }),
    failedWith(/"bad" failed on the GPU: Invalid ShaderModule/),
  );
  assert.equal(log.buffers.find((buffer) => buffer.label === 'bad:readback').destroyed, true);
  const rejected = fakeDevice({ map: () => Promise.reject(new DOMException('map failed', 'OperationError')) });
  await assert.rejects(computeReadback(rejected.device, 4, body(output), output), failedWith(/map failed/));
});

test('a job that does not finish in time rejects and releases its buffers', async () => {
  const { device, log } = fakeDevice({ map: () => new Promise(() => {}) }),
    output = storage(4, 'u32');
  await assert.rejects(
    computeReadback(device, 4, body(output), output, { timeout: 20, name: 'slow' }),
    failedWith(/within 20 ms/),
  );
  assert.equal(log.buffers.find((buffer) => buffer.label === 'slow:readback').destroyed, true);
});

test('invalid arguments are refused before the GPU is touched', async () => {
  const untouchable = new Proxy(
      { createCommandEncoder() {} },
      { get: (t, k) => (k === 'createCommandEncoder' ? t[k] : assert.fail(`device.${String(k)} touched`)) },
    ),
    output = storage(4, 'u32');
  await assert.rejects(computeReadback(untouchable, 4, body(output), new Uint32Array(4)), TypeError);
  await assert.rejects(computeReadback(untouchable, 4, body(output), output, { timeout: 0 }), RangeError);
  const { device } = fakeDevice({ maxBufferSize: 8 });
  await assert.rejects(computeReadback(device, 0, body(output), output), RangeError);
  await assert.rejects(computeReadback(device, 4, body(output), output), /exceeds the device/);
});

test('a settled job keeps none of its data alive through the device', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { setImmediate } from 'node:timers/promises';
    import { storage } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    import { computeReadback } from ${JSON.stringify(new URL('../dist/readback.js', import.meta.url).href)};
    globalThis.GPUBufferUsage = { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, VERTEX: 32, UNIFORM: 64, MAP_READ: 1 };
    globalThis.GPUMapMode = { READ: 1 };
    const buffer = (size) => { const bytes = new Uint8Array(size); return { bytes, mapAsync: async () => {}, getMappedRange: () => bytes.buffer, unmap() {}, destroy() {} }; };
    const device = {
      limits: { maxBufferSize: 1 << 30 }, lost: new Promise(() => {}),
      pushErrorScope() {}, popErrorScope: async () => null,
      createShaderModule: () => ({}), createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }), createBindGroup: () => ({}),
      createBuffer: ({ size }) => buffer(size),
      createCommandEncoder: () => ({ beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }), copyBufferToBuffer() {}, finish: () => ({}) }),
      queue: { writeBuffer() {}, submit() {} },
    };
    let weakData, weakResult;
    async function job() {
      const output = storage(new Uint32Array(1 << 20), 'u32');
      const result = await computeReadback(device, 4, (i) => output.store(i, i), output);
      output.dispose();
      weakData = new WeakRef(output.data);
      weakResult = new WeakRef(result.data);
    }
    await job();
    for (let i = 0; i < 5; i++) { await setImmediate(); globalThis.gc(); }
    assert.equal(weakData.deref(), undefined, 'the device retained the job output storage');
    assert.equal(weakResult.deref(), undefined, 'the device retained the job result');
    assert.ok(device.lost instanceof Promise);
  `;
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? result.stdout);
});
