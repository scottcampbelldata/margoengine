import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore, box } from '../../packages/core/dist/extension.js';
import { validateSplats } from '../../packages/splats/dist/index.js';
import { optionalGPU } from '../../tests/support/optional-gpu.js';
import { wgsl } from '../../packages/core/src/shaders.ts';
import { createWorkload as animator } from './animator.js';
import { createWorkload as taa } from './taa.js';
import { createWorkload as text } from './text.js';
import { createWorkload as splats } from './splats.js';
import { createWorkload as blender } from './blender.js';
import { TAA } from '../../packages/taa/dist/index.js';

const local = { fetch: async (url) => new Response(await readFile(url), { status: 200 }) };
async function fixture(t, workload, count, extraCapacity = 0) {
  const dom = new JSDOM('<canvas width="800" height="600"></canvas><section></section>'),
    canvas = dom.window.document.querySelector('canvas'),
    parent = dom.window.document.querySelector('section'),
    h = optionalGPU();
  const savedStage = Object.getOwnPropertyDescriptor(globalThis, 'GPUShaderStage');
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  Object.defineProperties(canvas, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  h.engine.gpu.limits.maxTextureDimension2D = 8192;
  h.engine.gpu.limits.maxTextureArrayLayers = 256;
  h.engine.gpu.createBindGroupLayout = (d) => d;
  h.engine.gpu.createPipelineLayout = (d) => d;
  const store = await TransformStore.create((workload.capacity ?? count) + extraCapacity),
    renderer = {
      backend: 'webgpu',
      gpu: h.engine.gpu,
      add() {},
      remove() {},
      geometryBuffers() {
        return null;
      },
      dispose() {},
      render(camera, lighting, batches, graph, delta) {
        h.context.camera = camera;
        h.context.delta = delta;
        h.context.width = 800;
        h.context.height = 600;
        h.context.shader = wgsl;
        h.context.bindings = [];
        graph.execute(h.context);
      },
    };
  const engine = new Engine(
    canvas,
    store,
    renderer,
    { position: [0, 6, 8], target: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    null,
  );
  const meshes = Array.from({ length: count }, () => engine.createMesh().setGeometry(box(0.22, 0.22, 0.22)));
  const paint = () =>
    meshes.forEach((mesh, i) => {
      mesh.position.set(...workload.points.subarray(i * 4, i * 4 + 3));
      if (workload.yaw) mesh.rotation.y = workload.yaw[i];
    });
  const render = (delta = 0) => {
    workload.step(delta);
    paint();
    engine.render({ delta, culling: false });
    return true;
  };
  const context = { engine, meshes, parent, stage: canvas.parentElement, render };
  workload.step(0);
  paint();
  t.after(() => {
    workload.dispose();
    engine.dispose();
    h.cleanup();
    dom.window.close();
    if (savedStage) Object.defineProperty(globalThis, 'GPUShaderStage', savedStage);
    else delete globalThis.GPUShaderStage;
  });
  return { ...h, engine, meshes, parent, dom, render, context, passContext: h.context };
}

test('Animator demo parses real skinned robots, blends clips/transitions and uses a real masked additive layer', async (t) => {
  const w = await animator(2, local),
    h = await fixture(t, w, 2);
  w.mount(h.context);
  h.render(0);
  assert.equal(w.capacity, 152);
  assert.equal(w.renderedObjects, 38);
  assert.equal(w.models.length, 2);
  assert.equal(w.models[0].nodes.length, 74);
  assert.equal(w.models[0].primitives.length, 19);
  assert.equal(w.animators.length, 2);
  assert.equal(h.engine.meshes.size, 152);
  assert.ok(h.meshes.every((mesh) => mesh.geometry === null));
  assert.ok(w.animations.every((animation) => !animation.playing));
  const parentIds = w.models.map((model) => h.engine.store.parents[model.root.id]);
  assert.deepEqual(
    parentIds,
    h.meshes.map((mesh) => mesh.id),
  );
  const before = h.engine.store.transforms.qx.slice();
  for (let i = 0; i < 25; i++) h.render(0.1);
  assert.notDeepEqual(h.engine.store.transforms.qx, before);
  h.parent.querySelector('[data-ui-animator-rest]').click();
  assert.ok(w.animators.every((controller) => controller.state === 'rest'));
  h.parent.querySelector('[data-ui-animator-wave]').click();
  assert.equal(w.details().waveWeight, 0.3);
  assert.equal(w.details().registeredWaveLayers, 2);
  const state = w.details(),
    names = [...w.models, ...w.animations, ...w.animators].map((plugin) => plugin.name);
  w.dispose();
  w.dispose();
  w.step(0.1);
  assert.equal(w.details().frames, state.frames);
  assert.ok(names.every((name) => !h.engine.hasPlugin(name)));
  assert.equal(h.engine.meshes.size, 2);
  assert.equal(h.parent.children.length, 0);
  assert.ok(h.resources.every((resource) => resource.destroyed));
});

test('TAA demo registers actual animated PBR vertex sources and toggles/reset history without losing models', async (t) => {
  const controller = new AbortController(),
    w = await taa(1, { ...local, signal: controller.signal }),
    h = await fixture(t, w, 1);
  w.mount(h.context);
  h.render(1 / 60);
  assert.equal(w.details().registeredVelocityModels, 1);
  assert.equal(w.models[0].primitives.length, 19);
  assert.ok(w.models[0].primitives.some((primitive) => primitive.deformed));
  const camera = h.engine.camera,
    snapshot = camera.matrix.slice();
  h.render(0);
  assert.equal(h.passContext.camera, camera);
  assert.deepEqual(camera.matrix, snapshot);
  h.parent.querySelector('[data-ui-taa-reset]').click();
  assert.equal(w.details().manualHistoryResets, 1);
  const weight = h.parent.querySelector('[data-ui-taa-weight]');
  weight.value = '0.7';
  weight.dispatchEvent(new h.dom.window.Event('change'));
  assert.equal(w.details().historyWeight, 0.7);
  h.parent.querySelector('[data-ui-taa]').click();
  assert.equal(h.engine.hasPlugin('taa'), false);
  assert.equal(w.models[0].disposed, false);
  h.parent.querySelector('[data-ui-taa]').click();
  assert.equal(h.engine.hasPlugin('taa'), true);
  assert.equal(w.details().historyWeight, 0.7);
  controller.abort();
  assert.equal(h.engine.hasPlugin('taa'), false);
  assert.ok(w.models.every((model) => model.disposed));
  assert.equal(h.parent.children.length, 0);
  assert.ok(h.resources.every((resource) => resource.destroyed));
});

test('Real static and deformed PBR vertices retain required TAA storage usage after restoration', async (t) => {
  const w = await animator(1, local),
    h = await fixture(t, w, 1);
  w.mount(h.context);
  const effect = TAA.attach(h.engine),
    unregister = effect.add(w.models[0]);
  t.after(() => {
    unregister();
    effect.dispose();
  });
  h.render(1 / 60);
  const required = GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const sources = () => {
    const deformed = new Set(w.models[0].primitives.map((primitive) => primitive.deformed).filter(Boolean)),
      primitives = w.models[0].shadowPrimitives;
    assert.equal(primitives.length, 19);
    assert.ok(primitives.some((primitive) => deformed.has(primitive.vertex)));
    assert.ok(primitives.some((primitive) => !deformed.has(primitive.vertex)));
    assert.ok(primitives.every((primitive) => (primitive.vertex.usage & required) === required));
    return primitives.map((primitive) => primitive.vertex);
  };
  const before = sources();
  w.models[0].onDeviceRestored(h.engine);
  w.animations[0].onDeviceRestored(h.engine);
  effect.onDeviceRestored(h.engine);
  h.render(1 / 60);
  const after = sources();
  assert.ok(before.every((buffer) => buffer.destroyed));
  assert.ok(after.every((buffer) => !before.includes(buffer)));
  assert.equal(h.passContext.camera, h.engine.camera);
});

test('Text demo exercises real Text layout/renderer/atlas ownership and bounded fixed-length string updates', async (t) => {
  const w = text(4),
    glyphs = new Map();
  // Unit-only font measurer/rasterizer; browser acceptance must use the real local canvas font.
  w.font.load = async () => {};
  w.font.advance = () => 0.6;
  w.font.kerning = () => 0;
  w.font.metrics = () => ({ ascent: 0.8, descent: 0.2 });
  w.font.glyph = (cluster) => {
    if (/\s/u.test(cluster)) return null;
    if (!glyphs.has(cluster))
      glyphs.set(cluster, {
        cluster,
        width: 4,
        height: 6,
        left: 0,
        top: 5,
        color: false,
        data: new Uint8Array(24).fill(220),
      });
    return glyphs.get(cluster);
  };
  const h = await fixture(t, w, 4);
  await w.mount(h.context);
  h.render(0);
  assert.equal(w.texts.length, 4);
  assert.equal(w.texts[0].layout.lines.length, 2);
  assert.equal(w.details().textDrawCalls, 4);
  assert.ok(w.details().atlasGlyphs > 0);
  assert.equal(w.expectedEngineVisible, 4);
  const arrays = w.points,
    block = w.texts[0],
    length = block.text.length,
    buffers = h.counts.buffers;
  for (let i = 0; i < 12; i++) h.render(0.1);
  assert.equal(w.points, arrays);
  assert.equal(block.text.length, length);
  assert.match(block.text, /Time 01/);
  assert.equal(h.counts.buffers, buffers, 'Same-sized labels recreated glyph buffers');
  h.parent.querySelector('[data-ui-text-outline]').click();
  assert.equal(block.outlineWidth, 0);
  assert.equal(block.shadowOpacity, 0);
  w.dispose();
  assert.equal(h.engine.hasPlugin('text'), false);
  assert.ok(h.resources.every((resource) => resource.destroyed));
});

test('Text asynchronous font mount cannot publish GPU resources after page cancellation', async (t) => {
  const controller = new AbortController(),
    w = text(4, { signal: controller.signal }),
    h = await fixture(t, w, 4);
  let finish;
  w.font.load = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const before = h.resources.length,
    mounting = w.mount(h.context);
  controller.abort();
  finish();
  await assert.rejects(mounting, (error) => error.name === 'AbortError');
  assert.equal(h.resources.length, before);
  assert.equal(h.engine.hasPlugin('text'), false);
  assert.equal(h.parent.children.length, 0);
});

test('Splats demo draws one real combined anisotropic Gaussian cloud, SH toggles and resize-safe camera orbit', async (t) => {
  const w = await splats(2, local),
    h = await fixture(t, w, 2);
  w.mount(h.context);
  h.render(0);
  assert.equal(validateSplats(w.data), 794);
  assert.equal(w.cloud.count, 794);
  assert.equal(w.details().independentSorts, 1);
  assert.equal(w.expectedEngineVisible, 0);
  assert.ok(h.meshes.every((mesh) => mesh.geometry === null));
  assert.ok(w.data.covariances.some((value, i) => i % 6 === 1 && value !== 0));
  assert.equal(w.cloud.gpuState.sorted.size, 794 * 8);
  const input = w.data.positions.slice(),
    before = h.engine.camera.position.slice(),
    buffers = h.counts.buffers;
  for (let i = 0; i < 4; i++) h.render(0.1);
  assert.notDeepEqual(h.engine.camera.position, before);
  assert.deepEqual(w.data.positions, input);
  assert.equal(h.counts.buffers, buffers);
  const resized = [3, 7, 11];
  h.engine.camera.position = resized;
  h.render(0.1);
  assert.notEqual(h.engine.camera.position, resized);
  assert.notDeepEqual(h.engine.camera.position, resized);
  const old = w.cloud;
  h.parent.querySelector('[data-ui-splats-sh]').click();
  assert.equal(w.details().viewDependentColor, true);
  assert.notEqual(w.cloud, old);
  assert.equal(w.cloud.count, 794);
  const name = w.cloud.name,
    frames = w.details().frames;
  w.dispose();
  w.step(0.1);
  assert.equal(w.details().frames, frames);
  assert.equal(h.engine.hasPlugin(name), false);
  assert.ok(h.resources.every((resource) => resource.destroyed));
  assert.equal(h.parent.children.length, 0);
});

test('Robot construction failure and bounded factory validation release owned partial scene state', async (t) => {
  const w = await animator(1, local),
    h = await fixture(t, w, 1, -1);
  h.engine.store.grow = () => {
    throw new Error('Transform allocation');
  };
  assert.throws(() => w.mount(h.context), /Transform allocation/);
  assert.equal(h.engine.meshes.size, 1);
  assert.ok(h.resources.every((resource) => resource.destroyed));
  for (const factory of [animator, taa])
    for (const count of [0, 5, 1.5]) await assert.rejects(factory(count, local), /count/);
  for (const count of [0, 10, 1.5]) await assert.rejects(splats(count, local), /count/);
  for (const count of [3, 65, 4.5]) assert.throws(() => text(count), /count/);
});

test('Blender demo loads the checked .margo texture/shared geometry/mirrored transforms and bounds decode work', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  let closed = 0;
  globalThis.createImageBitmap = async () => ({
    width: 2,
    height: 2,
    close() {
      closed++;
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'createImageBitmap', original);
    else delete globalThis.createImageBitmap;
  });
  const w = await blender(2, local),
    h = await fixture(t, w, 2);
  h.engine.gpu.queue.copyExternalImageToTexture = () => {
    h.counts.uploads++;
  };
  h.engine.gpu.createCommandEncoder = () => ({ ...h.passContext.encoder, finish: () => ({}) });
  h.engine.gpu.queue.submit = () => {};
  await w.mount(h.context);
  h.render(0);
  assert.equal(w.capacity, 8);
  assert.equal(w.renderedObjects, 4);
  assert.equal(h.engine.stats.visible, 4);
  assert.ok(
    w.models.every((model) =>
      model.shadowPrimitives.every(
        (primitive) =>
          (primitive.vertex.usage & (GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE)) ===
          (GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE),
      ),
    ),
    'Prepared .margo vertices must satisfy the same TAA storage contract',
  );
  assert.equal(w.models.length, 2);
  assert.equal(w.models[0].primitives.length, 2);
  assert.equal(w.models[0].primitives[0].vertices, w.models[0].primitives[1].vertices);
  assert.equal(w.models[0].primitives[0].indices, w.models[0].primitives[1].indices);
  assert.deepEqual(w.models[0].asset.doc.nodes[1].scale, [-1, 1, 1]);
  assert.ok(h.meshes.every((mesh) => mesh.geometry === null));
  const buffers = h.counts.buffers;
  for (let i = 0; i < 12; i++) h.render(0.1);
  assert.equal(w.details().decodedJobs, 2);
  assert.equal(h.counts.buffers, buffers);
  w.dispose();
  w.dispose();
  assert.equal(h.engine.meshes.size, 2);
  assert.equal(closed, 2);
  assert.ok(h.resources.every((resource) => resource.destroyed));
});

test('Blender late image decode after page cancellation cannot attach a model', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  let finish,
    closed = 0;
  globalThis.createImageBitmap = () =>
    new Promise((resolve) => {
      finish = () =>
        resolve({
          width: 2,
          height: 2,
          close() {
            closed++;
          },
        });
    });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'createImageBitmap', original);
    else delete globalThis.createImageBitmap;
  });
  const controller = new AbortController(),
    w = await blender(1, { ...local, signal: controller.signal }),
    h = await fixture(t, w, 1),
    mounting = w.mount(h.context);
  controller.abort();
  finish();
  await assert.rejects(mounting, (error) => error.name === 'AbortError');
  assert.equal(w.models.length, 0);
  assert.equal(closed, 1);
  assert.equal(h.engine.meshes.size, 1);
  for (const count of [0, 10, 1.5]) await assert.rejects(blender(count, local), /count/);
});
