import test from 'node:test';
import assert from 'node:assert/strict';
import { captureDevice } from '../src/capture-device.ts';

test('capture device reuses bound methods and preserves native receiver, descriptors and live overrides', () => {
  const calls = [];
  const device = {
    value: 7,
    get limits() {
      assert.equal(this, device);
      return this.value;
    },
    createBuffer(descriptor) {
      assert.equal(this, device);
      calls.push(descriptor);
      return descriptor;
    },
    createShaderModule(descriptor) {
      assert.equal(this, device);
      calls.push(descriptor);
      return descriptor;
    },
  };
  const proxy = captureDevice(device, (code) => code + '\n// capture');
  const buffer = proxy.createBuffer,
    shader = proxy.createShaderModule;
  for (let i = 0; i < 1000; i++) {
    assert.equal(proxy.createBuffer, buffer);
    assert.equal(proxy.createShaderModule, shader);
    assert.equal(proxy.limits, 7);
  }
  const descriptor = { label: 'original', code: 'shader', compilationHints: [{ entryPoint: 'main' }] };
  const compiled = shader(descriptor);
  assert.notEqual(compiled, descriptor);
  assert.equal(compiled.code, 'shader\n// capture');
  assert.equal(descriptor.code, 'shader');
  assert.equal(compiled.compilationHints, descriptor.compilationHints);
  buffer({ size: 16 });
  device.createBuffer = function (d) {
    assert.equal(this, device);
    return d.size * 2;
  };
  const replaced = proxy.createBuffer;
  assert.notEqual(replaced, buffer);
  assert.equal(replaced({ size: 16 }), 32);
  assert.equal(proxy.createBuffer, replaced);
  device.createShaderModule = function (d) {
    assert.equal(this, device);
    return 'replacement:' + d.code;
  };
  assert.notEqual(proxy.createShaderModule, shader);
  assert.equal(proxy.createShaderModule(descriptor), 'replacement:shader\n// capture');
  device.value = 8;
  assert.equal(proxy.limits, 8);
  const second = captureDevice({ ...device }, (code) => code);
  assert.notEqual(second.createBuffer, proxy.createBuffer, 'Separate devices keep separate native receivers');
});
