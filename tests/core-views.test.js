import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { Camera } from '../packages/core/dist/camera.js';
import { box } from '../packages/core/dist/geometry.js';
import { rectangleClear } from '../packages/core/dist/renderer.js';
import { gpuDrawHarness } from './support/core-draw-gpu.js';

// A fallback renderer that records each view and its draw: rectangles, clears and the drawn mesh ids.
async function engineWith(record, width = 200, height = 100) {
  const renderer = {
    backend: 'webgl2',
    add() {},
    remove() {},
    render(camera, _lighting, batches, graph, delta, view) {
      const ids = [...batches].flatMap((b) => Array.from({ length: b.count }, (_, i) => b.instances[i * 24 + 23]));
      record.push({ camera, delta, view, ids });
      graph.execute({
        backend: 'webgl2',
        gl: {},
        camera,
        delta,
        width,
        height,
        view: view && { id: view.id, camera, viewport: view.rect, index: view.index, count: view.count },
        draw(options = {}) {
          record.at(-1).viewport = options.viewport ?? view?.rect;
          record.at(-1).clear = options.clear ?? !view?.index;
        },
      });
    },
    dispose() {},
  };
  const canvas = { width, height, clientWidth: width, clientHeight: height, getContext() {} };
  return { engine: new Engine(canvas, await TransformStore.create(4), renderer, undefined, null), canvas };
}

// The registry @margoengine/cameras/layers keeps on globalThis; core reads mesh and camera masks from it.
function layers(t) {
  const key = Symbol.for('margoengine.layers'),
    saved = globalThis[key],
    masks = new WeakMap(),
    registry = { masks, cameras: new WeakMap(), source: null, maskOf: (mesh) => masks.get(mesh) ?? 1 };
  globalThis[key] = registry;
  t.after(() => {
    globalThis[key] = saved;
  });
  return registry;
}

test('four views draw one scene into four rectangles with each camera aspect; the first clears', async () => {
  const calls = [];
  const { engine } = await engineWith(calls);
  const cameras = [0, 1, 2, 3].map(() => new Camera());
  try {
    engine.render({
      delta: 0.1,
      views: [
        [0, 0, 100, 50],
        [100, 0, 100, 50],
        [0, 50, 100, 50],
        [100, 50, 100, 50],
      ].map((viewport, i) => ({ camera: cameras[i], pixels: true, viewport })),
    });
    assert.deepEqual(
      calls.map((call) => call.view.rect),
      [
        [0, 0, 100, 50],
        [100, 0, 100, 50],
        [0, 50, 100, 50],
        [100, 50, 100, 50],
      ],
    );
    assert.deepEqual(
      calls.map((call) => [call.view.index, call.view.count, call.view.id]),
      [
        [0, 4, '0'],
        [1, 4, '1'],
        [2, 4, '2'],
        [3, 4, '3'],
      ],
    );
    const wide = new Camera();
    wide.update(2, false);
    assert.ok(
      calls.every((call) => Math.abs(call.camera.matrix[0] - wide.matrix[0]) < 1e-5),
      'aspect 2:1',
    );
    assert.deepEqual(
      calls.map((call) => call.viewport),
      calls.map((call) => call.view.rect),
      'draw() uses the view rectangle by default',
    );
    assert.deepEqual(
      calls.map((call) => call.clear),
      [true, false, false, false],
    );
    assert.equal(calls[0].delta, 0.1);
    assert.ok(
      calls.slice(1).every((call) => call.delta === 0),
      'per-frame passes advance once per scene',
    );
  } finally {
    engine.dispose();
  }
});

test('a camera in two views advances once, and plugins update once per frame', async () => {
  const calls = [],
    updates = [];
  const { engine } = await engineWith(calls);
  const camera = new Camera();
  let steps = 0;
  const advance = camera.advance.bind(camera);
  camera.advance = (delta) => {
    if (delta) steps++;
    advance(delta);
  };
  engine.use({ name: 'clock', setup() {}, onPreUpdate: (delta) => updates.push(delta) });
  try {
    engine.render({
      delta: 0.05,
      views: [
        { camera, viewport: [0, 0, 0.5, 1] },
        { camera, viewport: [0.5, 0, 0.5, 1] },
      ],
    });
    assert.equal(steps, 1);
    assert.deepEqual(updates, [0.05]);
  } finally {
    engine.dispose();
  }
});

test('views reject an empty list, a view without a camera and rectangles outside the canvas', async () => {
  const { engine, canvas } = await engineWith([]);
  const camera = new Camera();
  try {
    assert.throws(() => engine.render({ views: [] }), TypeError);
    assert.throws(() => engine.render({ views: [{ viewport: [0, 0, 1, 1] }] }), /camera, viewport/);
    assert.throws(
      () => engine.render({ views: [{ camera, pixels: true, viewport: [0, 0, canvas.width + 1, 10] }] }),
      /exceeds target/,
    );
    assert.throws(() => engine.render({ views: [{ camera, pixels: true, viewport: [1.5, 0, 10, 10] }] }), RangeError);
    assert.throws(() => engine.render({ views: [{ camera, viewport: [0, 0, 0, 1] }] }), RangeError);
    for (const layers of [0.5, -1, 2 ** 32])
      assert.throws(
        () => engine.render({ views: [{ camera, viewport: [0, 0, 1, 1], layers }] }),
        /View layers .* is not a 32-bit layer mask/,
      );
    engine.render();
  } finally {
    engine.dispose();
  }
});

test('fractional views tile an odd canvas without gaps or overlap', async () => {
  const calls = [];
  const { engine, canvas } = await engineWith(calls);
  canvas.clientWidth = 201;
  canvas.clientHeight = 101;
  try {
    engine.render({
      views: [
        [0, 0, 0.5, 0.5],
        [0.5, 0, 0.5, 0.5],
        [0, 0.5, 0.5, 0.5],
        [0.5, 0.5, 0.5, 0.5],
      ].map((viewport) => ({ camera: new Camera(), viewport })),
    });
    assert.deepEqual(
      calls.map((call) => call.view.rect),
      [
        [0, 0, 101, 51],
        [101, 0, 100, 51],
        [0, 51, 101, 50],
        [101, 51, 100, 50],
      ],
    );
  } finally {
    engine.dispose();
  }
});

test('target views stack per target texture, sized to it, and draw grouped after the canvas views listed first', async () => {
  const calls = [];
  const { engine } = await engineWith(calls);
  const camera = new Camera(),
    target = { color: { width: 64, height: 32 } };
  try {
    engine.render({
      views: [
        { camera, viewport: [0, 0, 0.5, 1] },
        { camera, viewport: [0, 0, 1, 1], target },
        { camera, viewport: [0.5, 0, 0.5, 1] },
        { camera, viewport: [0, 0, 0.5, 1], target },
      ],
    });
    assert.deepEqual(
      calls.map((call) => [call.view.rect, call.view.index, call.view.count, !!call.view.target]),
      [
        [[0, 0, 100, 100], 0, 2, false],
        [[100, 0, 100, 100], 1, 2, false],
        [[0, 0, 64, 32], 0, 2, true],
        [[0, 0, 32, 32], 1, 2, true],
      ],
    );
  } finally {
    engine.dispose();
  }
});

test('interleaved views into two targets of one size draw grouped by target, in caller order within each', async () => {
  const calls = [];
  const { engine } = await engineWith(calls);
  const camera = new Camera(),
    a = { color: { width: 64, height: 32 } },
    b = { color: { width: 64, height: 32 } };
  try {
    engine.render({
      views: [
        { camera, viewport: [0, 0, 0.5, 1], target: a },
        { camera, viewport: [0, 0, 1, 1], target: b },
        { camera, viewport: [0.5, 0, 0.5, 1], target: a },
      ],
    });
    assert.deepEqual(
      calls.map(({ view }) => [view.target === a ? 'a' : 'b', view.index, view.count, view.id, view.rect[0]]),
      [
        ['a', 0, 2, '0', 0],
        ['a', 1, 2, '2', 32],
        ['b', 0, 1, '1', 0],
      ],
      'both views of a stack on its 4x attachments (the last resolves) before b reuses them',
    );
  } finally {
    engine.dispose();
  }
});

test('engine.views replaces the full-canvas view in the frame loop', async () => {
  const calls = [];
  const { engine } = await engineWith(calls);
  const saved = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame],
    queue = [];
  globalThis.requestAnimationFrame = (callback) => queue.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  try {
    engine.views = [
      { camera: engine.camera, viewport: [0, 0, 0.5, 1] },
      { camera: new Camera(), viewport: [0.5, 0, 0.5, 1], id: 'side' },
    ];
    engine.start();
    queue.shift()(1000);
    assert.deepEqual(
      calls.map((call) => call.view?.id),
      ['0', 'side'],
    );
    engine.views = [];
    queue.shift()(1016);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].view, undefined, 'an empty list draws the full-canvas view again');
  } finally {
    engine.dispose();
    [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = saved;
  }
});

test('view layers and camera layers filter meshes; changing them re-collects', async (t) => {
  const registry = layers(t),
    calls = [];
  const { engine } = await engineWith(calls);
  try {
    const shape = box(),
      a = engine.createMesh().setGeometry(shape),
      b = engine.createMesh().setGeometry(shape);
    registry.masks.set(b, 0b10);
    const view = (layers) => ({ camera: engine.camera, viewport: [0, 0, 1, 1], layers });
    engine.render({ culling: false, views: [view(0b01), view(0b10), view(0b11), view(0)] });
    assert.deepEqual(
      calls.map((call) => call.ids),
      [[a.id], [b.id], [a.id, b.id], []],
    );
    assert.deepEqual(
      calls.map((call) => call.view.layers),
      [1, 2, 3, 0],
    );
    engine.render({ culling: false });
    assert.deepEqual(calls.at(-1).ids, [a.id, b.id], 'a camera without a mask draws every layer');
    registry.cameras.set(engine.camera, 0b10);
    engine.render({ culling: false });
    assert.deepEqual(calls.at(-1).ids, [b.id], 'the camera mask applies to the plain frame');
    engine.render({ culling: false, views: [view()] });
    assert.deepEqual(calls.at(-1).ids, [b.id], 'and to views without layers');
  } finally {
    engine.dispose();
  }
});

test('a partial-rectangle clear draws inside the view; a full view clears the attachment', () => {
  assert.equal(rectangleClear(undefined, 200, 100, true, true, 0), 'attachment');
  assert.equal(rectangleClear([0, 0, 200, 100], 200, 100, true, true, 0), 'attachment');
  assert.equal(rectangleClear([0, 0, 100, 100], 200, 100, true, true, 0), 'draw');
  assert.equal(rectangleClear([0, 0, 100, 100], 200, 100, false, true, 0), 'draw');
  assert.equal(rectangleClear([0, 0, 100, 100], 200, 100, false, false, 0), 'none');
  assert.throws(() => rectangleClear([0, 0, 100, 100], 200, 100, true, true, 1), /clear: false/);
});

// A caller texture in the shape the WebGPU mock device reports.
const callerTexture = (format, sampleCount = 1, width = 64, height = 32) => ({
  format,
  sampleCount,
  width,
  height,
  createView: () => ({ caller: format }),
});
const targetView = (target) => ({
  rect: [0, 0, target.color.width, target.color.height],
  index: 0,
  count: 1,
  id: 't',
  target,
});

test('a 4x target view draws into core 4x attachments of its format and resolves colour', (t) => {
  const h = gpuDrawHarness(t, 4),
    target = { color: callerTexture('rgba16float') };
  h.frame(undefined, targetView(target));
  const own = h.device.textures.filter((texture) => texture.width === 64 && texture.height === 32),
    draw = h.draws().at(-1).descriptor;
  assert.deepEqual(
    own.map((texture) => [texture.format, texture.sampleCount]),
    [
      ['rgba16float', 4],
      ['depth32float', 4],
    ],
    'core allocates matching 4x colour and depth for the target',
  );
  assert.equal(draw.colorAttachments[0].resolveTarget.caller, 'rgba16float', 'colour resolves into the caller texture');
  assert.equal(draw.depthStencilAttachment.view.texture, own[1], 'the scene draws into core depth');
  // Reused while the size and format stay; replaced on resize; released on dispose (and so on device restore, which
  // disposes the old renderer).
  const count = h.device.textures.length;
  h.frame(undefined, targetView(target));
  assert.equal(h.device.textures.length, count, 'steady frames reuse the attachments');
  h.frame(undefined, targetView({ color: callerTexture('rgba16float', 1, 32, 32) }));
  assert.ok(
    own.every((texture) => texture.destroyed),
    'a new target size releases the old ones',
  );
  const resized = h.device.textures.filter((texture) => !texture.destroyed && texture.width === 32);
  h.renderer.dispose();
  assert.ok(
    resized.every((texture) => texture.destroyed),
    'dispose releases them',
  );
});

test('views into one 4x target stack: the shared 4x colour is kept and resolved once both halves are drawn', (t) => {
  const h = gpuDrawHarness(t, 4),
    target = { color: callerTexture('bgra8unorm') },
    half = (index, x) => ({
      rect: [x, 0, 32, 32],
      index,
      count: 2,
      id: String(index),
      clear: { color: index ? '#000044' : '#440000' },
      target,
    });
  h.frame(undefined, half(0, 0));
  const first = h.passes.length;
  h.frame(undefined, half(1, 32));
  const [left, right] = [h.passes.slice(0, first), h.passes.slice(first)].map((passes) =>
      passes.find((pass) => pass.commands.some(([name]) => name === 'draw')),
    ),
    attachment = (pass) => pass.descriptor.colorAttachments[0];
  assert.deepEqual(
    [left, right].map((pass) => [attachment(pass).loadOp, attachment(pass).storeOp, !!attachment(pass).resolveTarget]),
    [
      ['load', 'store', false],
      ['load', 'discard', true],
    ],
    'both views load the shared 4x colour; the first keeps it, the last resolves it into the target and drops it',
  );
  assert.equal(attachment(left).view, attachment(right).view, 'one shared 4x colour');
  for (const [pass, x] of [
    [left, 0],
    [right, 32],
  ])
    assert.deepEqual(
      pass.commands.slice(0, 3),
      [['viewport', x, 0, 32, 32, 0, 1], ['scissor', x, 0, 32, 32], ['pipeline']],
      'each view clears only its rectangle, with a draw',
    );
});

test('a target depth in the scene samples and format is drawn into; other shapes throw naming the fix', (t) => {
  for (const samples of [1, 4]) {
    const h = gpuDrawHarness(t, samples);
    h.frame(
      undefined,
      targetView({ color: callerTexture('bgra8unorm'), depth: callerTexture('depth32float', samples) }),
    );
    assert.equal(h.draws().at(-1).descriptor.depthStencilAttachment.view.caller, 'depth32float');
    for (const target of [
      { color: callerTexture('bgra8unorm', 4) },
      { color: callerTexture('bgra8unorm'), depth: callerTexture('depth32float', samples, 32, 32) },
    ])
      assert.throws(() => h.frame(undefined, targetView(target)), /Invalid view target: use 1-sample colour/);
    // Core no longer copies its depth into a caller depth of another format or sample count: that throws instead of
    // leaving the caller's texture unwritten.
    for (const depth of [callerTexture('depth24plus', samples), callerTexture('depth32float', 5 - samples)])
      assert.throws(
        () => h.frame(undefined, targetView({ color: callerTexture('bgra8unorm'), depth })),
        /Invalid view depth: use the scene depth format and samples, or omit depth; see https:\/\/margoengine\.com\/errors#views$/,
      );
  }
});
