import test from 'node:test';
import assert from 'node:assert/strict';
import {mockGPU, context} from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import {FrameGraph} from '../../core/dist/extension.js';
import {wgsl} from '../../core/dist/shaders.js';
import {PostStack, Bloom, SSAO, FXAA} from '../dist/index.js';
import {DOF} from '../../dof/dist/index.js';
import {Tonemap} from '../../tonemap/dist/index.js';
import {PostProcessing} from '../../creative/dist/post.js';

/** Engine stand-in over the recording mock GPU: real frame graph, plugin map, and every GPU resource kept for leak checks. */
function harness(samples = 4) {
  const gpu = mockGPU(), graph = new FrameGraph(), plugins = new Map(), resources = []; let host = false;
  for (const kind of ['createTexture', 'createBuffer']) {const create = gpu.device[kind]; gpu.device[kind] = descriptor => {const r = create(descriptor); if (!host) resources.push(r); return r;};}
  const engine = {gpu: gpu.device, frameGraph: graph, hasPlugin: name => plugins.has(name),
    use(plugin) {
      if (plugins.has(plugin.name)) throw new TypeError('Invalid plugin');
      try {graph.withOwner(plugin.name, () => {plugin.setup(engine); plugin.registerPasses?.(graph);}); plugins.set(plugin.name, plugin);}
      catch (error) {graph.removeOwner(plugin.name); plugin.dispose?.(); throw error;}
      return engine;
    },
    removePlugin(name) {const plugin = plugins.get(name); if (plugin) {graph.removeOwner(name); plugins.delete(name); plugin.dispose?.();}},
    restore() {for (const plugin of [...plugins.values()]) plugin.onDeviceRestored?.(engine);}};
  const view = context(gpu, {samples, shader: wgsl, format: 'bgra8unorm'}); let index = 0;
  // The frame's own color and depth targets belong to the host, not to an effect.
  const frame = () => {host = true; view.begin(index++); host = false; const before = {color: view.c.color, depth: view.c.depth, format: view.c.format, descriptor: view.c.descriptor}; graph.execute(view.c); return before;};
  return {gpu, engine, view, resources, plugins, frame, live: () => resources.filter(r => !r.destroyed)};
}
const restored = (h, before) => {for (const key of ['color', 'depth', 'format', 'descriptor']) assert.equal(h.view.c[key], before[key], key + ' not restored');};
/** A stackable test double that logs what the stack hands it. */
function fake(name, kind, log, own) {
  return {name, setup() {}, registerPasses() {}, dispose() {this.disposed = true;},
    joinStack(host) {this.host = host; return {kind, render: (c, input, output) => {log.push({name, input, view: output.view, hdr: output.hdr, format: output.format, count: output.multisample.count, shader: c.shader}); return own;}};}};
}

test('PostStack runs effects in array order with one capture, ping-pong targets and the display output last', () => {
  const h = harness(4), log = [], own = {own: true};
  h.engine.use(new PostStack([fake('a', 'hdr', log), fake('b', 'hdr', log, own), fake('c', 'hdr', log), fake('d', 'display', log), fake('e', 'ldr', log), fake('f', 'ldr', log)]));
  const before = h.frame(); restored(h, before);
  assert.deepEqual(log.map(entry => entry.name), ['a', 'b', 'c', 'd', 'e', 'f']);
  for (let i = 1; i < log.length; i++) {
    assert.equal(log[i].input, log[i - 1].name === 'b' ? own : log[i - 1].view, 'each stage reads the previous output');
    assert.notEqual(log[i].view, log[i].input, 'no stage writes the texture it reads');
  }
  assert.deepEqual(log.map(entry => entry.hdr), [true, true, true, false, false, false]);
  assert.deepEqual(log.map(entry => entry.format), ['rgba16float', 'rgba16float', 'rgba16float', 'bgra8unorm', 'bgra8unorm', 'bgra8unorm']);
  assert.deepEqual(log.map(entry => entry.count), [1, 1, 1, 1, 1, 4]);
  assert.equal(log.at(-1).view, before.color, 'last effect writes the frame target');
  assert.ok(!log[0].shader.includes('let mapped=linear/'), 'HDR members get the linear scene shader');
  // A disposed member drops out; the last HDR effect becomes the display output when no display effect is live.
  log.length = 0; h.engine.removePlugin('d'); h.engine.removePlugin('e'); h.engine.removePlugin('f'); h.frame();
  assert.deepEqual(log.map(entry => [entry.name, entry.hdr]), [['a', true], ['b', true], ['c', false]]); assert.equal(log.at(-1).view, before.color);
});

test('PostStack validates its order and keeps an LDR-only stack on the core shader', () => {
  const log = [];
  for (const kinds of [['display', 'hdr'], ['ldr', 'hdr'], ['ldr', 'display'], ['display', 'display']]) assert.throws(() => new PostStack(kinds.map((kind, i) => fake('x' + i, kind, log))), /order/);
  assert.throws(() => new PostStack([]), /distinct/); assert.throws(() => new PostStack([fake('x', 'hdr', log), fake('x', 'hdr', log)]), /distinct/);
  assert.throws(() => new PostStack([{name: 'plain', setup() {}}]), /cannot join/);
  const effect = new Bloom(); new PostStack([effect]); assert.throws(() => new PostStack([effect]), /already attached/);
  const h = harness(1); h.engine.use(new PostStack([fake('aa', 'ldr', log)])); const before = h.frame();
  assert.equal(log[0].shader, wgsl); assert.equal(log[0].view, before.color); assert.equal(log[0].count, 1);
});

test('SSAO + DOF + Bloom + Tonemap + FXAA combine, resize, restore and dispose without leaks', () => {
  for (const samples of [1, 4]) {
    const h = harness(samples), effects = [new SSAO(), new DOF({aperture: 2}), new Bloom(), new Tonemap({curve: 'agx'}), new FXAA()];
    const stack = PostStack.attach(h.engine, effects); assert.equal(stack.name, 'post:stack');
    for (const name of ['ssao', 'dof', 'bloom', 'tonemap', 'fxaa']) assert.ok(h.engine.hasPlugin(name));
    restored(h, h.frame());
    assert.equal(effects[0].depthTexture, stack.depthTexture); assert.equal(effects[1].depthTexture, stack.depthTexture);
    // Steady frames allocate nothing on the GPU.
    const count = h.resources.length, calls = h.gpu.record(() => restored(h, h.frame()));
    assert.equal(h.resources.length, count);
    assert.ok(!calls.some(([name]) => /^(buffer|texture|view|module|group|renderPipeline|computePipeline|sampler|getBindGroupLayout)$/.test(name)), 'steady frame created GPU objects');
    // One capture: a single resolve-to-final of the shared MSAA target at 4x, and exactly one draw of the scene.
    assert.equal(calls.filter(([name, value]) => name === 'draw' && value?.pipeline === undefined).length, 1);
    const passes = calls.filter(([name]) => name === 'beginRenderPass').map(([, descriptor]) => descriptor);
    assert.equal(passes.at(-1).colorAttachments[0].view, h.gpu.snap(h.view.c.color), 'FXAA presents last');
    const depth = stack.depthTexture; h.view.state.width = 320; restored(h, h.frame()); assert.ok(depth.destroyed); assert.equal(stack.depthTexture.width, 320);
    h.engine.restore(); restored(h, h.frame()); restored(h, h.frame());
    stack.dispose(); assert.equal(h.plugins.size, 0); assert.deepEqual(h.live(), [], 'GPU textures leaked');
  }
});

test('combinations that rejected each other alone now share one capture', () => {
  for (const make of [() => [new SSAO(), new Bloom()], () => [new Bloom(), new Tonemap()], () => [new SSAO(), new DOF()], () => [new DOF(), new Bloom(), new PostProcessing()],
    () => [new SSAO(), new Bloom(), new PostProcessing({atmosphere: {density: 0.02, godRays: 0.5}}), new FXAA()], () => [new DOF(), new Tonemap()]]) {
    const h = harness(4), effects = make(), stack = PostStack.attach(h.engine, effects);
    for (let i = 0; i < 3; i++) restored(h, h.frame());
    stack.dispose(); assert.deepEqual(h.live(), [], effects.map(e => e.name).join('+') + ' leaked');
  }
});

test('PostStack refuses standalone capture owners and they refuse a live stack', () => {
  const h = harness(4); Bloom.attach(h.engine);
  assert.throws(() => PostStack.attach(h.engine, [new SSAO()]), /instead of attaching it alone/);
  assert.equal(h.engine.hasPlugin('ssao'), false); assert.equal(h.engine.hasPlugin('post:stack'), false);
  const g = harness(4); PostStack.attach(g.engine, [new Bloom()]); assert.throws(() => SSAO.attach(g.engine), /output target/);
  // A member failing setup unwinds the members already attached.
  const f = harness(4), broken = fake('broken', 'hdr', []); broken.setup = () => {throw new Error('boom');};
  assert.throws(() => PostStack.attach(f.engine, [new SSAO(), broken]), /boom/); assert.equal(f.plugins.size, 0);
});

test('FXAA alone wraps the finished frame, nests around another effect and restores and disposes cleanly', () => {
  for (const samples of [1, 4]) {
    const h = harness(samples), fxaa = FXAA.attach(h.engine), calls = h.gpu.record(() => restored(h, h.frame()));
    const passes = calls.filter(([name]) => name === 'beginRenderPass').map(([, descriptor]) => descriptor);
    assert.equal(passes.at(-1).colorAttachments[0].view, h.gpu.snap(h.view.c.color));
    assert.equal(h.view.c.shader, wgsl, 'FXAA keeps the core shader');
    const bloom = Bloom.attach(h.engine); for (let i = 0; i < 2; i++) restored(h, h.frame());
    h.engine.restore(); restored(h, h.frame()); bloom.dispose(); fxaa.dispose(); fxaa.dispose(); assert.deepEqual(h.live(), []);
  }
});
