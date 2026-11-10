// Regression (lane L, 2026-11-10, M6 Mac mini): a bind group's shared storage texture was registered for cleanup with
// `{ gl, texture }` as the FinalizationRegistry held value. A registry holds its held values strongly, and a real
// context reaches its device (the canvas's context-lost listener), so the device, its engine and the bind group itself
// were never collected: oit vfx-check under MARGO_COMPAT=1 ran out of Wasm memory after about 124 engines with VFX.
// The fake context below references its device the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { CompatBindGroup } from '../dist/device.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

function fakeDevice(deleted) {
  const device = { groups: [] };
  device.gl = {
    TEXTURE_2D: 0x0de1,
    RGBA32UI: 0x8d70,
    device, // a real context reaches the device through its canvas's event listeners
    createTexture: () => ({ name: 'shared' }),
    texStorage2D() {},
    isContextLost: () => false,
    deleteTexture: (texture) => deleted.push(texture),
  };
  device.state = { scratch() {} };
  return device;
}

function sharedGroup(device) {
  const group = Object.create(CompatBindGroup.prototype);
  Object.assign(group, {
    device,
    layout: { entries: [{ binding: 0, buffer: { type: 'storage', hasDynamicOffset: false } }] },
    entries: new Map([[0, { kind: 'buffer', buffer: { size: 64, version: 0, destroyed: true }, offset: 0, size: 64 }]]),
    shared: null,
  });
  assert.ok(group.storageTexture(), 'the group made its shared texture');
  device.groups.push(group); // an engine keeps its plugins' bind groups
  return group;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
// Collects in a job of its own: WeakRef.deref() keeps its target alive until the end of the job that called it.
const settle = async (until) => {
  for (let n = 0; n < 50; n++) {
    await tick();
    gc();
    await tick();
    if (until()) return;
  }
};

test('a device whose bind group made a shared storage texture can be collected', async () => {
  const deleted = [];
  let ref;
  (() => {
    const device = fakeDevice(deleted);
    sharedGroup(device);
    ref = new WeakRef(device);
  })();
  await settle(() => ref.deref() === undefined);
  assert.equal(ref.deref(), undefined, 'the cleanup registry kept the device alive');
});

test('a dropped bind group of a live device still deletes its shared texture', async () => {
  const deleted = [],
    device = fakeDevice(deleted);
  (() => {
    const group = sharedGroup(device);
    device.groups.length = 0;
    return group.shared.texture;
  })();
  await settle(() => deleted.length > 0);
  assert.deepEqual(deleted, [{ name: 'shared' }]);
  assert.ok(device.gl, 'device still live');
});
