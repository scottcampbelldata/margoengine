// KB-VPT-XR-VIEWS (2026-11-19): the tracer kept one accumulation for one camera. A frame that draws two views with
// different cameras (an XR session's two eyes, or two views of one scene) restarted the other view's image at every
// view: on WebGPU each view traced one sample and never more, and on the WebGL2 layer's route a trace that runs across
// tasks was dropped by the other view's restart before it landed, so no sample ever landed. Each view (PassContext.view
// id, the plain frame its own) now keeps its own accumulation, released once the view is no longer drawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core/extension';
import { VoxelPathTracer } from '../dist/index.js';
import { fakeDevice, fakeEngine, settle, simpleScene } from './support.js';

// A fake device of the WebGL2 layer (route-pace.test.js): the tracer takes its compatibility route there.
function compatDevice() {
  const device = fakeDevice(),
    encoder = device.createCommandEncoder,
    record = (commands) => new Proxy({}, { get: (_, name) => (...args) => void commands.push([name, ...args]) });
  device.adapterInfo = { vendor: 'margo-webgl2', architecture: 'webgl2', device: 'test', description: 'test' };
  device.createCommandEncoder = (d) => {
    const e = encoder(d);
    e.beginRenderPass = () => record([]);
    e.resolveQuerySet = () => {};
    e.copyTextureToTexture = () => {};
    return e;
  };
  return device;
}

// Two eyes a few centimetres apart, as an XR session draws them, each into its own target of the same size.
function eyes(ids = ['xr-0', 'xr-1']) {
  return ids.map((id, i) => {
    const camera = new Camera({ position: [20 + i * 0.064, 14, 24], target: [4 + i * 0.064, 3, 4], near: 0.1, far: 500 });
    return { id, camera };
  });
}

// One engine frame drawing `views` in order, as core's renderViews does: the pre-update hook once, then each view's
// graph run with its camera and `PassContext.view`.
// A view's `viewport` defaults to its whole target (an XR eye's own texture).
function drawViews(h, tracer, views, delta = 1 / 60) {
  tracer.onPreUpdate?.(delta);
  views.forEach(({ id, camera, viewport = [0, 0, h.context.width, h.context.height] }, index) => {
    camera.update(viewport[2] / viewport[3], true);
    h.context.camera = camera;
    h.context.view = id === undefined ? undefined : { id, camera, viewport, index, count: views.length };
    h.engine.frameGraph.execute(h.context);
  });
  h.context.view = undefined;
  h.context.camera = h.camera;
  assert.deepEqual(h.engine.errors, []);
}

for (const compat of [false, true])
  test(`two alternating views each accumulate their own image (${compat ? 'WebGL2 route' : 'WebGPU'})`, async () => {
    const h = fakeEngine(compat ? compatDevice() : fakeDevice()),
      tracer = VoxelPathTracer.attach(h.engine, { scene: simpleScene(), maxSamples: 6, samplesPerFrame: 1, denoise: false });
    try {
      await tracer.ready;
      const views = eyes(),
        seen = [];
      for (let i = 0; i < 80 && tracer.stats.samples < 6; i++) {
        drawViews(h, tracer, views);
        seen.push(tracer.stats.samples);
        for (let k = 0; k < 20; k++) await settle();
      }
      assert.equal(tracer.stats.samples, 6, `the last view drawn reached maxSamples (samples seen: ${seen.join(' ')})`);
      assert.ok(tracer.stats.converged, 'the last view drawn converged');
      // The first view converged too: drawing it alone traces nothing more and keeps its image.
      const submits = h.device.submits;
      drawViews(h, tracer, [views[0]]);
      assert.equal(tracer.stats.samples, 6, 'the first view kept its own samples');
      assert.equal(h.device.submits, submits, 'a converged view submits no trace');
    } finally {
      tracer.dispose();
    }
  });

for (const compat of [false, true])
  test(`a view not drawn for a while is released with its buffers; the plain frame keeps its own image (${compat ? 'WebGL2 route' : 'WebGPU'})`, async () => {
    const h = fakeEngine(compat ? compatDevice() : fakeDevice()),
      tracer = VoxelPathTracer.attach(h.engine, { scene: simpleScene(), maxSamples: 3, samplesPerFrame: 1, denoise: false }),
      image = 64 * 48 * 16,
      live = () => h.device.buffers.filter((b) => !b.destroyed && b.size === image).length,
      // The route's sums: four rgba32float targets a view, and its scratch set.
      sums = () => h.device.textures.filter((t) => !t.destroyed && t.format === 'rgba32float').length;
    try {
      await tracer.ready;
      const views = eyes(),
        plain = { id: undefined, camera: h.camera };
      for (let i = 0; i < 80 && !(tracer.stats.samples === 3 && sums() === (compat ? 16 : 0)); i++) {
        drawViews(h, tracer, [plain, ...views]);
        for (let k = 0; k < 20; k++) await settle();
      }
      assert.equal(tracer.stats.samples, 3);
      // Three images (accum, albedo, normals each): the plain frame and two views.
      assert.equal(live(), 9, 'one set of image buffers per view');
      if (compat) assert.equal(sums(), 16, "each view's sums are its own");
      // The views stop (the XR session ended); the plain frame goes on and keeps its image.
      for (let i = 0; i < 10; i++) {
        drawViews(h, tracer, [plain]);
        for (let k = 0; k < 5; k++) await settle();
      }
      assert.equal(live(), 3, "the stopped views' image buffers are destroyed");
      if (compat) assert.equal(sums(), 8, "the stopped views' sums are destroyed");
      assert.equal(tracer.stats.samples, 3, 'the plain frame kept its samples');
      // A restart (reset) reaches every view, drawn or not.
      tracer.reset();
      drawViews(h, tracer, [plain]);
      if (!compat) assert.equal(tracer.stats.samples, 1, 'reset restarts the plain frame');
      else assert.equal(tracer.stats.samples, 0, 'reset restarts the plain frame (its new samples land later)');
    } finally {
      tracer.dispose();
    }
    assert.equal(live(), 0, 'dispose frees every view');
  });

test('reset and setScene restart every view, not only the one drawn last', async () => {
  const h = fakeEngine(),
    tracer = VoxelPathTracer.attach(h.engine, { scene: simpleScene(), maxSamples: 4, samplesPerFrame: 1, denoise: false });
  try {
    await tracer.ready;
    const views = eyes();
    for (let i = 0; i < 20 && tracer.stats.samples < 4; i++) {
      drawViews(h, tracer, views);
      await settle();
    }
    assert.equal(tracer.stats.samples, 4);
    tracer.reset();
    drawViews(h, tracer, [views[0]]);
    assert.equal(tracer.stats.samples, 1, 'reset restarted the first view');
    tracer.setScene(simpleScene({ revision: 2 }));
    drawViews(h, tracer, [views[1]]);
    assert.equal(tracer.stats.samples, 1, 'setScene restarted the second view');
  } finally {
    tracer.dispose();
  }
});

// Two views side by side in one target (core multi-view, split screen): each camera's aspect is its rectangle's, so
// each image is traced at its rectangle's size and drawn into its rectangle. The tracer traced the whole target's size
// and drew it by target pixel, so a view showed part of its image stretched over its rectangle.
test('views side by side in one target each trace and draw their own rectangle', async () => {
  const h = fakeEngine(),
    tracer = VoxelPathTracer.attach(h.engine, { scene: simpleScene(), maxSamples: 2, samplesPerFrame: 1, denoise: false });
  try {
    await tracer.ready;
    const [left, right] = eyes(['left', 'right']);
    left.viewport = [0, 0, 32, 48];
    right.viewport = [32, 0, 32, 48];
    let passes = [];
    for (let i = 0; i < 20 && tracer.stats.samples < 2; i++) {
      h.device.passes.length = 0;
      drawViews(h, tracer, [left, right]);
      passes = [...h.device.passes];
      await settle();
    }
    assert.equal(tracer.stats.samples, 2);
    assert.deepEqual([tracer.stats.width, tracer.stats.height], [32, 48], "the image is the rectangle's size");
    const live = h.device.buffers.filter((b) => !b.destroyed);
    assert.equal(live.filter((b) => b.size === 32 * 48 * 16).length, 6, 'each view traces an image of its rectangle');
    assert.equal(live.filter((b) => b.size === 64 * 48 * 16).length, 0, "no view traces the whole target's size");
    // The display uniforms (View in shaders.ts: size at float 32, the rectangle's origin at float 42).
    const uniforms = live
      .filter((b) => b.size === 176)
      .map((b) => [...new Float32Array(b.data, 32 * 4, 4), ...new Float32Array(b.data, 42 * 4, 2)]);
    assert.deepEqual(uniforms, [
      [32, 48, 32, 48, 0, 0],
      [32, 48, 32, 48, 32, 0],
    ]);
    const draws = passes.filter((p) => p.type === 'render');
    assert.deepEqual(
      draws.map((p) => p.commands.find(([name]) => name === 'setViewport').slice(1, 5)),
      [left.viewport, right.viewport],
      'each view draws into its rectangle',
    );
  } finally {
    tracer.dispose();
  }
});
