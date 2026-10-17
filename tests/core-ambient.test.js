import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, Camera, FrameGraph } from '../packages/core/dist/extension.js';
import { GPURenderer } from '../packages/core/dist/renderer.js';
import { GLRenderer } from '../packages/webgl/dist/index.js';
import { wgsl } from '../packages/core/src/shaders.ts';
import { SSAO } from '../packages/post/dist/index.js';
import { lighting as skyLighting } from '../packages/sky/src/lighting.ts';
import { optionalGPU } from './support/optional-gpu.js';
import { glDrawHarness } from './support/core-draw-gpu.js';

const light = () => ({ direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.25]) });

function rendererFixture(t) {
  const h = optionalGPU(),
    device = h.engine.gpu;
  Object.assign(device, {
    lost: new Promise(() => {}),
    addEventListener() {},
    destroy() {},
    createCommandEncoder: () => ({ ...h.context.encoder, finish: () => ({}), copyTextureToBuffer() {} }),
  });
  device.queue.submit = () => {};
  const renderer = new GPURenderer(
      { width: 64, height: 64 },
      device,
      { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) },
      'bgra8unorm',
      { getBindGroupLayout: () => ({}) },
      { multisample: { count: 1 }, depthStencil: { format: 'depth32float' } },
      { getBindGroupLayout: () => ({}) },
    ),
    camera = new Camera();
  camera.update(1, true);
  t.after(() => {
    renderer.dispose();
    h.cleanup();
  });
  return { ...h, renderer, camera };
}

test('core frame uploads colored ambient while legacy lighting and later omission retain white', (t) => {
  const h = rendererFixture(t),
    lighting = light(),
    graph = new FrameGraph();
  h.renderer.render(h.camera, lighting, [], graph, 0);
  const uniform = h.resources.find((r) => r.usage === 72),
    frame = new Float32Array(uniform.data);
  assert.equal(uniform.size, 128, 'the canonical frame must hold the ambient tail');
  assert.deepEqual([...frame.subarray(20, 28)], [3, 5, 4, 3, 1, 1, 1, 0.25]);
  assert.deepEqual([...frame.subarray(28, 32)], [1, 1, 1, 0]);
  lighting.ambient = new Float32Array([2, 0.5, 0]);
  h.renderer.render(h.camera, lighting, [], graph, 0);
  assert.deepEqual([...frame.subarray(28, 32)], [2, 0.5, 0, 0]);
  assert.equal(frame[27], 0.25, 'RGB must not replace the legacy intensity');
  delete lighting.ambient;
  h.renderer.render(h.camera, lighting, [], graph, 0);
  assert.deepEqual([...frame.subarray(28, 32)], [1, 1, 1, 0], 'omission must clear the previous tint');
});

test('core picking uploads the canonical ambient tail', async (t) => {
  const h = rendererFixture(t),
    lighting = { ...light(), ambient: new Float32Array([0.25, 0.5, 2]) };
  await h.renderer.pick(h.camera, lighting, [], new FrameGraph(), 0, 0);
  const uniform = h.resources.filter((r) => r.usage === 72).at(-1);
  assert.equal(uniform.size, 128, 'picking must bind the complete canonical Frame');
  assert.deepEqual([...new Float32Array(uniform.data).subarray(28, 32)], [0.25, 0.5, 2, 0]);
});

test('engine defaults ambient to white and rejects malformed RGB before rendering', async (t) => {
  let renders = 0;
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(4),
    { backend: 'webgpu', add() {}, remove() {}, dispose() {}, render: () => renders++ },
    {},
    null,
  );
  t.after(() => engine.dispose());
  const defaultAmbient = engine.lighting.ambient;
  for (const rgb of [
    [1, 1],
    [1, 1, 1, 1],
    [NaN, 1, 1],
    [Infinity, 1, 1],
    [-0.1, 1, 1],
  ]) {
    engine.lighting.ambient = new Float32Array(rgb);
    assert.throws(() => engine.render(), /Ambient|lighting/, 'invalid RGB must not reach the renderer');
  }
  assert.deepEqual(Array.from(defaultAmbient ?? []), [1, 1, 1]);
  assert.equal(renders, 0);
  engine.lighting.ambient = new Float32Array([0, 0.5, 2]);
  engine.render();
  assert.equal(renders, 1);
});

test('SSAO replays the RGB ambient and Sky replaces its whole absolute-color multiplier', () => {
  const h = optionalGPU(),
    ssao = new SSAO(),
    owned = [],
    sky = skyLighting.create(h.engine.gpu, owned);
  h.context.shader = wgsl;
  h.engine.use(ssao);
  try {
    h.engine.frameGraph.execute(h.context);
    const ambient = h.pipelines.find((p) =>
      p.fragment?.module.code.includes(
        'return vec4f(i.color*(1.0-i.material.y)*frame.radiance.w*frame.ambient.rgb,1);',
      ),
    );
    assert.ok(ambient, 'SSAO must replay the same RGB ambient that beauty receives');
    h.context.shader = wgsl;
    sky.pass(h.context);
    assert.match(h.context.shader, /i.color\*\(1.0-i.material.y\)\*skyAmbient.rgb;/);
    assert.ok(!h.context.shader.includes('skyAmbient.rgb*frame.ambient.rgb'), 'Sky colors are absolute');
  } finally {
    ssao.dispose();
    for (const resource of owned) resource.destroy();
    h.cleanup();
  }
});

test('WebGL uploads RGB ambient and resets omitted lighting to white', (t) => {
  const h = glDrawHarness(t),
    values = [],
    codes = [];
  h.gl.uniform3f = (name, ...rgb) => values.push([name, ...rgb]);
  h.gl.shaderSource = (_shader, code) => codes.push(code);
  const renderer = new GLRenderer(h.canvas),
    camera = new Camera(),
    lighting = { ...light(), ambient: new Float32Array([2, 0.5, 0]) };
  t.after(() => renderer.dispose());
  camera.update(4 / 3, false);
  renderer.render(camera, lighting, [], new FrameGraph(), 0);
  assert.deepEqual(
    values.find(([name]) => name === 'ambient'),
    ['ambient', 2, 0.5, 0],
  );
  assert.ok(codes.some((code) => code.includes('radiance.w*ambient')));
  delete lighting.ambient;
  renderer.render(camera, lighting, [], new FrameGraph(), 0);
  assert.deepEqual(values.filter(([name]) => name === 'ambient').at(-1), ['ambient', 1, 1, 1]);
});

test('SSAO retains Sky absolute ambient RGB and its live uniform binding', () => {
  const h = optionalGPU(),
    ssao = new SSAO(),
    owned = [],
    sky = skyLighting.create(h.engine.gpu, owned),
    replays = [];
  h.context.shader = wgsl;
  h.context.draw = (options) => {
    if (options?.pipeline?.fragment.module.code.includes('return vec4f(i.color*(1.0-i.material.y)*skyAmbient.rgb,1);'))
      replays.push(options);
  };
  h.engine.frameGraph.add({ name: 'test:sky', order: -6, execute: (c) => sky.pass(c) });
  h.engine.use(ssao);
  try {
    h.engine.frameGraph.execute(h.context);
    assert.equal(replays.length, 1, 'the ambient replay must use Sky colors, rather than the engine scalar');
    assert.ok(
      replays[0].bindings.some((entry) => entry.binding === 8),
      'Sky ambient must remain bound during replay',
    );
  } finally {
    ssao.dispose();
    for (const resource of owned) resource.destroy();
    h.cleanup();
  }
});
