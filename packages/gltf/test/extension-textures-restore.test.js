import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMaterialExtension, extensionTexturesPortable } from '../src/material-extension.ts';

// KB-RESTORE-BORROWED1: MaterialExtensionTexture.view and .sampler belong to the device that made them (docs/conventions.md,
// "Borrowed GPU objects"). A plain one is lost at a restore and reported once; `(device) => object` comes back by itself.
globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };
const fake = (name) => {
  const made = [];
  const device = {
    name,
    limits: { maxBufferSize: 1 << 28, maxUniformBufferBindingSize: 65536, maxBindGroups: 4 },
    createBuffer: (d) => ({ ...d, destroy() {} }),
    createTexture: (d) => (made.push('texture'), { ...d, createView: () => ({ stand: name }) }),
    createSampler: () => (made.push('sampler'), { stand: name }),
    queue: { writeBuffer() {}, writeTexture() {} },
    made,
  };
  return device;
};
const one = fake('one'),
  two = fake('two');
const view = (device) => ({ view: device.name }),
  sampler = (device) => ({ sampler: device.name });

test('plain extension textures are lost with the device: a white stand-in is bound and the loss is reported once', () => {
  const errors = [],
    engine = { onError: (e) => errors.push(e) };
  const plain = { view: { own: 'one' }, sampler: { own: 'one' } };
  const extension = { textures: [plain] };
  let resource = prepareMaterialExtension(one, extension, undefined, engine);
  assert.equal(resource.entries[0].resource, plain.view, 'bound on the device that first used it');
  assert.equal(resource.entries[1].resource, plain.sampler);
  resource = prepareMaterialExtension(two, extension, resource, engine);
  resource = prepareMaterialExtension(two, extension, resource, engine);
  assert.deepEqual(resource.entries[0].resource, { stand: 'two' }, 'the white stand-in view');
  assert.deepEqual(resource.entries[1].resource, { stand: 'two' }, 'the stand-in sampler');
  assert.deepEqual(two.made, ['texture', 'sampler'], 'made once per device');
  assert.equal(errors.length, 2, 'one report for the view, one for the sampler');
  assert.equal(errors[0].code, 'state');
  assert.match(
    errors[0].message,
    /MaterialExtension textures\[0\]\.view lost with the device; pass a function or call give the material a new MaterialExtension/,
  );
  assert.match(errors[1].message, /textures\[0\]\.sampler lost/);
});

test('(device) => view and sampler are called once per device and never reported', () => {
  const errors = [],
    engine = { onError: (e) => errors.push(e) },
    calls = [];
  const extension = {
    textures: [
      {
        view: (d) => (calls.push(['view', d.name]), view(d)),
        sampler: (d) => (calls.push(['sampler', d.name]), sampler(d)),
      },
    ],
  };
  let resource = prepareMaterialExtension(one, extension, undefined, engine);
  resource = prepareMaterialExtension(one, extension, resource, engine);
  assert.deepEqual(
    resource.entries.map((e) => e.resource),
    [{ view: 'one' }, { sampler: 'one' }],
  );
  resource = prepareMaterialExtension(two, extension, resource, engine);
  assert.deepEqual(
    resource.entries.map((e) => e.resource),
    [{ view: 'two' }, { sampler: 'two' }],
  );
  assert.deepEqual(calls, [
    ['view', 'one'],
    ['sampler', 'one'],
    ['view', 'two'],
    ['sampler', 'two'],
  ]);
  assert.deepEqual(errors, []);
});

test('only an extension whose textures are all functions may be drawn on another device', () => {
  assert.equal(extensionTexturesPortable(undefined), true);
  assert.equal(extensionTexturesPortable({ textures: [] }), true);
  assert.equal(extensionTexturesPortable({ textures: [{ view, sampler }] }), true);
  assert.equal(extensionTexturesPortable({ textures: [{ view }] }), true);
  assert.equal(extensionTexturesPortable({ textures: [{ view, sampler: {} }] }), false);
  assert.equal(extensionTexturesPortable({ textures: [{ view: {} }] }), false);
});
