import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { HTMLTexture, surfaceHit } from '../dist/texture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
};
const project = (m, [x, y, z]) => {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w];
};
const perspective = (fov, aspect, near, far) => {
  const f = 1 / Math.tan(fov / 2);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (near * far) / (near - far), 0];
};
const lookFrom = ([ex, ey, ez]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -ex, -ey, -ez, 1];
const pose = (angle, [tx, ty, tz], scale = 1) => {
  const c = Math.cos(angle) * scale,
    s = Math.sin(angle) * scale;
  return [c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0, tx, ty, tz, 1];
};

test('surfaceHit returns the UV a surface point projects from, over 200 random poses and points', () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const viewProjection = multiply(perspective(1, 4 / 3, 0.1, 100), lookFrom([0, 0, 6]));
  let checked = 0;
  for (let i = 0; i < 200; i++) {
    const model = pose((random() - 0.5) * 2.4, [(random() - 0.5) * 2, (random() - 0.5) * 2, (random() - 0.5) * 2]),
      width = 0.5 + random() * 2,
      height = 0.5 + random() * 2,
      u = random(),
      v = random(),
      local = [(u - 0.5) * width, (0.5 - v) * height, 0],
      world = [0, 1, 2].map((r) => model[r] * local[0] + model[4 + r] * local[1] + model[12 + r]),
      [x, y] = project(viewProjection, world);
    if (Math.abs(x) > 1 || Math.abs(y) > 1) continue;
    const hit = surfaceHit(viewProjection, model, width, height, x, y);
    assert.ok(hit, `pose ${i}: no hit`);
    assert.ok(Math.abs(hit.u - u) < 1e-6 && Math.abs(hit.v - v) < 1e-6, `pose ${i}: ${hit.u},${hit.v} vs ${u},${v}`);
    checked++;
  }
  assert.ok(checked > 150, `only ${checked} poses on screen`);
  // Off the quad, and a quad seen edge on, are misses.
  assert.equal(surfaceHit(viewProjection, pose(0, [0, 0, 0]), 1, 1, 0.9, 0.9), null);
  assert.equal(surfaceHit(viewProjection, pose(Math.PI / 2, [0, 0, 0]), 1, 1, 0, 0), null);
  // A singular pose (scale 0) is a miss, not a NaN.
  assert.equal(surfaceHit(viewProjection, pose(0, [0, 0, 0], 0), 1, 1, 0, 0), null);
});

test('HTMLTexture validates its options, needs WebGPU and draws each textured surface in one pass over the frame', async () => {
  const h = optionalGPU(),
    dom = new JSDOM('<body><canvas width="128" height="96"></canvas></body>');
  globalThis.CanvasRenderingContext2D ??= dom.window.CanvasRenderingContext2D;
  h.engine.canvas = dom.window.document.querySelector('canvas');
  assert.throws(() => new HTMLTexture({ rasterizer: 'png' }), /rasterizer/);
  assert.throws(() => new HTMLTexture({ rasterizer: 'element-image' }), /drawElementImage/);
  const textures = HTMLTexture.attach(h.engine);
  assert.equal(textures.rasterizer, 'foreign-object');
  const element = dom.window.document.createElement('div');
  assert.throws(() => textures.add(element), /surface size/, 'An element with no CSS size and no width');
  assert.throws(() => textures.add(element, { width: 1, height: 1, pixelRatio: 8 }), /pixelRatio/);
  assert.throws(() => textures.add(element, { width: 1, height: 1, matrix: [1, 2] }), /matrix/);
  const surface = textures.add(element, { width: 2, height: 1, pixelRatio: 1 });
  assert.equal(element.parentElement.getAttribute('data-margoengine-html-surface'), '');
  assert.equal(element.parentElement.style.pointerEvents, 'none');
  try {
    // No raster yet: nothing drawn. A raster in place (as the browser path leaves it): one pass, one draw of 6.
    surface.busy = true;
    h.frame();
    assert.equal(h.counts.render, 0);
    surface.texture = h.engine.gpu.createTexture({ size: [2, 1], format: 'rgba8unorm', usage: 4 });
    const descriptors = [],
      begin = h.context.encoder.beginRenderPass;
    h.context.encoder.beginRenderPass = (descriptor) => (
      descriptors.push(
        structuredClone({
          ...descriptor,
          colorAttachments: descriptor.colorAttachments.map(({ loadOp, storeOp }) => ({ loadOp, storeOp })),
          depthStencilAttachment: { ...descriptor.depthStencilAttachment, view: undefined },
        }),
      ),
      begin(descriptor)
    );
    h.frame();
    assert.equal(h.counts.render, 1);
    // Over the frame: colour loaded, depth loaded and stored, so a later pass sees the quad's depth.
    assert.deepEqual(descriptors.at(-1).colorAttachments, [{ loadOp: 'load', storeOp: 'store' }]);
    assert.equal(descriptors.at(-1).depthStencilAttachment.depthLoadOp, 'load');
    assert.equal(descriptors.at(-1).depthStencilAttachment.depthStoreOp, 'store');
    const pipeline = h.pipelines.at(-1);
    assert.equal(pipeline.depthStencil.depthWriteEnabled, true, 'The quad writes depth like scene geometry');
    assert.equal(pipeline.primitive.cullMode, 'none');
  } finally {
    textures.dispose();
    dom.window.close();
  }
  assert.equal(element.isConnected, false, 'Dispose removes the holder');
  const gl = optionalGPU();
  gl.engine.gpu = undefined;
  assert.throws(() => HTMLTexture.attach(gl.engine), /requires WebGPU/);
});

// WGSL reserved words (W3C WGSL, "Reserved Words"): the first draft named its sampler `smooth`, and the shader module
// failed to compile in the browser while the fake GPU above accepted it.
const reserved = new Set(
  `NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await become cast catch class
  co_await co_return co_yield coherent column_major common compile compile_fragment concept const_cast consteval
  constexpr constinit crate debugger decltype delete demote demote_to_helper do dynamic_cast enum explicit export
  extends extern external fallthrough filter final finally friend from fxgroup get goto groupshared highp impl
  implements import inline instanceof interface layout lowp macro macro_rules match mediump meta mod module move mut
  mutable namespace new nil noexcept noinline nointerpolation non_coherent noncoherent noperspective null nullptr of
  operator package packoffset partition pass patch pixelfragment precise precision premerge priv protected pub public
  readonly ref regardless register reinterpret_cast require resource restrict self set shared sizeof smooth snorm
  static static_assert static_cast std subroutine super target template this thread_local throw trait try type
  typedef typeid typename typeof union unless unorm unsafe unsized use using varying virtual volatile wgsl where with
  writeonly yield`.split(/\s+/),
);

test('HTMLTexture shader names nothing WGSL reserves', () => {
  const h = optionalGPU(),
    dom = new JSDOM('<body><canvas width="128" height="96"></canvas></body>');
  globalThis.CanvasRenderingContext2D ??= dom.window.CanvasRenderingContext2D;
  h.engine.canvas = dom.window.document.querySelector('canvas');
  const codes = [],
    create = h.engine.gpu.createShaderModule;
  h.engine.gpu.createShaderModule = (descriptor) => (codes.push(descriptor.code), create(descriptor));
  const textures = HTMLTexture.attach(h.engine),
    surface = textures.add(dom.window.document.createElement('div'), { width: 1, height: 1, pixelRatio: 1 });
  try {
    surface.busy = true;
    surface.texture = h.engine.gpu.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 4 });
    h.frame();
    assert.equal(codes.length, 1);
    const names = [
      ...codes[0].matchAll(/\b(?:var(?:<[^>]*>)?|let|fn|struct)\s+([A-Za-z_]\w*)|([A-Za-z_]\w*)\s*:/g),
    ].map((m) => m[1] ?? m[2]);
    assert.ok(names.includes('linearSampler'), names.join(' '));
    assert.deepEqual(
      names.filter((name) => reserved.has(name)),
      [],
    );
  } finally {
    textures.dispose();
    dom.window.close();
  }
});

test('HTMLTexture element-image opts the holder canvas and element in, draws in the paint event, and opts out', async () => {
  const h = optionalGPU(),
    dom = new JSDOM('<body><canvas width="128" height="96"></canvas></body>'),
    drawn = [];
  // jsdom has no 2D context: a stand-in with the HTML-in-canvas method, as a browser that ships it.
  class Context2D {
    reset() {}
    drawElementImage(element, x, y, w, h) {
      drawn.push([element, x, y, w, h]);
    }
  }
  const previous = globalThis.CanvasRenderingContext2D;
  globalThis.CanvasRenderingContext2D = Context2D;
  const getContext = dom.window.HTMLCanvasElement.prototype.getContext;
  dom.window.HTMLCanvasElement.prototype.getContext = () => new Context2D();
  h.engine.canvas = dom.window.document.querySelector('canvas');
  try {
    const textures = HTMLTexture.attach(h.engine);
    assert.equal(textures.rasterizer, 'element-image', 'The native rasterizer where the browser has it');
    const element = dom.window.document.createElement('div'),
      surface = textures.add(element, { width: 2, height: 1, pixelRatio: 2 });
    const holder = element.parentElement;
    assert.equal(holder.tagName, 'CANVAS');
    assert.equal(holder.getAttribute('content'), 'drawable');
    assert.equal(element.hasAttribute('drawable'), true);
    assert.equal(holder.style.transform, 'none', 'The holder rests in the viewport, where the browser snapshots it');
    // A paint event with no raster waiting is a change of the element's rendering.
    surface.dirty = false;
    holder.dispatchEvent(new dom.window.Event('paint'));
    assert.equal(surface.dirty, true);
    // A frame starts the raster, which waits for the paint event and draws there, at the texture's pixel size.
    h.frame();
    assert.equal(surface.dirty, false);
    assert.equal(drawn.length, 0, 'Nothing drawn before the paint event');
    holder.dispatchEvent(new dom.window.Event('paint'));
    // jsdom lays nothing out: the element's CSS size is 0, so the texture is 1 x 1.
    assert.deepEqual(drawn, [[element, 0, 0, 1, 1]]);
    assert.equal(surface.dirty, false, 'The paint event the raster asked for is no change');
    textures.dispose();
    assert.equal(element.hasAttribute('drawable'), false, 'Dispose takes the drawable attribute off again');
  } finally {
    dom.window.HTMLCanvasElement.prototype.getContext = getContext;
    globalThis.CanvasRenderingContext2D = previous;
    dom.window.close();
  }
});
