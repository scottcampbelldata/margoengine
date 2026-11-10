import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireNativeGlass, nativeGlass, nativeGlassShader } from '../src/native-glass.js';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import { extendedMaterials } from '../../gltf-pro/dist/extended.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';

test('registering native glass preserves the existing single HDR model run', async () => {
  const gpu = mockGPU();
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  try {
    const opaque = animatedTriangle(),
      glass = animatedTriangle();
    glass.doc.materials[0].extensions = { KHR_materials_transmission: { transmissionFactor: 1 } };
    parseGLTF(engine, opaque.doc, opaque.buffers);
    parseGLTF(engine, glass.doc, glass.buffers, [], { materials: extendedMaterials });
    engine.camera.update(1, true);
    engine.store.tick(false);
    const view = context(gpu, { format: 'rgba16float', samples: 4 });
    const log = gpu.record(() => {
      view.begin(0);
      engine.frameGraph.execute(view.c);
    });
    assert.equal(
      log.filter((call) => call[0] === 'beginRenderPass').length,
      1,
      'an inactive display capture must not split the HDR run into extra MSAA stores/loads',
    );
  } finally {
    engine.dispose();
  }
});

test('native glass snapshots each surface, shares capture, restores attachments and releases the last user', () => {
  const device = mockGPU().device;
  const passes = [];
  const plugins = new Map();
  const graph = { add: (pass) => passes.push(pass) };
  const engine = {
    gpu: device,
    frameGraph: graph,
    use(plugin) {
      plugins.set(plugin.name, plugin);
      plugin.setup(this);
      plugin.registerPasses(graph);
    },
    sceneOf: (plugin) => (plugins.has(plugin.name) ? {} : undefined),
    removePlugin(name) {
      const plugin = plugins.get(name);
      plugins.delete(name);
      plugin?.dispose();
    },
  };
  const releaseA = acquireNativeGlass(engine, () => true);
  const releaseB = acquireNativeGlass(engine, () => true);
  assert.equal(plugins.size, 1);
  const original = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 16 }).createView();
  const context = {
    backend: 'webgpu',
    device,
    width: 8,
    height: 8,
    color: original,
    encoder: device.createCommandEncoder(),
    format: 'rgba8unorm',
    descriptor: { depthStencil: { format: 'depth32float' }, multisample: { count: 1 } },
  };
  const createTexture = device.createTexture.bind(device);
  let allocations = 0;
  device.createTexture = (descriptor) => {
    if (++allocations === 2) throw new RangeError('allocation failed');
    return createTexture(descriptor);
  };
  assert.throws(() => passes[0].execute(context), /allocation failed/);
  assert.equal(context.color, original);
  assert.equal(nativeGlass(context), undefined);
  device.createTexture = createTexture;
  passes[0].execute(context);
  const capture = nativeGlass(context);
  assert.ok(capture);
  assert.notEqual(context.color, original);
  assert.equal(capture.entries[0].binding, 126);
  capture.copy(context);
  capture.copy(context);
  passes[1].execute(context);
  assert.equal(context.color, original);
  assert.equal(nativeGlass(context), undefined);
  context.format = 'rgba16float';
  passes[0].execute(context);
  assert.equal(nativeGlass(context), undefined, 'HDR stays on the linear blend path');
  releaseA();
  assert.equal(plugins.size, 1);
  releaseB();
  assert.equal(plugins.size, 0);
});

test('native glass keeps the linear share and adds decoded light before encoding', () => {
  const code = `@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {return vec4f(color,1);}
fn margoTintEncode(share:vec3f)->vec4f {return vec4f(encode(share),1);}
@fragment fn margoTint(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {return margoTintEncode(surface(i,front).base.rgb);}`;
  const result = nativeGlassShader(code);
  assert.match(result, /fn margoGlassShare\(i:Out,front:bool\)->vec4f/);
  assert.match(result, /margoTintEncode\(share:vec3f\)->vec4f \{return vec4f\(share,1\);\}/);
  assert.match(result, /margoGlassEncode\(margoGlassLinear\(color\)\+margoGlassLinear\(textureLoad/);
  assert.doesNotMatch(result, /@fragment fn margoTint/);
});
