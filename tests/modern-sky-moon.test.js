import test from 'node:test';
import assert from 'node:assert/strict';
import { SkyMoonPass } from '../packages/scenery/dist/index.js';

function fixture(t, depthFormat = 'depth32float') {
  for (const [name, value] of Object.entries({
    GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8 },
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 },
  })) {
    const previous = globalThis[name];
    globalThis[name] = value;
    t.after(() => {
      if (previous === undefined) delete globalThis[name];
      else globalThis[name] = previous;
    });
  }
  const state = { resources: 0, writes: 0, destroyed: 0, commands: [] };
  const create = (name, result) => (descriptor) => {
    state.resources++;
    state[name] = descriptor;
    return result;
  };
  const buffer = {
      destroy() {
        state.destroyed++;
      },
    },
    pipeline = {},
    group = {};
  const device = {
    createBuffer: create('buffer', buffer),
    createBindGroupLayout: create('layout', {}),
    createBindGroup: create('group', group),
    createShaderModule: create('shader', {}),
    createPipelineLayout: create('pipelineLayout', {}),
    createRenderPipeline: create('pipeline', pipeline),
    queue: {
      writeBuffer(target, offset, data) {
        assert.equal(target, buffer);
        assert.equal(offset, 0);
        if (state.data)
          assert.equal(data, state.data, 'Frame staging array was replaced');
        state.data = data;
        state.writes++;
      },
    },
  };
  const pass = new SkyMoonPass(device, 'rgba16float', depthFormat);
  const encoder = {
    setPipeline(value) {
      assert.equal(value, pipeline);
      state.commands.push('pipeline');
    },
    setBindGroup(index, value) {
      assert.equal(index, 0);
      assert.equal(value, group);
      state.commands.push('group');
    },
    draw(...args) {
      assert.deepEqual(args, [3, 1, 0, 0]);
      state.commands.push('draw');
    },
  };
  const inverse = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
  const camera = Object.freeze([2, 3, 4]);
  pass.updateFrame(inverse, camera, 5);
  return { pass, state, device, encoder, inverse, camera };
}

test('SkyMoonPass packs 160 aligned bytes, normalized defaults, and Reversed-Z pipeline state', (t) => {
  const { pass, state, inverse, device } = fixture(t);
  assert.equal(state.buffer.size, 160);
  assert.equal(state.buffer.size % 16, 0);
  assert.equal(state.buffer.usage, 72);
  assert.equal(state.layout.entries[0].buffer.minBindingSize, 160);
  assert.deepEqual([...state.data.slice(0, 16)], [...inverse]);
  assert.deepEqual([...state.data.slice(16, 20)], [2, 3, 4, 1]);
  assert.ok(Math.abs(Math.hypot(...state.data.slice(20, 23)) - 1) < 1e-6);
  assert.equal(state.data[23], Math.fround(Math.cos(0.038)));
  assert.deepEqual(
    [...state.data.slice(24, 36)],
    [
      0.015,
      0.025,
      0.065,
      1,
      0.08,
      0.09,
      0.15,
      1,
      0.92,
      0.95,
      1,
      Math.sin(0.038),
    ].map(Math.fround),
  );
  assert.equal(state.layout.entries[0].visibility, 3);
  assert.deepEqual(
    [...state.data.slice(36)],
    [0.85, 1.2, 0.8, 5].map(Math.fround),
  );
  assert.deepEqual(state.pipeline.depthStencil, {
    format: 'depth32float',
    depthWriteEnabled: false,
    depthCompare: 'greater-equal',
  });
  assert.equal(state.pipeline.vertex.entryPoint, 'vs_main');
  assert.equal(state.pipeline.fragment.entryPoint, 'fs_main');
  pass.dispose();
  assert.equal(state.destroyed, 1);
  const withoutDepth = new SkyMoonPass(device, 'rgba8unorm');
  assert.equal(state.pipeline.depthStencil, undefined);
  withoutDepth.dispose();
});

test('SkyMoonPass clamps parameters, patches config, and rejects invalid inputs before mutation/upload', (t) => {
  const { pass, state, inverse, camera } = fixture(t);
  pass.setConfig({
    moonDirection: [3, 4, 0],
    moonPhase: 3,
    glowIntensity: -1,
    starIntensity: -2,
  });
  pass.updateFrame([...inverse], camera, 0);
  assert.deepEqual(
    [...state.data.slice(20, 23)],
    [0.6, 0.8, 0].map(Math.fround),
  );
  assert.deepEqual([...state.data.slice(36)], [1, 0, 0, 0]);
  pass.setConfig({ moonPhase: -3, zenithColor: [0.1, 0.2, 0.3] });
  pass.updateFrame(inverse, camera, 1);
  assert.equal(state.data[36], -1);
  assert.deepEqual(
    [...state.data.slice(24, 27)],
    [0.1, 0.2, 0.3].map(Math.fround),
  );
  const snapshot = state.data.slice(),
    writes = state.writes;
  for (const config of [
    { moonDirection: [0, 0, 0] },
    { moonDirection: [1, NaN, 0] },
    { moonDirection: [1, 2] },
    { zenithColor: [-1, 0, 0] },
    { moonColor: [1, Infinity, 0] },
    { horizonColor: [0, 1e40, 0] },
    { moonSize: 0 },
    { moonSize: -0.1 },
    { moonSize: Math.PI / 2 },
    { moonSize: 1e-50 },
    { moonPhase: NaN },
    { glowIntensity: Infinity },
    { starIntensity: 1e40 },
    { moonPhase: '1' },
    { hazeDensity: NaN },
    { starTwinkleIntensity: Infinity },
    { zenithColor: [1, 1, 1], moonSize: 0 },
  ]) {
    assert.throws(() => pass.setConfig(config));
    assert.deepEqual(state.data, snapshot);
  }
  for (const args of [
    [inverse.slice(1), camera, 0],
    [[...inverse, 0], camera, 0],
    [new Float32Array(16).fill(NaN), camera, 0],
    [inverse, [0, Infinity, 0], 0],
    [inverse, camera, Infinity],
  ]) {
    assert.throws(() => pass.updateFrame(...args));
    assert.deepEqual(state.data, snapshot);
  }
  assert.equal(state.writes, writes);
  pass.dispose();
});

test('SkyMoonPass preserves independent haze and twinkle controls when colors change', (t) => {
  const { pass, state, inverse, camera } = fixture(t);
  pass.setConfig({ hazeDensity: 0.35, starTwinkleIntensity: 0 });
  pass.setConfig({
    horizonColor: [0.1, 0.2, 0.3],
    zenithColor: [0.01, 0.02, 0.03],
  });
  pass.updateFrame(inverse, camera, 0);
  assert.equal(state.data[31], Math.fround(0.35));
  assert.equal(state.data[27], 0);
  pass.setConfig({ hazeDensity: -1, starTwinkleIntensity: -1 });
  pass.updateFrame(inverse, camera, 0);
  assert.equal(state.data[31], 0);
  assert.equal(state.data[27], 0);
  pass.dispose();
});

test('SkyMoonPass computes lunar trigonometry on configuration and retains it across color patches', (t) => {
  const { pass, state, inverse, camera } = fixture(t);
  pass.setConfig({ moonSize: 0.12 });
  pass.setConfig({ moonColor: [0.5, 0.6, 0.7] });
  pass.updateFrame(inverse, camera, 0);
  assert.equal(state.data[23], Math.fround(Math.cos(0.12)));
  assert.equal(state.data[35], Math.fround(Math.sin(0.12)));
  pass.dispose();
});

test('SkyMoonPass reuses staging and all GPU resources for repeated update/record ticks', (t) => {
  const { pass, state, device, encoder, inverse, camera } = fixture(t);
  const data = state.data,
    resources = state.resources;
  for (const name of Object.keys(device))
    if (name.startsWith('create'))
      device[name] = () => assert.fail(`Tick allocated ${name}`);
  for (let frame = 0; frame < 100; frame++) {
    pass.updateFrame(inverse, camera, frame / 60);
    pass.record(encoder);
  }
  assert.equal(state.data, data);
  assert.equal(state.resources, resources);
  assert.equal(state.writes, 101);
  assert.deepEqual(
    state.commands,
    Array.from({ length: 100 }, () => ['pipeline', 'group', 'draw']).flat(),
  );
  assert.equal(state.data[39], Math.fround(99 / 60));
  pass.dispose();
});

test('SkyMoonPass releases its buffer if pipeline construction fails', (t) => {
  const { pass, device, state } = fixture(t);
  device.createRenderPipeline = () => {
    throw new Error('Pipeline failed');
  };
  assert.throws(
    () => new SkyMoonPass(device, 'rgba16float'),
    /Pipeline failed/,
  );
  assert.equal(state.destroyed, 1);
  pass.dispose();
});

test('SkyMoonPass allocates its 4x pipeline only when a 4x scene records it',t=>{
  const {pass,state,encoder}=fixture(t),resources=state.resources;
  assert.equal(state.pipeline.multisample,undefined);pass.record(encoder,1);assert.equal(state.resources,resources);
  pass.record(encoder,4);assert.equal(state.resources,resources+1);assert.equal(state.pipeline.multisample.count,4);
  pass.record(encoder,4);assert.equal(state.resources,resources+1);pass.dispose();
});
