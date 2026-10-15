import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentBackground } from '../packages/environment/dist/index.js';
import { optionalGPU } from './support/optional-gpu.js';

test('EnvironmentBackground rolls back failed native state initialization and retries with stable resources', () => {
  for (const method of ['createPipelineLayout', 'createShaderModule', 'createSampler']) {
    const h = optionalGPU(),
      d = h.engine.gpu;
    globalThis.GPUShaderStage = { FRAGMENT: 2 };
    d.createBindGroupLayout = (x) => x;
    d.createPipelineLayout = (x) => x;
    const cube = d.createTexture({ size: [2, 2, 6], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING }),
      view = cube.createView();
    const environment = {
        device: d,
        disposed: false,
        version: 1,
        rotation: 0,
        cubeView: view,
        specularView: view,
        roughnessToLod: () => 0,
      },
      background = new EnvironmentBackground(environment),
      operation = d[method],
      failure = new Error(method + ' failed');
    d[method] = () => {
      throw failure;
    };
    assert.throws(
      () => background.record(h.context),
      (error) => error === failure,
    );
    d[method] = operation;
    assert.ok(
      h.resources.every((r) => r === cube || r.destroyed),
      method + ' leaked the background uniform',
    );
    background.record(h.context);
    const counts = { ...h.counts };
    for (let i = 0; i < 120; i++) background.record(h.context);
    for (const key of ['buffers', 'textures', 'groups', 'views']) assert.equal(h.counts[key], counts[key]);
    background.dispose();
    assert.equal(cube.destroyed, false);
    cube.destroy();
    assert.ok(h.resources.every((r) => r.destroyed));
  }
});
