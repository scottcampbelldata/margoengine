// A planar surface's normalMap is a borrowed GPU object (docs/conventions.md, "Borrowed GPU objects"): a plain
// GPUTexture is bound only on the device it was first used on and is dropped, reported once, after a device restore;
// `(device) => GPUTexture` is made again for each device. Devices and textures are stand-ins compared by identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '../dist/reflector.js';

globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16, COPY_SRC: 1 };

const texture = (label) => ({ createView: () => ({ label }) });
const state = (device) => ({ device, placeholder: texture('flat') });
const surface = (normalMap) => {
  const value = new Reflector({ normalMap }),
    errors = [];
  value.engine = { onError: (error) => errors.push(error) };
  return { value, errors };
};

test('a plain normal-map texture is dropped after a device restore and reported once', () => {
  const { value, errors } = surface(texture('caller'));
  assert.equal(value.normalView(state({ id: 'a' })).label, 'caller');
  const restored = { id: 'b' };
  assert.equal(value.normalView(state(restored)).label, 'flat', 'the old device texture is never bound on the new one');
  assert.equal(value.normalView(state(restored)).label, 'flat');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'state');
  value.engine = undefined;
  value.dispose();
});

test('a normal-map function is called once per device and nothing is reported', () => {
  const calls = [];
  const { value, errors } = surface((device) => (calls.push(device.id), texture(`made on ${device.id}`)));
  const a = { id: 'a' },
    b = { id: 'b' };
  assert.equal(value.normalView(state(a)).label, 'made on a');
  assert.equal(value.normalView(state(a)).label, 'made on a');
  assert.equal(value.normalView(state(b)).label, 'made on b');
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(errors, []);
  assert.equal(typeof value.normalMap, 'function', 'the getter returns what was set');
  value.engine = undefined;
  value.dispose();
});

test('RGBA8 pixels still upload on each device', () => {
  const pixels = { width: 1, height: 1, data: new Uint8Array([128, 128, 255, 255]) };
  const { value, errors } = surface(pixels);
  const device = (id) => ({
    id,
    createTexture: () => texture(`pixels on ${id}`),
    queue: { writeTexture() {} },
  });
  assert.equal(value.normalView(state(device('a'))).label, 'pixels on a');
  assert.equal(value.normalView(state(device('b'))).label, 'pixels on b');
  assert.equal(value.normalMap, pixels);
  assert.deepEqual(errors, []);
  value.engine = undefined;
  value.dispose();
});
