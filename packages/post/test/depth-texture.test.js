// DepthTexture over the recording mock GPU: a depth32float texture and an r32float distance target from one pass at any
// scene sample count, resize and device restore, added models drawn through the capture hook, several views per frame,
// pass order, dispose and errors. Pixels are checked on a real GPU by the visual check (demos/depth-texture.html).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, modules } from './support.js';
import { DepthTexture } from '../dist/depth.js';

/** A gltf-pro model stand-in: keeps the capture hook it is given and draws one triangle into the hook's pass. */
function model() {
  const m = {
    hooks: [],
    disposers: new Set(),
    draws: 0,
    setCapture(hook) {
      m.hooks.push(hook);
      return () => m.hooks.splice(m.hooks.indexOf(hook), 1);
    },
    onDispose(callback) {
      m.disposers.add(callback);
      return () => m.disposers.delete(callback);
    },
    draw(c, mode, color, depth) {
      assert.equal(mode, 'capture');
      m.draws++;
      m.seen = { color, depth };
      m.hooks[0].begin().draw(3);
    },
    destroy() {
      for (const callback of [...m.disposers]) callback();
    },
  };
  return m;
}
/** The log split into render passes, each starting at its beginRenderPass. */
function passes(log) {
  const out = [];
  for (const event of log)
    if (event[0] === 'beginRenderPass') out.push([event]);
    else if (event[0].startsWith('pass.')) out.at(-1)?.push(event);
  return out;
}
const clears = (log) => passes(log).filter((p) => p[0][1].colorAttachments.some((x) => x.loadOp === 'clear'));
/** Draws one frame of `rects` views (each its own index) and returns the log. */
function views(h, rects, scissors = []) {
  return h.gpu.record(() =>
    rects.forEach((viewport, index) => {
      h.view.begin(index);
      h.view.c.draw = (o) => h.draws.push({ ...o, color: h.view.c.color, descriptor: h.view.c.descriptor });
      h.view.c.view = {
        id: 'v' + index,
        camera: h.view.camera,
        viewport,
        scissor: scissors[index],
        index,
        count: rects.length,
      };
      h.engine.frameGraph.execute(h.view.c);
    }),
  );
}

for (const samples of [4, 1])
  test(`DepthTexture is a single-sample depth and distance target at ${samples}x`, async () => {
    const h = harness({ samples }),
      depth = DepthTexture.attach(h.engine);
    assert.equal(depth.texture, undefined, 'no textures before the first frame');
    assert.equal(depth.distance, undefined);
    assert.match(depth.name, /^scene-targets:/);
    const log = h.gpu.record(() => h.frame());
    for (const [texture, format] of [
      [depth.texture, 'depth32float'],
      [depth.distance, 'r32float'],
    ]) {
      assert.equal(texture.format, format);
      assert.equal(texture.sampleCount, 1, `${format} is single-sample under ${samples}x`);
      assert.deepEqual([texture.width, texture.height], [1280, 720], 'the drawing size');
      // RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC (mock values): drawn, sampled and read back.
      assert.equal(texture.usage, 16 | 4 | 1);
    }
    const pipeline = log.find((e) => e[0] === 'renderPipeline' && e[2].fragment?.targets?.length === 1)[2];
    assert.deepEqual(
      pipeline.fragment.targets.map((t) => t.format),
      ['r32float'],
    );
    assert.equal(pipeline.multisample.count, 1);
    assert.deepEqual(
      [pipeline.depthStencil.format, pipeline.depthStencil.depthCompare, pipeline.depthStencil.depthWriteEnabled],
      ['depth32float', 'greater-equal', true],
      'reversed Z: nearer is greater',
    );
    const replay = modules(log).find((code) => code.includes('fn margoTargets('));
    assert.match(replay, /o\.o0=vec4f\(vec4f\(distance\(t\.eye,t\.position\),0,0,1\)\);/, 'world distance to the eye');
    // Its own pass clears depth to 0 (far) and distance to 0 (empty) before core's meshes draw over it.
    const [clear] = passes(log),
      attachments = clear[0][1];
    assert.deepEqual(
      attachments.colorAttachments.map((a) => [a.loadOp, a.clearValue]),
      [['clear', { r: 0, g: 0, b: 0, a: 0 }]],
    );
    assert.deepEqual(
      [attachments.depthStencilAttachment.depthLoadOp, attachments.depthStencilAttachment.depthClearValue],
      ['clear', 0],
    );
    const [draw] = h.draws;
    assert.deepEqual([draw.clear, draw.clearDepth], [false, false], 'core draws over the cleared targets');
    assert.equal(draw.descriptor.multisample.count, 1);
    assert.deepEqual(draw.colorAttachments, [], 'one output: no extra attachments');
    assert.equal(h.view.c.descriptor.multisample.count, samples, "the scene's own descriptor is put back");
    depth.dispose();
    await null;
    assert.deepEqual(
      h.live().filter((r) => r.format),
      [],
    );
  });

test('DepthTexture follows the drawing size and tells onResize listeners', async () => {
  const h = harness(),
    depth = DepthTexture.attach(h.engine),
    calls = [];
  const remove = depth.onResize(() => calls.push([depth.texture.width, depth.distance.height]));
  h.frame();
  assert.deepEqual(calls, [[1280, 720]], 'the first frame creates the textures');
  const [first, firstDistance] = [depth.texture, depth.distance];
  await null;
  const steady = h.gpu.record(() => h.frame());
  assert.deepEqual(
    steady.filter((e) => /^(texture|module|renderPipeline|destroy)$/.test(e[0])),
    [],
    'a steady frame creates nothing',
  );
  assert.equal(depth.texture, first);
  h.view.state.width = 640;
  h.view.state.height = 360;
  await null;
  h.frame();
  assert.deepEqual(calls.at(-1), [640, 360]);
  assert.notEqual(depth.texture, first);
  assert.notEqual(depth.distance, firstDistance);
  await null;
  h.frame();
  assert.ok(first.destroyed && firstDistance.destroyed, 'the old textures are released');
  remove();
  h.view.state.width = 320;
  await null;
  h.frame();
  assert.equal(calls.length, 2, 'a removed listener is not called');
  assert.equal(depth.texture.width, 320);
  depth.dispose();
});

test('DepthTexture recreates its textures and pipeline on a restored device', () => {
  const h = harness(),
    depth = DepthTexture.attach(h.engine);
  let resized = 0;
  depth.onResize(() => resized++);
  h.frame();
  const before = depth.texture;
  h.engine.restore();
  assert.equal(depth.texture, undefined, 'the lost device textures are dropped');
  const log = h.gpu.record(() => h.frame());
  assert.equal(resized, 2);
  assert.notEqual(depth.texture, before);
  assert.equal(depth.texture.format, 'depth32float');
  assert.equal(log.filter((e) => e[0] === 'texture').length, 2, 'depth and distance');
  assert.ok(
    modules(log).some((code) => code.includes('fn margoTargets(')),
    'the replay shader is rebuilt on the new device',
  );
  assert.equal(log.filter((e) => e[0] === 'renderPipeline').length, 1);
  depth.dispose();
});

test('DepthTexture draws added models through the capture hook and restores them', () => {
  const h = harness(),
    depth = DepthTexture.attach(h.engine),
    a = model(),
    b = model();
  const release = depth.add(a);
  assert.equal(depth.add(a), release, 'adding twice keeps one capture');
  depth.add(b);
  assert.equal(a.hooks.length, 1, 'the capture hook is installed');
  const [hook] = a.hooks;
  assert.deepEqual(
    hook.targets.map((t) => t.format),
    ['r32float'],
  );
  assert.match(hook.declarations('struct Surface {base:vec4f}'), /fn margoCapture\(s:Surface,v:vec3f,k:vec3f\)/);
  const log = h.gpu.record(() => h.frame());
  assert.deepEqual([a.draws, b.draws], [1, 1]);
  assert.notEqual(a.seen.depth, h.view.c.depth, "models draw into DepthTexture's depth, and the scene's is put back");
  const capture = passes(log).filter((p) => p.some((e) => e[0] === 'pass.draw'));
  assert.equal(capture.length, 1, 'both models draw into one capture pass');
  assert.equal(capture[0].filter((e) => e[0] === 'pass.draw').length, 2);
  const attachments = capture[0][0][1];
  assert.deepEqual(
    attachments.colorAttachments.map((x) => x.loadOp),
    ['load'],
    'after core meshes, keeping them',
  );
  assert.equal(attachments.depthStencilAttachment.depthLoadOp, 'load');
  assert.equal(capture[0].at(-1)[0], 'pass.end', 'the capture pass is ended');
  assert.equal(
    capture[0].some((e) => e[0] === 'pass.setViewport'),
    false,
    'no view: the whole target',
  );
  // A model disposed on its own leaves the depth; the remover restores the model's own hook.
  b.destroy();
  release();
  assert.equal(a.hooks.length, 0, 'the remover restores the model');
  h.frame();
  assert.deepEqual([a.draws, b.draws], [1, 1], 'neither model draws after removal');
  const c = model();
  depth.add(c);
  depth.dispose();
  assert.equal(c.hooks.length, 0, 'dispose restores every added model');
});

test('DepthTexture ends its capture pass and restores the context when a model throws', () => {
  const h = harness(),
    depth = DepthTexture.attach(h.engine),
    failure = new Error('model failed'),
    m = model();
  m.draw = () => {
    m.hooks[0].begin();
    throw failure;
  };
  depth.add(m);
  const failed = [];
  assert.throws(() => {
    const record = h.gpu.record;
    record(() => {
      try {
        h.frame();
      } finally {
        failed.push(true);
      }
    });
  }, failure);
  assert.equal(h.view.c.descriptor.multisample.count, 4, "the scene's descriptor is put back");
  // The next frame starts a fresh capture pass (the failed one was ended, not reused).
  m.draw = () => m.hooks[0].begin().draw(3);
  const next = h.gpu.record(() => h.frame());
  const capture = passes(next).filter((p) => p.some((e) => e[0] === 'pass.draw'));
  assert.equal(capture.length, 1);
  assert.equal(capture[0].at(-1)[0], 'pass.end');
  depth.dispose();
});

test('DepthTexture keeps every view of a frame: the first clears, later ones load inside their rectangle', () => {
  const h = harness({ samples: 4 }),
    depth = DepthTexture.attach(h.engine),
    m = model();
  depth.add(m);
  const rects = [
      [0, 0, 640, 720],
      [640, 0, 640, 720],
      [100, 200, 300, 200],
    ],
    scissors = [undefined, [700, 10, 500, 600], undefined];
  const log = views(h, rects, scissors),
    all = passes(log),
    cleared = all.filter((p) => p[0][1].colorAttachments.some((x) => x.loadOp === 'clear'));
  assert.equal(cleared.length, 1, 'only the first view clears');
  assert.equal(all.indexOf(cleared[0]), 0, 'and before anything draws');
  assert.equal(cleared[0][0][1].depthStencilAttachment.depthLoadOp, 'clear');
  const captures = all.filter((p) => p.some((e) => e[0] === 'pass.draw'));
  assert.equal(captures.length, 3, 'one capture pass per view');
  captures.forEach((pass, i) => {
    assert.ok(pass[0][1].colorAttachments.every((x) => x.loadOp === 'load'));
    assert.equal(pass[0][1].depthStencilAttachment.depthLoadOp, 'load');
    // The recorder keeps five arguments: x, y, width, height and the minimum depth.
    const viewport = pass.find((e) => e[0] === 'pass.setViewport').slice(1, 6),
      scissor = pass.find((e) => e[0] === 'pass.setScissorRect').slice(1, 5);
    assert.deepEqual(viewport, [...rects[i], 0], `view ${i} viewport`);
    assert.deepEqual(scissor, scissors[i] ?? rects[i], `view ${i} scissor`);
  });
  // Core's meshes of every view: no clear of their own, single-sample, into the same textures.
  const core = h.draws.filter((d) => d.pipeline);
  assert.equal(core.length, 3);
  for (const draw of core) {
    assert.deepEqual([draw.clear, draw.clearDepth], [false, false]);
    assert.equal(draw.descriptor.multisample.count, 1);
  }
  assert.equal(new Set(core.map((d) => d.color)).size, 1, 'every view draws into one distance target');
  assert.deepEqual(
    log.filter((e) => e[0] === 'texture' && /^(r32float|depth32float)$/.test(e[2].format)).map((e) => e[2].format),
    ['r32float', 'depth32float'],
    'the textures are made once for the frame',
  );
  assert.equal(clears(views(h, rects, scissors)).length, 1, 'the next frame clears again at its first view');
  depth.dispose();
});

test('DepthTexture runs at its order option, default before the main pass', () => {
  for (const [order, expected] of [
    [undefined, [0, 1, 1]],
    [20, [0, 0, 1]],
    [-100, [1, 1, 1]],
  ]) {
    const h = harness(),
      seen = [];
    // Probes at -10, 0 (beside the main pass) and 40 note how many depth draws (draws with DepthTexture's pipeline)
    // have happened when they run.
    for (const at of [-10, 0, 40])
      h.engine.frameGraph.add({
        name: 'probe' + at,
        order: at,
        execute: () => seen.push(h.draws.filter((d) => d.pipeline).length),
      });
    const depth = DepthTexture.attach(h.engine, order === undefined ? {} : { order });
    h.frame();
    assert.deepEqual(seen, expected, `order ${order}`);
    depth.dispose();
  }
});

test('DepthTexture dispose releases its textures, models and plugin', async () => {
  const h = harness(),
    depth = DepthTexture.attach(h.engine),
    m = model();
  h.engine.plugins = h.plugins;
  depth.add(m);
  let resized = 0;
  depth.onResize(() => resized++);
  h.frame();
  assert.ok(h.plugins.has(depth.name));
  depth[Symbol.dispose]();
  assert.equal(h.plugins.has(depth.name), false, 'removed from the engine');
  assert.equal(m.hooks.length, 0);
  assert.equal(depth.texture, undefined);
  assert.equal(depth.distance, undefined);
  await null;
  h.frame();
  assert.deepEqual(
    h.live().filter((r) => r.format),
    [],
  );
  assert.equal(resized, 1, 'listeners are dropped');
  depth.dispose();
});

test('DepthTexture errors name the fix', () => {
  assert.throws(() => new DepthTexture({ order: Number.NaN }), { name: 'TypeError', message: /finite number/ });
  assert.throws(() => new DepthTexture({ order: '1' }), TypeError);
  const depth = new DepthTexture();
  assert.throws(() => depth.setup({ gpu: undefined }), { code: 'unsupported', message: /needs WebGPU/ });
  assert.throws(() => depth.add({}), { name: 'TypeError', message: /gltf-pro model or materials mesh/ });
  assert.throws(() => depth.add(null), TypeError);
  assert.throws(() => depth.onResize('later'), { name: 'TypeError', message: /needs a function/ });
  const m = model();
  depth.add(m);
  assert.throws(() => m.hooks[0].declarations('fn other(){}'), { code: 'unsupported', message: /gltf-pro surfaces/ });
  depth.dispose();
  assert.throws(() => depth.add(model()), { code: 'disposed', message: /create new/ });
  assert.throws(() => depth.setup(harness().engine), { code: 'disposed' });
  // A plugin that replaced core's shader: the replay cannot find core's lighting.
  const h = harness({ shader: '@fragment fn fragment()->@location(0) vec4f {return vec4f(1);}' }),
    replaced = DepthTexture.attach(h.engine);
  assert.throws(() => h.frame(), { code: 'unsupported', message: /standard core lighting shader/ });
  replaced.dispose();
});
