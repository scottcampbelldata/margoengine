import test from 'node:test';
import assert from 'node:assert/strict';
import { injectGPUFaults } from './support/gpu-faults.js';

// A device with the parts of GPUDevice the helper touches: real error scopes (a stack that reports nothing unless an
// error was raised), resources that know whether they were destroyed, and buffers that map.
class MockDevice extends EventTarget {
  scopes = [];
  live = new Set();
  createBuffer(descriptor) {
    const device = this,
      buffer = {
        ...descriptor,
        mapped: false,
        destroyed: false,
        destroy() {
          this.destroyed = true;
          device.live.delete(this);
        },
        async mapAsync() {
          if (this.destroyed) throw new DOMException('Buffer is destroyed', 'OperationError');
          this.mapped = true;
        },
      };
    this.live.add(buffer);
    return buffer;
  }
  createTexture(descriptor) {
    const device = this,
      texture = {
        ...descriptor,
        destroyed: false,
        destroy() {
          this.destroyed = true;
          device.live.delete(this);
        },
      };
    this.live.add(texture);
    return texture;
  }
  pushErrorScope(filter) {
    this.scopes.push(filter);
  }
  async popErrorScope() {
    if (!this.scopes.length) throw new DOMException('No error scope', 'OperationError');
    this.scopes.pop();
    return null;
  }
}

test('the n-th createBuffer fails into the innermost out-of-memory scope; the retry works', async () => {
  const device = new MockDevice();
  using faults = injectGPUFaults(device, { createBuffer: 2 });
  device.pushErrorScope('out-of-memory');
  const first = device.createBuffer({ label: 'first', size: 16 });
  assert.equal(await device.popErrorScope(), null);
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  const failed = device.createBuffer({ label: 'second', size: 16 });
  assert.equal(await device.popErrorScope(), null, 'a validation scope does not catch an out-of-memory error');
  const error = await device.popErrorScope();
  assert.equal(error.name, 'GPUOutOfMemoryError');
  assert.match(error.message, /Injected createBuffer failure \(call 2\)/);
  assert.equal(failed.destroyed, true, 'the failed buffer is unusable');
  await assert.rejects(failed.mapAsync(), /destroyed/);
  const retry = device.createBuffer({ label: 'third', size: 16 });
  assert.equal(retry.destroyed, false);
  assert.deepEqual([...device.live], [first, retry], 'a failed allocation leaves nothing alive');
  assert.deepEqual(faults.calls, { createBuffer: 3, createTexture: 0, mapAsync: 0 }, 'a failed buffer is not counted');
  assert.deepEqual(
    faults.injected.map(({ method, call, label }) => ({ method, call, label })),
    [{ method: 'createBuffer', call: 2, label: 'second' }],
  );
});

test('createTexture fails as a validation error when asked; with no scope the device fires uncapturederror', async () => {
  const device = new MockDevice(),
    seen = [];
  device.addEventListener('uncapturederror', (event) => seen.push(event.error));
  using faults = injectGPUFaults(device, { createTexture: [1, 3], error: 'validation' });
  const a = device.createTexture({ label: 'a' }),
    b = device.createTexture({ label: 'b' });
  device.pushErrorScope('validation');
  device.createTexture({ label: 'c' });
  const caught = await device.popErrorScope();
  assert.equal(caught.name, 'GPUValidationError');
  assert.deepEqual(
    seen.map((error) => error.name),
    ['GPUValidationError'],
    'call 1 had no scope, call 3 went to its scope',
  );
  assert.equal(a.destroyed, true);
  assert.equal(b.destroyed, false);
  assert.deepEqual(
    faults.injected.map(({ call }) => call),
    [1, 3],
  );
});

test('createBuffer with mappedAtCreation throws a RangeError, as the specification says', () => {
  const device = new MockDevice();
  using faults = injectGPUFaults(device, { createBuffer: 1 });
  assert.throws(() => device.createBuffer({ size: 16, mappedAtCreation: true }), RangeError);
  assert.equal(device.live.size, 0);
  assert.equal(faults.injected[0].error.name, 'RangeError');
  assert.equal(device.createBuffer({ size: 16, mappedAtCreation: true }).destroyed, false);
});

test('the n-th mapAsync rejects with OperationError and leaves the buffer unmapped; the next map works', async () => {
  const device = new MockDevice();
  using faults = injectGPUFaults(device, { mapAsync: 2 });
  const buffer = device.createBuffer({ label: 'readback', size: 16 });
  await buffer.mapAsync(1);
  buffer.mapped = false;
  await assert.rejects(buffer.mapAsync(1), (error) => error.name === 'OperationError' && /call 2/.test(error.message));
  assert.equal(buffer.mapped, false);
  await buffer.mapAsync(1);
  assert.equal(buffer.mapped, true);
  assert.deepEqual(faults.calls, { createBuffer: 1, createTexture: 0, mapAsync: 3 });
  assert.equal(faults.injected[0].label, 'readback');
});

test('restore (and using) puts every method back; other devices are never touched', () => {
  const device = new MockDevice(),
    other = new MockDevice();
  let buffer, original, faults;
  {
    using scoped = injectGPUFaults(device, { createBuffer: 5, mapAsync: 1 });
    faults = scoped;
    buffer = device.createBuffer({ size: 4 });
    original = Object.getOwnPropertyDescriptor(buffer, 'mapAsync').value;
    assert.equal(Object.hasOwn(other, 'createBuffer'), false);
    assert.equal(faults.calls.createBuffer, 1);
  }
  for (const name of ['createBuffer', 'createTexture', 'pushErrorScope', 'popErrorScope'])
    assert.equal(Object.hasOwn(device, name), false, name);
  assert.notEqual(buffer.mapAsync, original, 'the buffer has its own mapAsync back');
  return buffer.mapAsync().then(() => {
    assert.equal(buffer.mapped, true, 'the first map after restore is not failed');
    assert.equal(faults.calls.mapAsync, 0);
    const again = injectGPUFaults(device, {});
    again.restore();
    assert.equal(Object.hasOwn(device, 'createBuffer'), false);
  });
});

test('a bad plan is refused before anything is patched', () => {
  const device = new MockDevice();
  assert.throws(() => injectGPUFaults(device, { createBuffer: 0 }), RangeError);
  assert.throws(() => injectGPUFaults(device, { mapAsync: [1, 1.5] }), RangeError);
  assert.throws(() => injectGPUFaults(device, { createSampler: 1 }), /Unknown fault target/);
  assert.throws(() => injectGPUFaults(device, { error: 'internal' }), /Unknown error filter/);
  assert.equal(Object.hasOwn(device, 'createBuffer'), false);
});
