// KB-RESTORE-BORROWED1 (docs/conventions.md, "Borrowed GPU objects"): the baked textures are outputs, never a caller's
// input (the registry rows PBRTextureSet.albedo, .normal, .roughness, .height and WebGPUBakedTexture.texture are exempt).
// A baker belongs to the device it was created with and ends when that device is lost; every texture it hands out is one
// it made on that device, and a baker made on the replacement device makes its textures on the replacement only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextureBaker } from '../dist/textures.js';
import { createPBRTextureBaker } from '../dist/textures-pbr.js';

function device() {
  let lose;
  const made = [],
    d = {
      limits: { maxTextureDimension2D: 2048 },
      lost: new Promise((r) => (lose = r)),
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
      createTexture(desc) {
        const t = { desc, owner: d, destroy() {}, createView: () => ({ texture: t }) };
        made.push(t);
        return t;
      },
      createBuffer: () => ({ destroy() {} }),
      createBindGroup: (x) => x,
      createCommandEncoder: () => ({
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
        finish: () => ({}),
      }),
      queue: { writeBuffer() {}, submit() {}, onSubmittedWorkDone: async () => {} },
    };
  return { d, made, lose: () => lose({ reason: 'destroyed' }) };
}

test("a baked texture is made on the baker's device; after a loss a baker on the new device makes its own", async () => {
  const a = device(),
    b = device();
  using first = await createTextureBaker(a.d);
  using firstPBR = await createPBRTextureBaker(a.d);
  const one = await first.bake(),
    set = await firstPBR.bake();
  assert.equal(one.texture.owner, a.d);
  for (const map of [set.albedo, set.normal, set.roughness, set.height]) assert.equal(map.owner, a.d);
  a.lose();
  await a.d.lost;
  await assert.rejects(first.bake(), /replacement device/);
  await assert.rejects(firstPBR.bake(), /replacement device/);
  const madeOnA = a.made.length;
  using second = await createTextureBaker(b.d);
  using secondPBR = await createPBRTextureBaker(b.d);
  const next = await second.bake(),
    nextSet = await secondPBR.bake();
  assert.equal(next.texture.owner, b.d);
  for (const map of [nextSet.albedo, nextSet.normal, nextSet.roughness, nextSet.height]) assert.equal(map.owner, b.d);
  assert.equal(a.made.length, madeOnA, 'nothing more is made on the lost device');
});
