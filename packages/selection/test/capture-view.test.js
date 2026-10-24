// Public Engine/Picking calls on the existing CPU GPU recorder. Returned IDs
// stay zero: these tests qualify capture commands, never native hits/pixels.
import assert from 'node:assert/strict';
import test from 'node:test';
const { Engine, TransformStore } = await import(
  process.env.MARGO_SOURCE_TEST ? '../../core/src/extension.ts' : '../../core/dist/extension.js'
);
const { Picking } = await import(process.env.MARGO_SOURCE_TEST ? '../src/index.ts' : '../dist/index.js');
import { rectangleClear } from '../../core/dist/renderer.js';
import { wgsl } from '../../core/dist/shaders.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

async function harness({ samples = 1, capture = true, background } = {}) {
  const h = optionalGPU(),
    c = h.context,
    device = h.engine.gpu,
    draws = [],
    copies = [];
  c.encoder.finish = () => ({});
  c.encoder.copyTextureToBuffer = (source, target, extent) => {
    copies.push({ source, extent });
    new Uint32Array(target.buffer.data).fill(0);
  };
  device.createCommandEncoder = () => c.encoder;
  device.queue.submit = () => {};
  const originalDraw = (options = {}) => {
    const viewport = options.viewport ?? c.view?.viewport,
      scissor = options.scissor ?? c.view?.scissor;
    const record = { options, extraMRT: options.colorAttachments?.length ?? 0 };
    draws.push(record);
    // Exercise core's actual rectangle-clear guard with the original explicit
    // clear/depth inputs. The recorder does not fabricate attachment acceptance.
    record.clearMode = rectangleClear(
      c.view ? (viewport ?? scissor) : undefined,
      c.width,
      c.height,
      options.clear ?? true,
      options.clearDepth ?? true,
      record.extraMRT,
    );
  };
  const renderer = {
    backend: 'webgpu',
    gpu: device,
    add() {},
    remove() {},
    geometryBuffers() {
      return null;
    },
    dispose() {},
    render(camera, _lighting, _batches, graph, delta, view) {
      Object.assign(c, {
        camera,
        delta,
        width: 128,
        height: 96,
        shader: wgsl,
        draw: originalDraw,
        view: view && { id: view.id, camera, viewport: view.rect, scissor: view.scissor, index: view.index },
        viewIndex: view?.index ?? 0,
        viewClear: view?.clear,
      });
      c.descriptor.vertex = { buffers: [] };
      c.descriptor.multisample = { count: samples };
      graph.execute(c);
    },
  };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    await TransformStore.create(32),
    renderer,
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  if (background !== undefined) engine.scene.background = background;
  const picker = Picking.attach(engine, { capture });
  return {
    engine,
    picker,
    draws,
    copies,
    view(values = {}) {
      return { camera: engine.camera, viewport: [0, 0, 1, 1], clear: { color: '#000000', depth: true }, ...values };
    },
    async primaryCopyWidth() {
      // Query the documented hook's primary-cache policy directly: an implicit
      // Engine.pick after selected beauty can reject outside that view or must
      // use micro regardless of whether a forward cache was retained.
      assert.equal(await picker.onPick(64, 48), null);
      return copies.at(-1).source.texture.width;
    },
    close() {
      engine.dispose();
      h.cleanup();
    },
  };
}

for (const background of [undefined, '#102030'])
  test('capture qualifies ordinary primary with background ' + background, async () => {
    const h = await harness({ background });
    try {
      h.engine.render({ delta: 0 });
      assert.equal(h.draws.length, 1);
      assert.equal(h.draws[0].extraMRT, 1);
      assert.equal(await h.primaryCopyWidth(), 128);
      assert.equal(h.engine.scene.background, background);
    } finally {
      h.close();
    }
  });

for (const scissor of [undefined, [0, 0, 1, 1]])
  test('full first view retains capture with scissor ' + scissor, async () => {
    const h = await harness();
    try {
      h.engine.render({ views: [h.view({ scissor })], delta: 0 });
      assert.equal(h.draws.length, 1);
      assert.equal(h.draws[0].extraMRT, 1);
      // Direct hook checks cache eligibility independent of the selected-view
      // public pick, which intentionally uses micro for every chosen request.
      assert.equal(await h.picker.onPick(64, 48), null);
      assert.equal(h.copies.at(-1).source.texture.width, 128);
    } finally {
      h.close();
    }
  });

for (const values of [{ viewport: [0, 0, 0.5, 1] }, { scissor: [0.25, 0, 0.5, 1] }])
  test('partial effective view forwards beauty without ID attachment ' + JSON.stringify(values), async () => {
    const h = await harness();
    try {
      assert.doesNotThrow(() => h.engine.render({ views: [h.view(values)], delta: 0 }));
      assert.equal(h.draws.length, 1);
      assert.equal(h.draws[0].extraMRT, 0);
      assert.equal(await h.primaryCopyWidth(), 3);
    } finally {
      h.close();
    }
  });

test('later full view invalidates forward cache without rejecting the locally safe first full view', async () => {
  const h = await harness();
  try {
    h.engine.render({ views: [h.view({ id: 'first' }), h.view({ id: 'later' })], delta: 0 });
    assert.deepEqual(
      h.draws.map((x) => x.extraMRT),
      [1, 0],
    );
    assert.equal(await h.primaryCopyWidth(), 3);
  } finally {
    h.close();
  }
});

for (const options of [
  { viewport: [64, 0, 64, 96] },
  { scissor: [32, 0, 64, 96] },
  { viewport: [64, 0, 64, 96], clear: false, clearDepth: false },
])
  test('unsafe DrawOptions after full capture stays exact and invalidates IDs ' + JSON.stringify(options), async () => {
    const h = await harness({ background: '#102030' });
    const frozen = structuredClone(options);
    h.engine.frameGraph.add({
      name: 'caller-draw-after-main',
      order: 0.005,
      execute(c) {
        c.draw(options);
      },
    });
    try {
      assert.doesNotThrow(() => h.engine.render({ delta: 0 }));
      assert.equal(h.draws.length, 2);
      assert.equal(h.draws[0].extraMRT, 1);
      assert.equal(h.draws[1].extraMRT, 0);
      assert.equal(h.draws[1].options, options, 'forward caller object exactly once');
      assert.deepEqual(options, frozen, 'keep requested clear/depth and rectangle unchanged');
      assert.equal(await h.primaryCopyWidth(), 3);
    } finally {
      h.close();
    }
  });

test('unsafe draw latches eligibility off through a later full draw and recovers next ordinary frame', async () => {
  const h = await harness({ background: '#102030' });
  const options = { viewport: [64, 0, 64, 96], clear: false, clearDepth: false };
  const remove = h.engine.frameGraph.add({
    name: 'caller-draw-before-main',
    order: -0.5,
    execute(c) {
      c.draw(options);
    },
  });
  try {
    assert.doesNotThrow(() => h.engine.render({ delta: 0 }));
    assert.deepEqual(
      h.draws.map((x) => x.extraMRT),
      [0, 0],
    );
    assert.equal(h.draws[0].options, options);
    assert.equal(await h.primaryCopyWidth(), 3);
    remove();
    h.draws.length = 0;
    h.engine.render({ delta: 0 });
    assert.equal(h.draws[0].extraMRT, 1);
    assert.equal(await h.primaryCopyWidth(), 128);
  } finally {
    h.close();
  }
});

test('full DrawOptions override remains capture eligible', async () => {
  const h = await harness({ background: '#102030' });
  h.engine.frameGraph.add({
    name: 'caller-full-draw',
    order: 0.005,
    execute(c) {
      c.draw({ viewport: [0, 0, 128, 96], scissor: [0, 0, 128, 96] });
    },
  });
  try {
    h.engine.render({ delta: 0 });
    assert.deepEqual(
      h.draws.map((x) => x.extraMRT),
      [1, 1],
    );
    assert.equal(await h.primaryCopyWidth(), 128);
  } finally {
    h.close();
  }
});

for (const settings of [{ capture: false }, { samples: 4 }])
  test('feature-off and MSAA preserve partial beauty and micro ' + JSON.stringify(settings), async () => {
    const h = await harness(settings);
    try {
      assert.doesNotThrow(() => h.engine.render({ views: [h.view({ viewport: [0, 0, 0.5, 1] })], delta: 0 }));
      assert.equal(h.draws[0].extraMRT, 0);
      assert.equal(await h.primaryCopyWidth(), 3);
    } finally {
      h.close();
    }
  });
