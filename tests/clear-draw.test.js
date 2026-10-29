import test from 'node:test';
import assert from 'node:assert/strict';
import { clearColorValue, clearDraw, defaultClear } from '../packages/shared/clear-color.js';

// A recording device and pass: enough of WebGPU for clearDraw.
function recorder() {
  const log = [],
    make = (kind) => (descriptor) => {
      const object = { kind, descriptor };
      log.push(object);
      return object;
    };
  const device = {
    createBindGroupLayout: make('bindGroupLayout'),
    createPipelineLayout: make('pipelineLayout'),
    createBuffer: make('buffer'),
    createBindGroup: make('bindGroup'),
    createShaderModule: make('module'),
    createRenderPipeline: make('pipeline'),
    queue: { writeBuffer: (buffer, offset, data) => log.push({ kind: 'write', buffer, offset, data: [...data] }) },
  };
  const calls = [],
    pass = new Proxy(
      {},
      {
        get:
          (_, name) =>
          (...args) =>
            calls.push([name, ...args]),
      },
    );
  return { device, pass, log, calls, of: (kind) => log.filter((e) => e.kind === kind) };
}

const options = { formats: ['bgra8unorm'], depthFormat: 'depth32float-stencil8', writeDepth: true, samples: 4 };

// Bug 61: on Intel Arc under D3D12 a draw whose colour came from the blend constant wrote black into a 4x MSAA target,
// so every partial view drew a black background there. The colour now comes from the shader, with blending off.
test('clearDraw takes its colour from a uniform, never from the blend constant', () => {
  const r = recorder(),
    cache = new Map(),
    red = clearColorValue('#440000');
  clearDraw(r.device, cache, r.pass, { ...options, tint: red });
  assert.deepEqual(
    r.calls.filter(([name]) => name === 'setBlendConstant'),
    [],
    'no setBlendConstant',
  );
  for (const pipeline of r.of('pipeline'))
    for (const target of pipeline.descriptor.fragment.targets) {
      assert.equal(target.blend, undefined, 'blending is off on every clear target');
      assert.doesNotMatch(JSON.stringify(target), /constant/);
    }
  const [module] = r.of('module');
  assert.match(module.descriptor.code, /var<uniform> t:vec4f/);
  assert.match(module.descriptor.code, /return Out\(t\)/);
  // The colour is written at full float precision into the buffer the bound group reads.
  const [write] = r.of('write'),
    [group] = r.of('bindGroup');
  assert.deepEqual(write.data, [...new Float32Array(red)]);
  assert.equal(group.descriptor.entries[0].resource.buffer, write.buffer);
  assert.deepEqual(
    r.calls.map(([name]) => name),
    ['setPipeline', 'setBindGroup', 'draw'],
  );
  assert.equal(r.calls[1][2], group);
  assert.equal(r.calls[2][1], 3);
});

test('clears of different colours reuse one pipeline; a colour seen before reuses its bind group', () => {
  const r = recorder(),
    cache = new Map(),
    colours = ['#440000', '#000044', '#123456'].map(clearColorValue);
  for (const tint of [...colours, colours[0]]) clearDraw(r.device, cache, r.pass, { ...options, tint });
  assert.equal(r.of('pipeline').length, 1, 'one pipeline whatever the colour');
  assert.equal(r.of('module').length, 1);
  assert.equal(r.of('bindGroupLayout').length, 1);
  assert.equal(r.of('buffer').length, 3, 'one uniform per distinct colour');
  assert.deepEqual(
    r.of('write').map((w) => w.data),
    colours.map((c) => [...new Float32Array(c)]),
  );
  const bound = r.calls.filter(([name]) => name === 'setBindGroup').map((call) => call[2]);
  assert.equal(new Set(bound.slice(0, 3)).size, 3);
  assert.equal(bound[3], bound[0], 'the first colour again binds its first group');
  // Another sample count or format is another pipeline, still one per target set.
  clearDraw(r.device, cache, r.pass, { ...options, samples: 1, tint: colours[1] });
  assert.equal(r.of('pipeline').length, 2);
  assert.equal(r.of('pipeline')[1].descriptor.multisample.count, 1);
});

test('clearDraw keeps the colour when writeColor is false, and keeps a bounded set of colours', () => {
  const r = recorder(),
    cache = new Map();
  clearDraw(r.device, cache, r.pass, { ...options, writeColor: false });
  assert.equal(r.of('pipeline')[0].descriptor.fragment.targets[0].writeMask, 0);
  assert.deepEqual(r.of('write')[0].data, [...new Float32Array(defaultClear)]);
  // An animated background: 200 colours make 200 uniforms but the cache holds at most 64 groups.
  for (let i = 0; i < 200; i++) clearDraw(r.device, cache, r.pass, { ...options, tint: [i / 255, 0, 0, 1] });
  assert.equal(r.of('pipeline').length, 2);
  const before = r.of('buffer').length;
  clearDraw(r.device, cache, r.pass, { ...options, tint: [199 / 255, 0, 0, 1] });
  assert.equal(r.of('buffer').length, before, 'a recent colour is still cached');
  clearDraw(r.device, cache, r.pass, { ...options, tint: [0, 0, 0, 1] });
  assert.equal(r.of('buffer').length, before + 1, 'an evicted colour is made again');
});
