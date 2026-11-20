// KB-RESTORE-BORROWED1: a Shadertoy texture channel holds a caller's GPU object (docs/conventions.md, "Borrowed GPU
// objects"). A plain texture belongs to the device that made it: after a device restore the channel reads opaque black
// (as an unbound one), `engine.onError` hears of it once under the channel's name, and `toy.setChannel` gives it a new
// texture; a `(device) => texture` channel is made once per device and comes back by itself. A steady frame binds the
// same views, samplers and bind group (no per-frame allocation from the blank of an unbound channel).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { FrameGraph } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { Shadertoy } from '../dist/shadertoy.js';

const reads = 'void mainImage(out vec4 f, in vec2 c) { f = texture(iChannel0, c / iResolution.xy) + vec4(iChannelResolution[0], 0.0); }';

/** A mock engine with the real FrameGraph; `swap()` moves it to a fresh mock device (device restoration). */
function harness() {
  const graph = new FrameGraph(),
    plugins = new Map(),
    h = { graph, plugins, index: 0, errors: [] };
  const view = () => context(h.gpu, { samples: 1, shader: wgsl, format: 'rgba8unorm', depthFormat: 'depth24plus-stencil8' });
  h.gpu = mockGPU();
  h.engine = {
    gpu: h.gpu.device,
    frameGraph: graph,
    disposed: false,
    onError: (e) => h.errors.push(e),
    sceneOf: (plugin) => (plugins.get(plugin.name) === plugin ? h.engine : undefined),
    use(plugin) {
      graph.withOwner(plugin.name, () => {
        plugin.setup(h.engine);
        plugin.registerPasses?.(graph);
      });
      plugins.set(plugin.name, plugin);
      return h.engine;
    },
    removePlugin(name) {
      const plugin = plugins.get(name);
      if (plugin) {
        graph.removeOwner(name);
        plugins.delete(name);
        plugin.dispose?.();
      }
    },
  };
  h.view = view();
  h.frame = () => {
    for (const plugin of plugins.values()) plugin.onPreUpdate?.(1 / 60);
    h.view.begin(h.index++);
    graph.execute(h.view.c);
  };
  h.swap = () => {
    h.gpu = mockGPU();
    h.engine.gpu = h.gpu.device;
    h.view = view();
    for (const plugin of plugins.values()) plugin.onDeviceRestored?.(h.engine);
  };
  h.lost = () => h.errors.filter((e) => /borrowed-lost/.test(e.message));
  return h;
}
// A texture of `device` that records each view made of it under `name`.
const watched = (viewed, device, name, size = [4, 4], extra = {}) => {
  const t = device.createTexture({ size, format: 'rgba8unorm', usage: 4, ...extra }),
    createView = t.createView;
  t.createView = (d) => (viewed.push([name, d?.dimension]), createView(d));
  return t;
};
const calls = (log, name) => log.filter((c) => c[0] === name).length;

test('a plain texture channel across a device restore: dropped and reported once by name, setChannel brings one back', async () => {
  const h = harness(),
    viewed = [],
    toy = new Shadertoy({ image: { source: reads, iChannel0: watched(viewed, h.gpu.device, 'plain') } });
  h.engine.use(toy);
  void toy.texture;
  const material = toy.material(),
    resolution = () => material.uniforms.iChannelResolution.value.slice(0, 3);
  h.frame();
  await toy.ready();
  h.frame();
  assert.deepEqual(viewed, [['plain', '2d']]);
  assert.deepEqual(resolution(), [4, 4, 1]);
  // A steady frame makes no view, sampler or bind group (the blanks of the three unbound channels made both each frame).
  let log = h.gpu.record(() => h.frame());
  assert.deepEqual([calls(log, 'view'), calls(log, 'sampler'), calls(log, 'group')], [0, 0, 0], 'nothing made on a steady frame');
  h.swap();
  log = h.gpu.record(() => h.frame());
  assert.deepEqual(viewed, [['plain', '2d']], 'nothing of the lost texture is bound on the new device');
  assert.equal(h.lost().length, 1, 'one report');
  assert.equal(h.lost()[0].code, 'state');
  assert.match(h.lost()[0].message, /Shadertoy iChannel0 lost with the device; pass a function or call toy\.setChannel\(0, texture\)/);
  assert.deepEqual(resolution(), [0, 0, 0], 'an unbound channel has no size');
  h.frame();
  assert.equal(h.lost().length, 1, 'reported once');
  // A new texture through the setter.
  toy.setChannel(0, watched(viewed, h.gpu.device, 'again', [8, 2]));
  h.frame();
  assert.deepEqual(viewed.at(-1), ['again', '2d']);
  assert.deepEqual(resolution(), [8, 2, 1]);
  assert.equal(h.lost().length, 1);
  toy.dispose();
});

test('a function texture channel is made once per device with no report; its size is the made texture\'s', async () => {
  const h = harness(),
    viewed = [],
    made = [],
    toy = new Shadertoy({ image: { source: reads, iChannel0: (device) => (made.push(device), watched(viewed, device, 'made' + made.length, [16, 8])) } });
  h.engine.use(toy);
  void toy.texture;
  const material = toy.material();
  h.frame();
  await toy.ready();
  h.frame();
  h.frame();
  assert.equal(made.length, 1, 'made once per device');
  assert.deepEqual(material.uniforms.iChannelResolution.value.slice(0, 3), [16, 8, 1], 'iChannelResolution of the made texture');
  h.swap();
  h.frame();
  h.frame();
  assert.equal(made.length, 2);
  assert.equal(made[1], h.gpu.device, 'called with the new device');
  assert.deepEqual(viewed, [['made1', '2d'], ['made2', '2d']]);
  assert.equal(h.lost().length, 0, 'no report');
  toy.dispose();
});

test('3D and cube texture channels: the view of their sampler type, a function of the wrong kind reported once', async () => {
  const h = harness(),
    viewed = [],
    toy = new Shadertoy({
      image: {
        source: 'void mainImage(out vec4 f, in vec2 c) { f = texture(iChannel0, vec3(c, 0.5)) + texture(iChannel1, vec3(c, 1.0)) + vec4(iChannelResolution[0], 0.0); }',
        iChannel0: { texture: (device) => watched(viewed, device, 'volume', [4, 4, 2], { dimension: '3d' }), type: '3d' },
        iChannel1: { texture: (device) => watched(viewed, device, 'cube', [2, 2, 6]), type: 'cube' },
      },
    });
  assert.throws(() => new Shadertoy({ image: { source: reads, iChannel0: { texture: h.gpu.device.createTexture({ size: [2, 2, 12], format: 'rgba8unorm', usage: 4 }), type: 'cube' } } }), /iChannel0 is a samplerCube channel; give it a 2D texture of six layers/);
  h.engine.use(toy);
  void toy.texture;
  const material = toy.material();
  h.frame();
  await toy.ready();
  h.frame();
  assert.deepEqual(viewed, [['volume', '3d'], ['cube', 'cube']]);
  assert.equal(h.errors.length, 0);
  // A function with no type is a sampler2D channel, so the 3D texture it makes does not fit.
  const flat = new Shadertoy({ image: { source: reads, iChannel0: (device) => watched(viewed, device, 'deep', [4, 4, 4], { dimension: '3d' }) } });
  h.engine.use(flat);
  void flat.texture;
  h.frame();
  await flat.ready();
  h.frame();
  h.frame();
  assert.equal(h.errors.length, 1, 'reported once');
  assert.equal(h.errors[0].code, 'failed');
  assert.match(h.errors[0].message, /Shadertoy iChannel0 is a sampler2D channel; give it a 2D texture/);
  assert.ok(!viewed.some(([name]) => name === 'deep'), 'nothing of it is bound');
  assert.deepEqual(material.uniforms.iChannelResolution.value.slice(0, 3), [4, 4, 2], 'a 3D channel counts its depth');
  toy.dispose();
  flat.dispose();
});

test('toy.setChannel takes what each kind of channel reads and refuses the rest', () => {
  const plainTexture = { width: 2, height: 2, depthOrArrayLayers: 1, dimension: '2d', createView() {} },
    image = { width: 3, height: 5 },
    toy = new Shadertoy({
      image: { source: 'void mainImage(out vec4 f, in vec2 c) { f = vec4(0.0); }', iChannel0: plainTexture, iChannel1: 'A', iChannel2: image, iChannel3: 'keyboard' },
      bufferA: { source: 'void mainImage(out vec4 f, in vec2 c) { f = vec4(1.0); }', iChannel0: null },
      keyboard: new EventTarget(),
    });
  toy.setChannel(0, (device) => device.createTexture({}));
  toy.setChannel(0, null);
  toy.setChannel(0, { bind: () => undefined });
  toy.setChannel(0, plainTexture, 'image');
  toy.setChannel(0, plainTexture, 'bufferA');
  toy.setChannel(2, { width: 7, height: 1 });
  assert.throws(() => toy.setChannel(0, { width: 2, height: 2, depthOrArrayLayers: 2, dimension: '3d', createView() {} }), /iChannel0 is a sampler2D channel; give it a 2D texture/);
  assert.throws(() => toy.setChannel(1, plainTexture), /iChannel1 reads Buffer A, which the toy draws itself; make a new Shadertoy/);
  assert.throws(() => toy.setChannel(3, plainTexture), /iChannel3 reads the keyboard, which the toy draws itself/);
  assert.throws(() => toy.setChannel(2, plainTexture), /iChannel2 reads a video or image; setChannel gives it a video or image/);
  assert.throws(() => toy.setChannel(0, image), /iChannel0 reads a texture; setChannel gives it a texture, a function or null/);
  assert.throws(() => toy.setChannel(0, plainTexture, 'cubeA'), /Shadertoy has no cubeA tab/);
  assert.throws(() => toy.setChannel(4, plainTexture), RangeError);
  toy.dispose();
  assert.throws(() => toy.setChannel(0, null), /disposed/);
});
