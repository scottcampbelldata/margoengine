// Screen-space effects inside one view of a multi-view canvas: their material targets clear inside the view rectangle
// only, SSGI's prefilter still covers whole mips, and SSAO ends its geometry pass when a source throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { FrameGraph } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { PostStack, SSR, SSGI, SSAO } from '../dist/index.js';

const rect = [8, 12, 80, 56];
function inView(effect, rects = [rect]) {
  const gpu = mockGPU(),
    graph = new FrameGraph(),
    plugins = new Map(),
    engine = {
      gpu: gpu.device,
      frameGraph: graph,
      hasPlugin: (name) => plugins.has(name),
      sceneOf: (plugin) => (plugins.get(plugin.name) === plugin ? engine : undefined),
      use(plugin) {
        plugins.set(plugin.name, plugin);
        graph.withOwner(plugin.name, () => {
          plugin.setup(engine);
          plugin.registerPasses?.(graph);
        });
        plugins.set(plugin.name, plugin);
        return engine;
      },
      removePlugin(name) {
        graph.removeOwner(name);
        plugins.delete(name);
      },
    },
    view = context(gpu, { samples: 1, shader: wgsl, format: 'bgra8unorm' }),
    draws = [];
  let error;
  engine.use(new PostStack([effect]));
  const log = gpu.record(() => {
    // Every view of one frame, each from its own camera (begin(n) moves it).
    rects.forEach((viewport, index) => {
      view.begin(index);
      view.c.draw = (options) => draws.push(options);
      view.c.view = { id: 'view' + index, camera: view.camera, viewport, index, count: rects.length };
      try {
        graph.execute(view.c);
      } catch (cause) {
        error = cause;
      }
    });
  });
  // The log split into render passes: each starts at beginRenderPass.
  const passes = [];
  for (const event of log)
    if (event[0] === 'beginRenderPass') passes.push([event]);
    else passes.at(-1)?.push(event);
  return { log, passes, draws, error };
}
const viewport = (pass) => pass.find((e) => e[0] === 'pass.setViewport')?.slice(1, 5);

for (const [name, Effect] of [
  ['SSR', SSR],
  ['SSGI', SSGI],
])
  test(`${name} clears its material targets inside the view rectangle only`, () => {
    const { passes, draws } = inView(new Effect()),
      clear = passes.find(
        (pass) =>
          pass[0][1].colorAttachments.length > 1 &&
          pass.some((e) => e[0] === 'pass.setViewport') &&
          pass.some((e) => e[0] === 'pass.draw'),
      );
    assert.ok(clear, 'a clear quad covers the material targets');
    assert.ok(clear[0][1].colorAttachments.length > 1, 'every MRT target is cleared');
    assert.ok(
      clear[0][1].colorAttachments.every((a) => a.loadOp === 'load'),
      'no whole-attachment clear',
    );
    assert.deepEqual(viewport(clear), rect);
    assert.equal(draws.at(-1).clear, false, 'the material replay clears nothing itself');
  });

test('SSGI prefilters whole mips but traces and composites inside the view', () => {
  const { passes } = inView(new SSGI()),
    fullscreen = passes.filter((pass) => pass.some((e) => e[0] === 'pass.draw'));
  assert.ok(
    fullscreen.some((pass) => !viewport(pass)),
    'the prefilter chain covers each whole mip',
  );
  assert.deepEqual(viewport(fullscreen.at(-1)), rect, 'the composite stays inside the view');
});

test('SSAO ends its geometry pass when a source throws', () => {
  const ssao = new SSAO(),
    failure = new Error('source failed');
  ssao.add({
    draw() {
      throw failure;
    },
  });
  const { passes, error } = inView(ssao);
  assert.equal(error, failure);
  assert.equal(passes.at(-1).at(-1)[0], 'pass.end', 'the geometry pass is ended');
});

for (const [name, Effect, bytes] of [
  ['SSAO', SSAO, 224],
  ['SSR', SSR, 160],
  ['SSGI', SSGI, 176],
])
  test(`${name} gives each view of a frame its own camera uniform`, () => {
    const { log } = inView(new Effect(), [
        [0, 0, 64, 96],
        [64, 0, 64, 96],
      ]),
      writes = log.filter((e) => e[0] === 'writeBuffer' && e[3].length === bytes * 2);
    assert.equal(writes.length, 2, 'one uniform write per view');
    assert.notEqual(writes[0][3], writes[1][3], 'the views have different cameras');
    assert.notEqual(writes[0][1], writes[1][1], 'the second view writes a copy, not the first view’s buffer');
    const copy = writes[1][1];
    assert.ok(
      log.some((e) => e[0] === 'group' && e[2].entries.some((entry) => entry.resource?.buffer === copy)),
      'and binds it',
    );
  });
