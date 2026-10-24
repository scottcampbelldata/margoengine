// Picking inside a chosen view: its camera, rectangle, scissor and layers. CPU recorder; IDs are not read back.
import assert from 'node:assert/strict';
import test from 'node:test';
const { Engine, Camera, TransformStore, box } = await import(
  process.env.MARGO_SOURCE_TEST ? '../../core/src/extension.ts' : '../../core/dist/extension.js'
);
const { Picking } = await import(process.env.MARGO_SOURCE_TEST ? '../src/index.ts' : '../dist/index.js');
import { Models } from '../src/models.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/dist/shaders.js';
import { setRenderLayers } from '../../cameras/dist/layers.js';

async function setup({ width = 200, height = 100, cssWidth = width, cssHeight = height, capture = false } = {}) {
  const h = optionalGPU(),
    device = h.engine.gpu,
    encoder = h.context.encoder;
  const writes = [],
    copies = [],
    geometry = new Map();
  const write = device.queue.writeBuffer;
  device.queue.writeBuffer = (buffer, offset, values) => {
    writes.push({ buffer, values: [...values] });
    return write(buffer, offset, values);
  };
  encoder.finish = () => ({});
  encoder.copyTextureToBuffer = (source, target, extent) => {
    copies.push({ source, extent });
    new Uint32Array(target.buffer.data).fill(0);
  };
  device.createCommandEncoder = () => encoder;
  device.queue.submit = () => {};
  const renderer = {
    backend: 'webgpu',
    gpu: device,
    add(g) {
      geometry.set(g, {
        vertex: device.createBuffer({ size: g.vertices.byteLength, usage: 32 }),
        index: device.createBuffer({ size: g.indices.byteLength, usage: 16 }),
      });
    },
    geometryBuffers: (g) => geometry.get(g),
    remove() {},
    render() {},
    dispose() {},
  };
  const engine = new Engine(
    { width, height, clientWidth: cssWidth, clientHeight: cssHeight },
    await TransformStore.create(128),
    renderer,
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const picker = Picking.attach(engine, { capture });
  const prepare = (camera) => {
    camera.update(width / height, true);
    engine.store.planes.set(camera.planes);
    engine.store.tick(false);
  };
  prepare(engine.camera);
  return {
    engine,
    picker,
    h,
    writes,
    copies,
    prepare,
    frame(camera = engine.camera, view) {
      prepare(camera);
      const c = h.context;
      Object.assign(c, { camera, width, height, shader: wgsl, view, draw() {} });
      c.descriptor.vertex = { buffers: [] };
      c.descriptor.multisample = { count: 1 };
      engine.frameGraph.execute(c);
    },
    finish() {
      engine.dispose();
      h.cleanup();
    },
  };
}
function expectedMicro(camera, rect, x, y) {
  const values = new Float32Array(camera.matrix),
    nx = (2 * (x - rect[0] + 0.5)) / rect[2] - 1,
    ny = 1 - (2 * (y - rect[1] + 0.5)) / rect[3];
  for (let c = 0; c < 4; c++) {
    values[c * 4] = ((values[c * 4] - nx * values[c * 4 + 3]) * rect[2]) / 3;
    values[c * 4 + 1] = ((values[c * 4 + 1] - ny * values[c * 4 + 3]) * rect[3]) / 3;
  }
  return [...values];
}

const cases = [
  { id: 'primary-full-control' },
  { id: 'alternate-camera-explicit', camera: { position: [4, 0, 0], target: [0, 0, 0] }, viewport: [0, 0, 1, 1] },
  { id: 'primary-fractional-right-half', viewport: [0.5, 0, 0.5, 1], input: [150, 50] },
  { id: 'primary-pixel-rectangle', viewport: [40, 10, 120, 80], pixels: true },
  {
    id: 'alternate-camera-implicit-render-view',
    camera: { position: [4, 0, 0], target: [0, 0, 0] },
    viewport: [0, 0, 1, 1],
    implicit: true,
  },
  { id: 'all-layers', geometry: true, viewport: [0, 0, 1, 1] },
  { id: 'layer-one', geometry: true, viewport: [0, 0, 1, 1], layers: 1 },
  { id: 'layer-two', geometry: true, viewport: [0, 0, 1, 1], layers: 2 },
];
for (const spec of cases)
  test('public chosen-view submitted commands: ' + spec.id, async () => {
    const s = await setup();
    let hook;
    const onPick = s.picker.onPick.bind(s.picker);
    s.picker.onPick = (...args) => {
      const camera = args[2]?.camera ?? s.engine.camera;
      hook = { camera: { matrix: camera.matrix.slice(), position: [...camera.position] } };
      return onPick(...args);
    };
    try {
      const camera = spec.camera ? new Camera(spec.camera) : s.engine.camera;
      let background, foreground;
      if (spec.geometry) {
        const geometry = box(0.25, 0.25, 0.25);
        background = s.engine.createMesh().setGeometry(geometry).setPosition([0, 0, -0.5]);
        setRenderLayers(background, 1);
        foreground = s.engine.createMesh().setGeometry(geometry).setPosition([0, 0, 0.5]);
        setRenderLayers(foreground, 2);
      }
      const view = spec.viewport
        ? { camera, viewport: spec.viewport, pixels: spec.pixels, layers: spec.layers }
        : undefined;
      if (spec.implicit) s.engine.render({ views: [view], delta: 0 });
      const [x, y] = spec.input ?? [100, 50];
      assert.equal(await s.engine.pick(x, y, spec.implicit ? undefined : view), null);
      const rect = spec.viewport
        ? spec.viewport.map((v, i) => (spec.pixels ? v : v * (i % 2 ? 100 : 200)))
        : [0, 0, 200, 100];
      const frame = s.writes.findLast((w) => w.buffer.size === 128 && w.values.length === 32).values;
      assert.deepEqual(frame.slice(0, 16), expectedMicro(hook.camera, rect, x, y));
      assert.deepEqual(frame.slice(16, 19), hook.camera.position);
      if (spec.geometry) {
        const ids = s.writes
          .filter((w) => w.buffer.usage === 40)
          .flatMap((w) => Array.from({ length: w.values.length / 24 }, (_, i) => w.values[i * 24 + 23]));
        const expected = [background, foreground]
          .filter((m, i) => spec.layers === undefined || (spec.layers & (i + 1)) !== 0)
          .map((m) => m.id);
        assert.deepEqual(ids.sort(), expected.sort());
      }
    } finally {
      s.finish();
    }
  });

const edges = [
  ['left', 128, 128, [128, 127], [2, 3]],
  ['right', 255, 128, [254, 127], [2, 3]],
  ['top', 192, 64, [191, 64], [3, 2]],
  ['bottom', 192, 191, [191, 190], [3, 2]],
  ['top-left', 128, 64, [128, 64], [2, 2]],
  ['top-right', 255, 64, [254, 64], [2, 2]],
  ['bottom-left', 128, 191, [128, 190], [2, 2]],
  ['bottom-right', 255, 191, [254, 190], [2, 2]],
];
for (const [name, x, y, start, extent] of edges)
  test('selected viewport/scissor copy window: ' + name, async () => {
    const s = await setup({ width: 256, height: 256 });
    try {
      const view = {
        camera: s.engine.camera,
        scene: s.engine.scene,
        viewport: [128, 0, 128, 256],
        scissor: [128, 64, 128, 128],
        pixels: true,
      };
      assert.equal(await s.picker.onPick(x, y, view), null);
      const copy = s.copies.at(-1);
      assert.deepEqual(copy.extent, extent);
      assert.deepEqual(copy.source.origin, [1 + start[0] - x, 1 + start[1] - y]);
    } finally {
      s.finish();
    }
  });

test('direct chosen-view call snapshots alternate eye and uses drawing pixels once under DPR2', async () => {
  const s = await setup({ width: 256, height: 256, cssWidth: 128, cssHeight: 128 });
  try {
    const camera = new Camera({ position: [4, 0, 0], target: [0, 0, 0] });
    camera.update(0.5, true);
    const before = { matrix: camera.matrix.slice(), position: [...camera.position] };
    const pending = s.picker.onPick(96, 64, {
      camera,
      viewport: [128, 0, 128, 256],
      scene: s.engine.scene,
      pixels: true,
    });
    camera.position[0] = 8;
    camera.update(0.5, true);
    assert.equal(await pending, null);
    const frame = s.writes.findLast((w) => w.buffer.size === 128 && w.values.length === 32).values;
    assert.deepEqual(frame.slice(0, 16), expectedMicro(before, [128, 0, 128, 256], 192, 128));
    assert.deepEqual(frame.slice(16, 19), before.position);
  } finally {
    s.finish();
  }
});

for (const background of [undefined, '#123456'])
  test('primary1x forward IDs stay qualified with background ' + background, async () => {
    const s = await setup({ capture: true });
    try {
      s.engine.scene.background = background;
      s.engine.createMesh().setGeometry(box());
      s.frame(
        s.engine.camera,
        background === undefined
          ? undefined
          : { id: 'default', camera: s.engine.camera, viewport: [0, 0, 200, 100], index: 0 },
      );
      assert.equal(await s.picker.onPick(100, 50), null);
      assert.equal(s.copies.at(-1).source.texture.width, 200);
    } finally {
      s.finish();
    }
  });

test('Models cache separates actual graphs with equal revision and unchanged mesh count', async () => {
  const s = await setup(),
    cache = new Models(),
    a = s.engine.createScene('a'),
    b = s.engine.createScene('b');
  const models = [];
  try {
    for (const scene of [a, b]) scene.use({ name: 'model', root: scene.createMesh(), primitives: [], setup() {} });
    assert.equal(a.frameGraph.revision, b.frameGraph.revision);
    for (const scene of [a, b, a])
      scene.use({
        name: 'read-' + models.length,
        setup(e) {
          models.push(cache.update(e).slice());
        },
      });
    assert.equal(models[0][0].root.scene, a);
    assert.equal(models[1][0].root.scene, b);
    assert.equal(models[2][0].root.scene, a);
  } finally {
    s.finish();
  }
});

test('a chosen view uses micro IDs even after a qualified primary forward capture', async () => {
  const s = await setup({ capture: true });
  try {
    s.engine.createMesh().setGeometry(box());
    s.frame();
    await s.picker.onPick(100, 50);
    assert.equal(s.copies.at(-1).source.texture.width, 200);
    await s.engine.pick(100, 50, { camera: s.engine.camera, viewport: [0, 0, 1, 1] });
    assert.equal(s.copies.at(-1).source.texture.width, 3);
  } finally {
    s.finish();
  }
});
