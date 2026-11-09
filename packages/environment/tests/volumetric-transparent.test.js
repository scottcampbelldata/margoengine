// Fogged transparents (`VolumetricFog.add`, @margoengine/environment/volumetric) on the recording mock GPU: the fog takes
// over a model's or an effect's transparent draw and runs it right after its composite, in a pass over the frame with
// depth read only; the hook declarations fog each fragment; a frame the fog skips still draws them, unfogged; removers
// and dispose give the draw back; and without `add` every shader and uniform byte is what it was before the option.
// Real-GPU checks against a CPU mirror: tests/volumetric-transparent-browser.js (npm run test:fog-transparent:browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Camera } from '../../core/dist/extension.js';
import { SceneTarget } from '../../shared/msaa.js';
import { VolumetricFog } from '../dist/volumetric.js';

const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
function rig(options = {}) {
  const gpu = mockGPU(),
    view = context(gpu, { samples: 1, format: 'rgba16float', shader: 'lit shader' }),
    size = [view.state.width, view.state.height];
  const engine = {
    gpu: gpu.device,
    plugins: new Map(),
    lighting: { direction: new Float32Array([0, 0.6, -0.8, 3]), radiance: new Float32Array([1, 0.9, 0.8, 0.1]) },
    sceneOf() {
      return this;
    },
    removePlugin() {},
  };
  const target = new SceneTarget(
    gpu.device,
    gpu.device.createTexture({ size, format: 'rgba16float', usage }),
    gpu.device.createTexture({ size, format: 'depth24plus-stencil8', usage }),
    1,
  );
  const fog = new VolumetricFog(options);
  engine.plugins.set(fog.name, fog);
  fog.setup(engine);
  const run = passes(fog);
  const frame = (i) => {
    view.begin(i);
    target.begin(view.c);
    const camera = new Camera({ position: [0, 2, 0], target: [0, 2, -10], near: 0.1, far: 500 });
    camera.update(16 / 9, true);
    view.c.camera = camera;
    run(view.c);
  };
  return { gpu, fog, frame, record: (work) => gpu.record(work) };
}
const sha = (text) => createHash('sha256').update(text).digest('hex');
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);
// jitter.w of the fog uniform (float 71, byte 284): 1 while it fogs added transparents.
const flag = (log) =>
  log
    .filter((e) => e[0] === 'writeBuffer' && (e[2] === 284 || (e[2] === 0 && e[3].length >= 576)))
    .map((e) => Buffer.from(e[2] === 284 ? e[3].slice(0, 8) : e[3].slice(568, 576), 'hex').readFloatLE(0));

// A gltf-pro model's side of the hook: it hands its BLEND draw to the hook and draws into the hook's pass.
function model() {
  const m = {
    hook: undefined,
    draws: 0,
    listeners: [],
    setTransparency(hook) {
      m.hook = hook;
      return () => {
        if (m.hook === hook) m.hook = undefined;
      };
    },
    onDispose(listener) {
      m.listeners.push(listener);
      return () => (m.listeners = m.listeners.filter((l) => l !== listener));
    },
    draw(c, mode, color, depth) {
      assert.equal(mode, 'transparent');
      assert.equal(color, c.color);
      assert.equal(depth, c.depth);
      const pass = m.hook.begin();
      pass.setBindGroup(2, c.device.createBindGroup({ layout: {}, entries: m.hook.bindings() }));
      pass.draw(6);
      m.draws++;
    },
  };
  return m;
}
function effect() {
  const e = {
    hook: undefined,
    released: undefined,
    draws: 0,
    setTransparency(hook, released) {
      e.hook = hook;
      e.released = released;
      return () => (e.hook = undefined);
    },
    drawTransparent(c, hook) {
      assert.equal(hook, e.hook);
      hook.begin().draw(3, 10);
      e.draws++;
    },
  };
  return e;
}

test('without add: every shader and the uniform are what they were before the option', () => {
  const { record, frame } = rig({ temporal: 0 });
  const log = record(() => frame(0));
  // SHA-256 of the froxel and composite shaders at 2d4f794f1 (before fogged transparents).
  assert.deepEqual(modules(log).map(sha), [
    'b68de0e316cec876773e0cf7d44c18f2b05cd57d478dfb0c2144a9d4dded074e',
    'c725bd91a27d3c0e22235fd9587c3f0055c9ba8c27f8e53f9c819d1bdfd3734e',
  ]);
  assert.deepEqual(flag(log), [0], 'jitter.w stays 0');
  assert.equal(log.filter((e) => e[0] === 'beginRenderPass').length, 1, 'only the composite pass');
});

test('add(model): drawn after the composite, over the frame with depth read only, fogged', () => {
  const { fog, record, frame } = rig({ temporal: 0 }),
    m = model();
  const remove = fog.add(m);
  assert.equal(fog.add(m), remove, 'adding twice returns the same remover');
  assert.equal(m.hook, fog);
  const declarations = fog.declarations(2);
  assert.match(declarations, /@group\(2\) @binding\(120\) var<uniform> margoFog:MargoFog;/);
  assert.match(declarations, /fn margoTransparent\(color:vec4f,i:Out\)->MargoTransparent/);
  assert.match(declarations, /o\.color=vec4f\(color\.rgb\*\(1\.0-opacity\)\+light,color\.a\)/);
  assert.equal(fog.declarations(2), declarations, 'the same string every frame');
  assert.doesNotMatch(fog.surface(1), /fn margoTransparent\(/, 'effects get no PBR layer');
  const log = record(() => frame(0));
  assert.equal(m.draws, 1);
  const begins = log.filter((e) => e[0] === 'beginRenderPass');
  assert.equal(begins.length, 2, 'composite, then the transparent pass');
  const over = begins[1][1];
  assert.equal(over.colorAttachments[0].loadOp, 'load');
  assert.equal(over.depthStencilAttachment.depthReadOnly, true);
  assert.deepEqual(flag(log), [1], 'jitter.w 1: the fog applies');
  assert.deepEqual(
    fog.bindings().map((e) => e.binding),
    [120, 121, 122],
  );
  assert.equal(fog.bindings(), fog.bindings(), 'entries kept until the volume changes');
  assert.deepEqual(fog.targets, [{ format: 'rgba16float', blend: fog.targets[0].blend }]);
  assert.equal(fog.targets[0].blend.color.srcFactor, 'src-alpha');
  remove();
  assert.equal(m.hook, undefined, 'the remover gives the draw back');
  record(() => frame(1));
  assert.equal(m.draws, 1);
});

test('a frame the fog skips still draws the transparents, unfogged', () => {
  const { fog, record, frame } = rig({ temporal: 0 }),
    m = model(),
    e = effect();
  fog.add(m);
  fog.add(e);
  fog.options.enabled = false;
  const log = record(() => frame(0));
  assert.equal(m.draws + e.draws, 2);
  assert.deepEqual(flag(log), [0], 'jitter.w 0: colours pass through');
  assert.equal(log.filter((x) => x[0] === 'beginRenderPass').length, 1, 'no composite, one transparent pass');
  assert.ok(
    log.some((x) => x[0] === 'texture' && x[2].dimension === '3d'),
    'a volume to bind',
  );
});

test('effects, validation and dispose', () => {
  const { fog } = rig(),
    e = effect(),
    m = model();
  fog.add(e);
  assert.equal(e.hook, fog);
  e.released();
  fog.add(e);
  fog.add(m);
  for (const bad of [null, {}, { setTransparency() {} }]) assert.throws(() => fog.add(bad), TypeError);
  assert.equal(fog.layout.length, 3);
  fog.dispose();
  assert.equal(e.hook, undefined);
  assert.equal(m.hook, undefined);
  assert.throws(() => fog.add(model()), { code: 'disposed' });
  assert.throws(() => new VolumetricFog().add(model()), { code: 'state' });
});
