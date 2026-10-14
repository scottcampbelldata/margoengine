import test from 'node:test';
import assert from 'node:assert/strict';
import {withGPUTiming, restoreTimingSetup} from './gpu-timing.js';

function adapter(t, supported = true) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'GPUAdapter'), calls = [];
  class Adapter {
    features = new Set(supported ? ['timestamp-query'] : []);
    requestDevice(...args) {calls.push({receiver: this, args}); return Promise.resolve({args});}
  }
  Object.defineProperty(globalThis, 'GPUAdapter', {configurable: true, value: Adapter});
  t.after(() => {restoreTimingSetup(); if (saved) Object.defineProperty(globalThis, 'GPUAdapter', saved); else delete globalThis.GPUAdapter;});
  return {device: new Adapter(), prototype: Adapter.prototype, calls};
}

test('off mode does not patch or probe features and forwards the original descriptor', async t => {
  const {device, prototype, calls} = adapter(t), original = Object.getOwnPropertyDescriptor(prototype, 'requestDevice'), descriptor = {label: 'normal', requiredFeatures: ['depth32float-stencil8']};
  device.features = {has() {assert.fail('Off mode probed adapter features');}};
  await withGPUTiming(false, () => {assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'requestDevice'), original); return device.requestDevice(descriptor);});
  assert.equal(calls[0].receiver, device); assert.equal(calls[0].args[0], descriptor); assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'requestDevice'), original);
});

test('opt-in preserves caller limits/features and receiver, adds supported timestamps once, then exactly restores', async t => {
  const {device, prototype, calls} = adapter(t), original = Object.getOwnPropertyDescriptor(prototype, 'requestDevice');
  const features = new Set(['depth32float-stencil8']), descriptor = {label: 'profile', requiredFeatures: features, requiredLimits: {maxBufferSize: 65536}};
  await withGPUTiming(true, async () => {
    assert.notEqual(prototype.requestDevice, original.value); await device.requestDevice(descriptor, 'forwarded');
    const existing = {requiredFeatures: ['timestamp-query']}; await device.requestDevice(existing); assert.equal(calls[1].args[0], existing);
    await device.requestDevice();
  });
  assert.equal(calls[0].receiver, device); assert.deepEqual(calls[0].args[0].requiredFeatures, ['depth32float-stencil8', 'timestamp-query']);
  assert.equal(calls[0].args[0].requiredLimits, descriptor.requiredLimits); assert.equal(calls[0].args[1], 'forwarded'); assert.deepEqual([...features], ['depth32float-stencil8']);
  assert.deepEqual(calls[2].args[0].requiredFeatures, ['timestamp-query']); assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'requestDevice'), original);
});

test('unsupported adapters forward unchanged device requests without failing setup', async t => {
  const {device, prototype, calls} = adapter(t, false), original = Object.getOwnPropertyDescriptor(prototype, 'requestDevice'), descriptor = {requiredFeatures: ['depth32float-stencil8']};
  await withGPUTiming(true, async () => {await device.requestDevice(descriptor); await device.requestDevice();});
  assert.equal(calls[0].args[0], descriptor); assert.equal(calls[1].args.length, 0); assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'requestDevice'), original);
});

test('setup rejection and terminal-page cleanup restore the exact method before late promises settle', async t => {
  const {prototype} = adapter(t), original = Object.getOwnPropertyDescriptor(prototype, 'requestDevice');
  await assert.rejects(withGPUTiming(true, async () => {throw new Error('Device creation failed');}), /Device creation failed/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'requestDevice'), original);
  let settle; const pending = withGPUTiming(true, () => new Promise(resolve => {settle = resolve;}));
  restoreTimingSetup(); assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'requestDevice'), original); settle(42); assert.equal(await pending, 42);
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'requestDevice'), original);
});

test('overlapping setup is rejected and an old finalizer cannot undo a newer isolated setup', async t => {
  const {prototype} = adapter(t), original = Object.getOwnPropertyDescriptor(prototype, 'requestDevice'); let endFirst, endSecond;
  const first = withGPUTiming(false, () => new Promise(resolve => {endFirst = resolve;}));
  await assert.rejects(withGPUTiming(true, () => assert.fail('Concurrent creation ran')), /already in progress/);
  restoreTimingSetup(); const second = withGPUTiming(true, () => new Promise(resolve => {endSecond = resolve;})), current = prototype.requestDevice;
  endFirst(); await first; assert.equal(prototype.requestDevice, current); endSecond(); await second;
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'requestDevice'), original);
});
