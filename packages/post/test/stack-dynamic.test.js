// PostStack.addEffect, removeEffect, moveEffect and PostStack.join (GAP-POST-ADD1): the list changes after setup with
// no stack-wide rebuild. Pipeline and texture creations are counted on the recording mock GPU, so the cost is a
// deterministic work count, never a timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { FrameGraph } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { PostStack, Bloom, SSAO, FXAA, SMAA } from '../dist/index.js';
import { Tonemap } from '../../tonemap/dist/index.js';

/** Engine stand-in over the recording mock GPU: real frame graph and plugin map, as in stack.test.js. */
function harness(samples = 4) {
  const gpu = mockGPU(),
    graph = new FrameGraph(),
    plugins = new Map(),
    resources = [];
  let host = false;
  const create = gpu.device.createTexture;
  gpu.device.createTexture = (descriptor) => {
    const r = create(descriptor);
    if (!host) resources.push(r);
    return r;
  };
  const engine = {
    coreRequirement: undefined,
    gpu: gpu.device,
    frameGraph: graph,
    plugins,
    hasPlugin: (name) => plugins.has(name),
    sceneOf: (plugin) => (plugins.get(plugin.name) === plugin ? engine : undefined),
    use(plugin) {
      if (plugins.has(plugin.name)) throw new TypeError('Invalid plugin');
      graph.withOwner(plugin.name, () => {
        plugins.set(plugin.name, plugin);
        try {
          plugin.setup(engine);
          plugin.registerPasses?.(graph);
        } catch (error) {
          graph.removeOwner(plugin.name);
          plugins.delete(plugin.name);
          plugin.dispose?.();
          throw error;
        }
      });
      return engine;
    },
    removePlugin(name) {
      const plugin = plugins.get(name);
      if (plugin) {
        graph.removeOwner(name);
        plugins.delete(name);
        plugin.dispose?.();
      }
    },
    restore() {
      for (const plugin of [...plugins.values()]) plugin.onDeviceRestored?.(engine);
    },
  };
  const view = context(gpu, { samples, shader: wgsl, format: 'bgra8unorm' });
  let index = 0;
  const frame = () => {
    host = true;
    view.begin(index++);
    host = false;
    graph.execute(view.c);
  };
  return { gpu, engine, plugins, frame, live: () => resources.filter((r) => !r.destroyed) };
}
/** A stackable test double that logs the order it draws in; `during` runs inside its render (the compose pass). */
function fake(name, kind, log = [], during) {
  return {
    name,
    setup() {},
    dispose() {
      this.disposed = (this.disposed ?? 0) + 1;
    },
    joinStack(host) {
      if (this.host) throw Object.assign(new Error('already'), { name: 'MargoError', code: 'attached' });
      this.host = host;
      return {
        kind,
        render: (c, input, output) => {
          log.push([name, output.hdr]);
          during?.();
        },
      };
    },
  };
}
const names = (stack) => stack.effects.map((e) => e.name);
const pipelines = (calls) => calls.filter(([name]) => name === 'renderPipeline' || name === 'computePipeline').length;
const textures = (calls) => calls.filter(([name]) => name === 'texture').length;

test('addEffect places an effect after the last of its kind, or at an index that keeps the order', () => {
  const stack = new PostStack([fake('a', 'hdr'), fake('t', 'display'), fake('x', 'ldr')]);
  stack.addEffect(fake('b', 'hdr'));
  stack.addEffect(fake('y', 'ldr'));
  assert.deepEqual(names(stack), ['a', 'b', 't', 'x', 'y']);
  assert.equal(stack.addEffect(fake('c', 'hdr'), 0), stack, 'returns the stack');
  stack.addEffect(fake('z', 'ldr'), 4);
  assert.deepEqual(names(stack), ['c', 'a', 'b', 't', 'z', 'x', 'y']);
  assert.ok(Object.isFrozen(stack.effects), 'a read-only copy');
  const before = stack.effects;
  for (const [effect, index, error] of [
    [fake('d', 'display'), undefined, RangeError],
    [fake('e', 'ldr'), 0, RangeError],
    [fake('f', 'hdr'), 7, RangeError],
    [fake('g', 'hdr'), 99, RangeError],
    [fake('h', 'hdr'), -1, RangeError],
    [fake('i', 'hdr'), 1.5, RangeError],
    [fake('a', 'hdr'), undefined, TypeError],
    [{ name: 'plain', setup() {} }, undefined, TypeError],
  ])
    assert.throws(() => stack.addEffect(effect, index), error);
  assert.equal(stack.effects, before, 'a refused call changes nothing');
  const bloom = new Bloom();
  new PostStack([bloom]);
  assert.throws(() => stack.addEffect(bloom), { code: 'attached' });
  const aa = new PostStack([new FXAA()]);
  assert.throws(() => aa.addEffect(new SMAA()), /SMAA or FXAA/);
  // An effect refused for its place has joined this stack and may be added here again.
  const late = fake('late', 'hdr');
  assert.throws(() => stack.addEffect(late, 6), RangeError);
  stack.addEffect(late);
  assert.equal(names(stack)[3], 'late');
});

test('an empty stack passes frames through and fills up later', () => {
  const h = harness(),
    log = [],
    stack = PostStack.attach(h.engine);
  assert.deepEqual(stack.effects, []);
  const calls = h.gpu.record(() => h.frame());
  assert.equal(calls.filter(([name]) => name === 'beginRenderPass').length, 0, 'no pass of its own');
  assert.equal(h.live().length, 0);
  stack.addEffect(fake('x', 'ldr', log));
  h.frame();
  assert.deepEqual(log, [['x', false]]);
  assert.ok(h.plugins.has('x'));
  stack.dispose();
  assert.equal(h.plugins.size, 0);
});

test('add, move and remove on an attached stack draw in the new order from the next frame', async () => {
  const h = harness(),
    log = [],
    a = fake('a', 'hdr', log),
    b = fake('b', 'hdr', log),
    t = fake('t', 'display', log),
    stack = PostStack.attach(h.engine, [a, t]);
  h.frame();
  stack.addEffect(b);
  assert.equal(h.plugins.get('b'), b, 'attached at once');
  log.length = 0;
  h.frame();
  assert.deepEqual(log, [['a', true], ['b', true], ['t', false]]);
  assert.equal(stack.moveEffect(b, 0), stack);
  assert.equal(b.disposed, undefined, 'a move keeps the instance');
  log.length = 0;
  h.frame();
  assert.deepEqual(log, [['b', true], ['a', true], ['t', false]]);
  assert.throws(() => stack.moveEffect(t, 0), RangeError);
  assert.throws(() => stack.moveEffect(b, 3), RangeError);
  assert.throws(() => stack.moveEffect(fake('q', 'hdr'), 0), TypeError);
  assert.deepEqual(names(stack), ['b', 'a', 't']);
  assert.equal(stack.removeEffect(t), true);
  assert.equal(t.disposed, 1, 'removed and disposed, as removePlugin does');
  assert.equal(h.plugins.has('t'), false);
  assert.equal(stack.removeEffect(t), false);
  log.length = 0;
  h.frame();
  assert.deepEqual(log, [['b', true], ['a', false]], 'the last HDR effect tonemaps again');
  h.engine.restore();
  h.frame();
  stack.removeEffect(a);
  stack.removeEffect(b);
  assert.equal(h.plugins.get('post:stack'), stack, 'a stack the caller made stays when empty');
  h.frame();
  stack.dispose();
  await null;
  assert.deepEqual(h.live(), []);
});

test('changes during a frame throw state and leave the stack as it was', () => {
  const h = harness(),
    stack = PostStack.attach(h.engine),
    errors = [],
    other = fake('other', 'hdr'),
    probe = fake('probe', 'ldr', [], () => {
      for (const change of [
        () => stack.addEffect(fake('new', 'ldr')),
        () => stack.moveEffect(other, 0),
        () => stack.removeEffect(other),
      ])
        try {
          change();
        } catch (error) {
          errors.push(error.code);
        }
    });
  stack.addEffect(other).addEffect(probe);
  h.frame();
  assert.deepEqual(errors, ['state', 'state', 'state']);
  assert.deepEqual(names(stack), ['other', 'probe']);
  assert.equal(other.disposed, undefined);
  stack.dispose();
});

test('a refused attach or tier leaves the list unchanged', () => {
  const h = harness(),
    stack = PostStack.attach(h.engine, [fake('x', 'ldr')]),
    broken = fake('broken', 'hdr');
  broken.setup = () => {
    throw new Error('boom');
  };
  assert.throws(() => stack.addEffect(broken), /boom/);
  assert.deepEqual(names(stack), ['x']);
  assert.equal(h.plugins.has('broken'), false);
  h.engine.gpu.adapter = { capabilities: { tier: 'ldr' } };
  assert.throws(() => stack.addEffect(fake('hdr', 'hdr')), { code: 'unsupported' });
  stack.addEffect(fake('y', 'ldr'));
  assert.deepEqual(names(stack), ['x', 'y']);
  stack.dispose();
  assert.throws(() => stack.addEffect(fake('z', 'ldr')), { code: 'disposed' });
  assert.equal(stack.removeEffect(stack.effects[0]), false);
});

test('PostStack.join adds to the scene stack or makes one that goes with its last effect', () => {
  const h = harness(),
    a = fake('a', 'ldr'),
    b = fake('b', 'hdr');
  const own = PostStack.join(h.engine, a);
  assert.equal(h.plugins.get('post:stack'), own);
  assert.equal(PostStack.join(h.engine, b), own, 'reuses the scene stack');
  assert.deepEqual(names(own), ['b', 'a']);
  own.removeEffect(a);
  assert.equal(h.plugins.get('post:stack'), own);
  own.removeEffect(b);
  assert.equal(h.plugins.has('post:stack'), false, 'a stack join made goes with its last effect');
  const mine = PostStack.attach(h.engine, [fake('c', 'ldr')]);
  PostStack.join(h.engine, fake('d', 'ldr'), 0);
  assert.deepEqual(names(mine), ['d', 'c']);
  mine.removeEffect(mine.effects[0]);
  mine.removeEffect(mine.effects[0]);
  assert.equal(h.plugins.get('post:stack'), mine, 'a stack the caller made stays');
  mine.dispose();
  h.plugins.set('post:stack', { name: 'post:stack', setup() {} });
  assert.throws(() => PostStack.join(h.engine, fake('e', 'ldr')), TypeError);
});

test('work count: adding compiles only the new effect, and moving or removing compiles nothing else', async (t) => {
  // What the same list costs when constructed: the difference is Bloom's own pipelines and nothing more.
  const built = (make) => {
    const h = harness(),
      calls = h.gpu.record(() => {
        PostStack.attach(h.engine, make());
        h.frame();
      });
    return { pipelines: pipelines(calls), textures: textures(calls) };
  };
  const without = built(() => [new SSAO(), new Tonemap(), new FXAA()]),
    withBloom = built(() => [new SSAO(), new Bloom(), new Tonemap(), new FXAA()]);
  const h = harness(),
    ssao = new SSAO(),
    stack = PostStack.attach(h.engine, [ssao, new Tonemap(), new FXAA()]);
  h.frame();
  h.frame();
  const bloom = new Bloom();
  const add = h.gpu.record(() => {
    stack.addEffect(bloom);
    h.frame();
  });
  assert.deepEqual(names(stack), ['ssao', 'bloom', 'tonemap', 'fxaa'], 'after the last HDR effect');
  t.diagnostic(
    `construct 3 effects: ${without.pipelines} pipelines, ${without.textures} textures; 4 effects: ${withBloom.pipelines}, ` +
      `${withBloom.textures}; addEffect(Bloom) + 1 frame: ${pipelines(add)}, ${textures(add)}`,
  );
  assert.equal(pipelines(add), withBloom.pipelines - without.pipelines, 'only Bloom compiles');
  assert.equal(textures(add), withBloom.textures - without.textures, 'only Bloom allocates; the capture stays');
  const move = h.gpu.record(() => {
    stack.moveEffect(bloom, 0);
    h.frame();
  });
  assert.equal(pipelines(move), 0, 'both HDR effects keep their output');
  assert.equal(textures(move), 0);
  const remove = h.gpu.record(() => {
    stack.removeEffect(bloom);
    h.frame();
  });
  assert.equal(pipelines(remove), 0);
  assert.equal(textures(remove), 0);
  assert.ok(h.gpu.record(() => h.frame()).every(([name]) => name !== 'renderPipeline' && name !== 'texture'));
  stack.dispose();
  // Removing the display effect makes Bloom the last HDR effect, which now tonemaps: only Bloom's output may compile,
  // never more than Bloom costs alone.
  const alone = built(() => [new Bloom()]),
    g = harness(),
    tonemap = new Tonemap(),
    last = PostStack.attach(g.engine, [new SSAO(), new Bloom(), tonemap]);
  g.frame();
  const output = g.gpu.record(() => {
    last.removeEffect(tonemap);
    g.frame();
  });
  t.diagnostic(`Bloom alone: ${alone.pipelines} pipelines; removing Tonemap after Bloom: ${pipelines(output)}, ${textures(output)}`);
  assert.ok(pipelines(output) <= alone.pipelines);
  last.dispose();
  await null;
  assert.deepEqual(h.live(), []);
});

test('add then remove 50 times leaves no live GPU object behind', async () => {
  const h = harness(),
    stack = PostStack.attach(h.engine, [new Tonemap()]);
  h.frame();
  const base = h.live().length;
  for (let i = 0; i < 50; i++) {
    const bloom = new Bloom();
    stack.addEffect(bloom);
    h.frame();
    stack.removeEffect(bloom);
    h.frame();
  }
  await null;
  assert.equal(h.live().length, base);
  stack.dispose();
  await null;
  assert.deepEqual(h.live(), []);
});
