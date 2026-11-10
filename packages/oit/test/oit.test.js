import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import { extendedMaterials } from '../../gltf-pro/dist/extended.js';
import { Material, Texture, createMesh } from '../../materials/dist/index.js';
import { OIT } from '../dist/index.js';
import { addMesh } from '../dist/meshes.js';
import { ExactOIT } from '../dist/exact.js';
import { PeelOIT } from '../dist/peel.js';
import { PreciseOIT } from '../dist/precise.js';
import { MomentOIT } from '../dist/moments.js';
import { TransparentDepth } from '../dist/depth.js';
import { addEffect } from '../dist/vfx.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';

// Opaque, BLEND, BLEND + transmission (keeps the sorted path) and BLEND + clearcoat (physical variant).
const materials = [
  {},
  { alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.5] } },
  { alphaMode: 'BLEND', extensions: { KHR_materials_transmission: { transmissionFactor: 0.5 } } },
  {
    alphaMode: 'BLEND',
    pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 0.4] },
    extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1 } },
  },
];
async function scene(samples = 4) {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    renderer,
    { position: [0, 0, 6], target: [0, 0, 0] },
    null,
  );
  const fixture = animatedTriangle(),
    primitive = fixture.doc.meshes[0].primitives[0];
  Object.assign(fixture.doc, {
    materials,
    extensionsUsed: ['KHR_materials_transmission', 'KHR_materials_clearcoat'],
    meshes: materials.map((_, material) => ({ primitives: [{ ...primitive, material }] })),
    nodes: materials.map((_, mesh) => ({ mesh, translation: [0, 0, -mesh] })),
  });
  delete fixture.doc.skins;
  delete fixture.doc.animations;
  // These cases exercise the optional physical transmission/clearcoat renderer.
  const model = parseGLTF(engine, fixture.doc, fixture.buffers, [], { materials: extendedMaterials });
  engine.camera.update(4 / 3, true);
  store.tick(false);
  const view = context(gpu, { samples, format: 'bgra8unorm', depthFormat: 'depth32float-stencil8' });
  Object.defineProperty(view, 'captureColor', {
    get: () => engine.plugins.get('materials:native-glass')?.colorView ?? view.c.color,
  });
  const frame = (n) =>
    gpu.record(() => {
      view.begin(n);
      engine.frameGraph.execute(view.c);
    });
  return { gpu, engine, model, view, frame, id: (value) => gpu.snap(value) };
}
const of = (log, name) => log.filter((e) => e[0] === name);
// The native glass adapter owns its copy/resolve/presentation passes, checked in materials' regression.
// These assertions retain the complete gltf-pro geometry and OIT pass sequence.
const passes = (log) =>
  of(log, 'beginRenderPass')
    .map((e) => e[1])
    .filter((p) => !p.label?.startsWith('native-glass:'));
const draws = (log) => of(log, 'pass.drawIndexed').length;

test('precise accumulation keeps all four sums in float32 at 1x and 4x without a hardware resolve', async () => {
  for (const samples of [1, 4]) {
    const { engine, model, gpu, frame } = await scene(samples);
    gpu.device.features.add('float32-blendable');
    const oit = PreciseOIT.attach(engine);
    oit.add(model);
    const log = frame(0),
      pass = passes(log).find((p) => p.label === 'oit:precise:accumulate');
    assert.equal(pass.colorAttachments.length, 5);
    assert.ok(pass.colorAttachments.every((p) => !p.resolveTarget));
    const textures = of(log, 'texture')
      .map((e) => e[2])
      .filter((t) => t.label?.startsWith('oit:precise:'));
    assert.deepEqual(
      textures.map((t) => [t.format, t.sampleCount]),
      [
        ['r32float', samples],
        ['r32float', samples],
        ['r32float', samples],
        ['r32float', samples],
        ['r16float', samples],
      ],
    );
    const module = of(log, 'module').find((e) => e[2].code.includes('var map0:'))[2].code;
    assert.equal(module.includes('texture_multisampled_2d'), samples === 4);
    assert.ok(module.includes('sum.rgb/max(sum.a'));
    await null;
    assert.equal(of(frame(1), 'texture').length, 0);
    oit.onDeviceRestored(engine);
    assert.equal(of(frame(2), 'texture').filter((e) => e[2].label?.startsWith('oit:precise:')).length, 5);
    oit.dispose();
    assert.ok(!passes(frame(3)).some((p) => p.label?.startsWith('oit:precise:')));
    engine.dispose();
  }
});

test('precise accumulation refuses unavailable capabilities before allocation and validates depth scale', async () => {
  for (const depthScale of [0, -1, NaN, Infinity]) assert.throws(() => new PreciseOIT({ depthScale }), RangeError);
  for (const kind of ['native-no-feature', 'four-targets', 'compat-no-extension', 'compat-full']) {
    const { engine, gpu } = await scene(1);
    if (kind === 'four-targets') {
      gpu.device.features.add('float32-blendable');
      gpu.device.limits.maxColorAttachments = 4;
    }
    if (kind.startsWith('compat')) {
      gpu.device.adapterInfo = { vendor: 'margo-webgl2' };
      gpu.device.adapter = { capabilities: { tier: 'full', extensions: { EXT_float_blend: kind === 'compat-full' } } };
    }
    const oit = new PreciseOIT();
    const log = gpu.record(() => {
      if (kind === 'compat-full') oit.setup(engine);
      else
        assert.throws(
          () => oit.setup(engine),
          (e) => e.code === 'unsupported' && e.message.includes('https://margoengine.com/errors#'),
        );
    });
    assert.equal(of(log, 'buffer').length, kind === 'compat-full' ? 1 : 0);
    oit.dispose();
    engine.dispose();
  }
});

test('depth peeling stores nearest layers privately and composites far to near against scene depth', async () => {
  const { engine, model, view, frame, id } = await scene(4),
    oit = PeelOIT.attach(engine, { layers: 3 });
  oit.add(model);
  const log = frame(0),
    list = passes(log),
    peeled = list.filter((p) => p.label === 'oit:peel');
  assert.equal(peeled.length, 3);
  assert.ok(peeled.every((p) => p.colorAttachments.length === 2 && p.depthStencilAttachment.depthClearValue === 0));
  const composite = list.at(-1);
  assert.equal(composite.label, 'oit:peel:resolve');
  assert.equal(composite.depthStencilAttachment.view, id(view.c.depth));
  const pipelines = of(log, 'renderPipeline').map((e) => e[2]);
  for (const p of pipelines.filter((p) => p.fragment.entryPoint === 'transparent')) {
    assert.equal(p.multisample.count, 1);
    assert.equal(p.depthStencil.depthWriteEnabled, true);
    assert.equal(p.depthStencil.format, 'depth32float');
    assert.deepEqual(p.fragment.targets, oit.targets);
  }
  const resolve = pipelines.find((p) => p.label === 'oit:peel:resolve');
  assert.equal(resolve.multisample.count, 4);
  assert.equal(resolve.depthStencil.depthWriteEnabled, false);
  assert.ok(of(log, 'module').some((e) => e[2].code.includes('clip.z>=previous')));
  assert.equal(of(log, 'computePipeline').length, 0);
  const effect = {
    setTransparency() {
      throw new Error('must not take over');
    },
    drawTransparent() {},
  };
  assert.throws(() => addEffect(oit, effect), /models only/);
  await null;
  const next = frame(1);
  assert.equal(of(next, 'texture').length, 0);
  assert.equal(of(next, 'renderPipeline').length, 0);
  oit.dispose();
  assert.ok(!passes(frame(2)).some((p) => p.label?.startsWith('oit:peel')));
  engine.dispose();
});

test('depth peeling validates options and accepts a full compatibility device without fragment storage', async () => {
  for (const layers of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => new PeelOIT({ layers }), RangeError);
  assert.equal(new PeelOIT().layers, 10);
  const { engine, gpu } = await scene(1);
  gpu.device.adapterInfo = { vendor: 'margo-webgl2' };
  const oit = PeelOIT.attach(engine);
  oit.dispose();
  assert.throws(() => oit.ready(), /disposed/);
  engine.dispose();
});

test('depth peeling resizes between views and recreates private resources after device restoration', async () => {
  const { engine, model, view, gpu } = await scene(1),
    oit = PeelOIT.attach(engine, { layers: 2 });
  oit.add(model);
  const log = gpu.record(() => {
    view.begin(0);
    view.c.view = { id: 'left', viewport: [0, 0, 64, 96], index: 0 };
    engine.frameGraph.execute(view.c);
    view.c.width = 256;
    view.c.height = 192;
    view.c.view = { id: 'right', viewport: [64, 0, 64, 96], index: 1 };
    engine.frameGraph.execute(view.c);
  });
  assert.equal(passes(log).filter((p) => p.label === 'oit:peel').length, 4);
  const textures = of(log, 'texture')
    .map((e) => e[2])
    .filter((t) => t.label?.startsWith('oit:peel:'));
  assert.equal(textures.length, 12, 'six private textures per view size');
  assert.deepEqual(textures.at(-1).size, [256, 192]);
  const restored = gpu.record(() => {
    oit.onDeviceRestored(engine);
    view.begin(1);
    engine.frameGraph.execute(view.c);
  });
  assert.equal(of(restored, 'texture').filter((e) => e[2].label?.startsWith('oit:peel:')).length, 6);
  assert.ok(passes(restored).some((p) => p.label === 'oit:peel:resolve'));
  oit.dispose();
  engine.dispose();
});

test('BLEND primitives leave the beauty pass and accumulate into rgba16float + r16float, then one composite over the scene (MSAA 4x)', async () => {
  const { engine, model, view, frame, id } = await scene(4),
    oit = OIT.attach(engine);
  assert.throws(() => new OIT().add(model), /attach/);
  oit.add(model);
  const log = frame(0),
    list = passes(log);
  // Beauty: opaque in one pass, the transmission primitive in its own (sorted path); then accumulate and composite.
  assert.equal(list.length, 4);
  const [accumulate, composite] = list.slice(2);
  assert.equal(accumulate.label, 'oit:accumulate');
  assert.equal(accumulate.colorAttachments.length, 2);
  assert.deepEqual(
    accumulate.depthStencilAttachment,
    { view: id(view.c.depth), depthReadOnly: true, stencilReadOnly: true },
    'scene depth, read only',
  );
  for (const [i, clear] of [
    [0, [0, 0, 0, 0]],
    [1, [1, 0, 0, 0]],
  ]) {
    const a = accumulate.colorAttachments[i];
    assert.deepEqual(a.clearValue, clear);
    assert.equal(a.loadOp, 'clear');
    assert.equal(a.storeOp, 'discard');
    assert.ok(a.resolveTarget, 'MSAA resolves');
  }
  assert.equal(composite.label, 'oit:composite');
  assert.deepEqual(composite.colorAttachments, [{ view: id(view.captureColor), loadOp: 'load', storeOp: 'store' }]);
  assert.equal(composite.depthStencilAttachment, undefined);
  const textures = of(log, 'texture')
    .map((e) => e[2])
    .filter((t) => t.label?.startsWith('oit:'));
  assert.deepEqual(
    textures.map((t) => [t.format, t.sampleCount, t.size]),
    [
      ['rgba16float', 1, [1280, 720]],
      ['r16float', 1, [1280, 720]],
      ['rgba16float', 4, [1280, 720]],
      ['r16float', 4, [1280, 720]],
    ],
  );
  assert.equal(
    draws(log),
    4,
    'opaque + one linear-composited native glass draw in beauty, two BLEND primitives accumulated',
  );
  const pipelines = of(log, 'renderPipeline').map((e) => e[2]),
    transparent = pipelines.filter((p) => p.fragment.entryPoint === 'transparent');
  assert.equal(transparent.length, 2, 'standard and physical variants');
  for (const p of transparent) {
    assert.deepEqual(
      p.fragment.targets,
      oit.targets.map((t) => JSON.parse(JSON.stringify(t))),
    );
    assert.deepEqual(
      [p.depthStencil.depthWriteEnabled, p.depthStencil.depthCompare, p.multisample.count],
      [false, 'greater-equal', 4],
    );
  }
  const modules = of(log, 'module').map((e) => e[2].code),
    oitModules = modules.filter((code) => code.includes('@fragment fn transparent('));
  assert.equal(oitModules.length, 2);
  for (const code of oitModules)
    assert.ok(
      code.includes('fn margoShade(i:Out,front:bool)->vec4f {') &&
        code.includes('margoTransparent(margoShade(i,front),i)') &&
        code.includes('@binding(120)'),
    );
  assert.ok(modules.some((code) => code.includes('textureLoad(revealMap')));
  const compositePipeline = pipelines.find((p) => p.label === 'oit:composite');
  assert.deepEqual(compositePipeline.fragment.targets[0].blend, {
    alpha: { dstFactor: 'one-minus-src-alpha', srcFactor: 'one' },
    color: { dstFactor: 'one-minus-src-alpha', srcFactor: 'src-alpha' },
  });
  assert.equal(compositePipeline.multisample.count, 4);
  assert.equal(compositePipeline.fragment.targets[0].format, 'bgra8unorm');
  const groups = of(log, 'group').map((e) => e[2]);
  assert.ok(
    groups.some((g) => g.entries.length === 1 && g.entries[0].binding === 120),
    'weight uniform in group 2',
  );
  assert.ok(
    groups.some((g) => g.entries.length === 2 && g.entries[0].binding === 0 && g.entries[1].binding === 1),
    'composite reads the two resolved targets',
  );
  // Weight scale: 1 / |eye - target|.
  const scale = of(log, 'writeBuffer').find((e) => e[3].length === 32);
  assert.ok(
    Math.abs(
      new Float32Array(Uint8Array.from(Buffer.from(scale[3], 'hex')).buffer)[0] -
        1 / Math.hypot(...view.camera.position),
    ) < 1e-6,
  );
  // Steady frames create nothing.
  await null; // the next frame
  const next = frame(1);
  for (const name of ['texture', 'renderPipeline', 'group', 'module', 'view'])
    assert.equal(of(next, name).length, 0, name);
  assert.equal(passes(next).length, 4);
  assert.equal(engine.stats.drawCalls >= 4, true);
});

test('1x: targets drawn directly; nothing transparent visible: no OIT passes; dispose restores sorted blending', async () => {
  const { engine, model, frame } = await scene(1),
    oit = OIT.attach(engine, { depthScale: 2 });
  oit.add(model);
  oit.add(model);
  const log = frame(0),
    accumulate = passes(log)[2];
  assert.equal(of(log, 'texture').filter((e) => e[2].label?.startsWith('oit:')).length, 2);
  for (const a of accumulate.colorAttachments) {
    assert.equal(a.resolveTarget, undefined);
    assert.equal(a.storeOp, 'store');
  }
  assert.equal(
    new Float32Array(
      Uint8Array.from(Buffer.from(of(log, 'writeBuffer').find((e) => e[3].length === 32)[3], 'hex')).buffer,
    )[0],
    0.5,
    'fixed depthScale',
  );
  for (const i of [1, 3]) model.nodes[i].visible = false;
  const hidden = frame(1);
  assert.equal(passes(hidden).length, 2, 'no accumulate or composite when nothing transparent is drawn');
  assert.equal(draws(hidden), 2, 'opaque + one linear-composited native glass draw');
  for (const i of [1, 3]) model.nodes[i].visible = true;
  oit.dispose();
  assert.equal(engine.hasPlugin(oit.name), false);
  const sorted = frame(2);
  assert.equal(passes(sorted).length, 4, 'opaque pass + one pass per blended primitive');
  assert.equal(draws(sorted), 4, 'transmission composites in one draw');
  assert.ok(!passes(sorted).some((p) => p.label), 'no OIT passes');
  assert.throws(() => oit.add(model), /disposed/);
});

test('removing a model, disposing it, and materials meshes (normal blending via OIT, additive stays sorted)', async () => {
  const { engine, model, frame } = await scene(1),
    oit = OIT.attach(engine),
    remove = oit.add(model);
  remove();
  assert.equal(passes(frame(0)).length, 4, 'back to sorted blending');
  oit.add(model);
  model.dispose();
  assert.equal(passes(frame(1)).length, 0);
  const geometry = { positions: [-1, -1, 0, 1, -1, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };
  const glass = createMesh(engine, geometry, new Material({ color: [0.5, 0.8, 1], opacity: 0.4, transparent: true })),
    glow = createMesh(
      engine,
      geometry,
      new Material({ color: [1, 0.5, 0], opacity: 0.5, transparent: true, blending: 'additive' }),
    );
  oit.add(glass);
  oit.add(glow);
  const log = frame(2),
    list = passes(log);
  assert.deepEqual(
    list.map((p) => p.label),
    [undefined, 'oit:accumulate', 'oit:composite'],
    'additive in the materials pass, the glass in OIT',
  );
  assert.equal(of(log, 'renderPipeline').filter((e) => e[2].fragment.entryPoint === 'transparent').length, 1);
  assert.ok(
    // A material without maps draws materials' bare shader (constant texels, no texture reads).
    of(log, 'module').some(
      (e) => e[2].code.includes('s.base=vec4f(1)*f.base*i.color') && e[2].code.includes('@fragment fn transparent('),
    ),
    'materials text patch composes with the hook',
  );
  // A map assigned live: the glass samples it through the materials patch inside the OIT hook.
  glass.material.map = new Texture({ data: new Uint8Array(16).fill(200), width: 2, height: 2 }, { mipmaps: false });
  assert.ok(
    of(frame(2), 'module').some(
      (e) => e[2].code.includes('textureSample(mat_baseMap,') && e[2].code.includes('@fragment fn transparent('),
    ),
    'a textured material still samples its map in OIT',
  );
  glass.material.transparent = false;
  assert.deepEqual(
    passes(frame(3)).map((p) => p.label),
    [undefined],
    'opaque again: drawn by the materials pass, which the additive mesh continues',
  );
  assert.throws(() => model.setTransparency({}), TypeError);
});

test('two views in one frame keep their own depth scale', async () => {
  const { engine, model, view, gpu } = await scene(1),
    oit = OIT.attach(engine);
  oit.add(model);
  const scale = (hex) => new Float32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer)[0];
  const log = gpu.record(() => {
    view.begin(0);
    view.c.view = { id: 'near', viewport: [0, 0, 64, 96], index: 0 };
    engine.frameGraph.execute(view.c);
    view.c.view = { id: 'far', viewport: [64, 0, 64, 96], index: 1 };
    view.camera.position[2] *= 2;
    engine.frameGraph.execute(view.c);
  });
  const writes = of(log, 'writeBuffer').filter((e) => e[3].length === 32 && Math.abs(scale(e[3]) - 0.25) < 0.2);
  assert.equal(writes.length, 2, 'one depth-scale packet per view');
  assert.notEqual(writes[0][1], writes[1][1], 'the second view writes its own buffer slice');
  assert.ok(scale(writes[0][3]) > scale(writes[1][3]), 'the farther camera has the smaller inverse scale');
  oit.dispose();
});

test('addMesh refuses a mesh without geometry and an opacity outside 0 to 1', () => {
  assert.throws(() => addMesh({}, {}, { geometry: null }), /setGeometry/);
  assert.throws(() => addMesh({}, {}, { geometry: {} }, { opacity: 2 }), /opacity/);
});

test('ExactOIT: BLEND primitives go to the list pass with no colour targets, then one sort and one draw per layer over the scene', async () => {
  const { engine, model, view, frame, id } = await scene(4),
    oit = ExactOIT.attach(engine, { layers: 5 });
  assert.throws(() => new ExactOIT().add(model), /attach/);
  oit.add(model);
  const log = frame(0),
    list = passes(log);
  const [fill, resolve] = list.slice(2);
  assert.equal(fill.label, 'oit:list');
  assert.deepEqual(fill.colorAttachments, []);
  const readOnly = { view: id(view.c.depth), depthReadOnly: true, stencilReadOnly: true };
  assert.deepEqual(fill.depthStencilAttachment, readOnly, 'scene depth, read only');
  assert.equal(resolve.label, 'oit:resolve');
  assert.deepEqual(resolve.colorAttachments, [{ view: id(view.captureColor), loadOp: 'load', storeOp: 'store' }]);
  assert.deepEqual(resolve.depthStencilAttachment, readOnly, 'the hardware test drops hidden layers');
  const transparent = of(log, 'renderPipeline')
    .map((e) => e[2])
    .filter((p) => p.fragment.entryPoint === 'transparent');
  assert.ok(transparent.length);
  for (const p of transparent) assert.deepEqual(p.fragment.targets, []);
  const layerDraws = of(log, 'pass.draw').filter((draw) => draw[2] !== undefined);
  assert.deepEqual(
    layerDraws.map((draw) => draw.slice(1, 3)),
    [[3, 5]],
    'one instance per kept layer',
  );
  oit.dispose();
  assert.equal(
    passes(frame(1)).some((p) => p.label?.startsWith('oit:')),
    false,
    'dispose restores sorted blending',
  );
});

test('ExactOIT refuses compatibility devices before creating GPU resources', async () => {
  for (const capability of ['webgl2', 'compatibility', 'fragment-limit']) {
    const { engine, gpu } = await scene();
    if (capability === 'webgl2') gpu.device.adapterInfo = { vendor: 'margo-webgl2' };
    if (capability === 'compatibility') gpu.device.features = new Set();
    if (capability === 'fragment-limit') gpu.device.limits.maxStorageBuffersInFragmentStage = 0;
    const calls = gpu.record(() => {
      assert.throws(
        () => ExactOIT.attach(engine),
        (error) => error.code === 'unsupported' && /use OIT on this device/.test(error.message),
      );
    });
    assert.equal(of(calls, 'createBuffer').length, 0, capability);
    engine.dispose();
  }
});

test('ExactOIT refuses settings it cannot keep', () => {
  for (const layers of [0, 33, 1.5, Number.NaN]) assert.throws(() => new ExactOIT({ layers }), RangeError);
  for (const pool of [0, -1, Number.POSITIVE_INFINITY]) assert.throws(() => new ExactOIT({ pool }), RangeError);
  assert.throws(() => new ExactOIT({ order: 0 }), RangeError);
});

test('MomentOIT: BLEND primitives draw twice, into the moments and then shaded by them, and a composite lays that over the scene', async () => {
  const { engine, model, view, frame, id } = await scene(4),
    oit = MomentOIT.attach(engine);
  assert.throws(() => new MomentOIT().add(model), /attach/);
  oit.add(model);
  const log = frame(0),
    list = passes(log).slice(2);
  assert.deepEqual(
    list.map((p) => p.label),
    ['oit:moments', 'oit:shade', 'oit:composite'],
  );
  const readOnly = { view: id(view.c.depth), depthReadOnly: true, stencilReadOnly: true };
  assert.equal(list[0].colorAttachments.length, 2);
  assert.equal(list[1].colorAttachments.length, 1);
  assert.deepEqual(list[0].depthStencilAttachment, readOnly);
  assert.deepEqual(list[1].depthStencilAttachment, readOnly);
  assert.equal(
    draws(log),
    6,
    'opaque + one linear-composited native glass draw, then two BLEND primitives in each of two passes',
  );
  const formats = of(log, 'texture')
    .map((e) => e[2])
    .filter((t) => t.label?.startsWith('oit:'))
    .map((t) => [t.format, t.sampleCount]);
  assert.deepEqual(formats, [
    ['rgba16float', 1],
    ['rgba16float', 1],
    ['rgba16float', 1],
    ['rgba16float', 4],
    ['rgba16float', 4],
    ['rgba16float', 4],
  ]);
  const before = frame(1);
  assert.equal(of(before, 'texture').filter((e) => e[2].label?.startsWith('oit:')).length, 0, 'targets are kept');
  oit.dispose();
  assert.equal(
    passes(frame(2)).some((p) => p.label?.startsWith('oit:')),
    false,
    'dispose restores sorted blending',
  );
});

test('MomentOIT refuses a depth range it cannot warp', () => {
  for (const depthRange of [
    [0, 1],
    [2, 1],
    [1, 1],
    [-1, 2],
    [1, Number.POSITIVE_INFINITY],
  ])
    assert.throws(() => new MomentOIT({ depthRange }), RangeError);
});

test('OIT blending: transmission joins the pass as a tint draw and a lit draw, three targets, and the composite dims then lights', async () => {
  const { engine, model, frame } = await scene(4),
    oit = OIT.attach(engine, { blending: true });
  oit.add(model);
  const log = frame(0),
    list = passes(log);
  assert.equal(list.length, 3, 'the opaque pass, then accumulate and composite: no pass for the glass alone');
  assert.equal(list[1].colorAttachments.length, 3);
  assert.deepEqual(list[1].colorAttachments[1].clearValue, [1, 1, 1, 1]);
  assert.equal(draws(log), 5, 'opaque, two BLEND primitives, and the glass twice');
  const entries = of(log, 'renderPipeline').map((e) => e[2].fragment.entryPoint);
  assert.ok(entries.includes('margoTint'));
  assert.deepEqual(entries.filter((e) => e === 'dim' || e === 'light').sort(), ['dim', 'light']);
  assert.equal(of(log, 'pass.draw').length, 2);
  oit.dispose();
});

test('OIT without blending keeps two targets and leaves transmission sorted', async () => {
  const { engine, model, frame } = await scene(4),
    oit = OIT.attach(engine);
  assert.equal(oit.blends, false);
  oit.add(model);
  const list = passes(frame(0));
  assert.equal(list.length, 4);
  assert.equal(list[2].colorAttachments.length, 2);
  oit.dispose();
});

test('TransparentDepth redraws transparent surfaces, depth only, after the pass that coloured them', async () => {
  const { engine, model, view, frame, id } = await scene(4),
    oit = OIT.attach(engine),
    glass = TransparentDepth.attach(engine);
  assert.throws(() => new TransparentDepth().add(model), /attach/);
  oit.add(model);
  const remove = glass.add(model),
    list = passes(frame(0)),
    labels = list.map((p) => p.label);
  assert.ok(labels.indexOf('oit:depth') > labels.indexOf('oit:composite'));
  const pass = list[labels.indexOf('oit:depth')];
  assert.deepEqual(pass.colorAttachments, []);
  assert.deepEqual(pass.depthStencilAttachment, {
    view: id(view.c.depth),
    depthLoadOp: 'load',
    depthStoreOp: 'store',
    stencilReadOnly: true,
  });
  assert.equal(passes(frame(1)).length, list.length, 'steady frames keep the same geometry and OIT passes');
  assert.equal(glass.velocity(model).shadowPrimitives.length, 3, 'two BLEND primitives and the glass');
  remove();
  assert.equal(
    passes(frame(3)).some((p) => p.label === 'oit:depth'),
    false,
    'a removed model writes nothing',
  );
  glass.dispose();
  oit.dispose();
});

test('TransparentDepth refuses settings it cannot keep', () => {
  for (const threshold of [0, -1, 1.5, Number.NaN])
    assert.throws(() => new TransparentDepth({ threshold }), RangeError);
  assert.throws(() => new TransparentDepth({ order: 0 }), RangeError);
});

/** An effect that records what the pass asks of it. */
function fakeEffect() {
  return {
    hooks: [],
    drawn: [],
    released: undefined,
    setTransparency(hook, released) {
      this.hooks.push(hook);
      this.released = released;
      return () => this.hooks.pop();
    },
    drawTransparent(c, hook) {
      this.drawn.push(hook);
      hook.begin();
    },
  };
}

test('addEffect hands an effect the pass, draws it in the pass and hands it back', async () => {
  const { engine, frame } = await scene(1),
    oit = OIT.attach(engine),
    effect = fakeEffect();
  const remove = addEffect(oit, effect);
  assert.equal(addEffect(oit, effect), remove, 'adding twice is adding once');
  assert.deepEqual(effect.hooks, [oit]);
  assert.match(oit.surface(1), /fn margoTransparentAt\(color:vec4f,clip:vec4f,depth:f32\)/);
  assert.doesNotMatch(oit.surface(1), /\bOut\b|f\.view/, 'nothing of the PBR shader, which an effect does not have');
  assert.match(oit.declarations(2), /fn margoTransparent\(color:vec4f,i:Out\)/);
  assert.deepEqual(
    passes(frame(0))
      .map((p) => p.label)
      .slice(-2),
    ['oit:accumulate', 'oit:composite'],
    'no model needed',
  );
  assert.equal(effect.drawn.length, 1);
  remove();
  assert.deepEqual(effect.hooks, [], 'handed back');
  assert.equal(oit.effects.size, 0);
  effect.drawn.length = 0;
  frame(1);
  assert.equal(effect.drawn.length, 0, 'not drawn again');
});

test('MomentOIT asks an effect to draw twice, with a hook for each pass, and ExactOIT once', async () => {
  const { engine, frame } = await scene(1),
    moments = MomentOIT.attach(engine),
    effect = fakeEffect();
  addEffect(moments, effect);
  frame(0);
  assert.equal(effect.drawn.length, 2);
  assert.notEqual(effect.drawn[0], effect.drawn[1]);
  for (const hook of effect.drawn) assert.match(hook.surface(1), /fn margoTransparentAt/);
  assert.equal(effect.drawn[1].layout.length, 3, 'the shading hook binds the two moment targets');
  moments.dispose();
  const exact = ExactOIT.attach(engine),
    other = fakeEffect();
  addEffect(exact, other);
  frame(1);
  assert.equal(other.drawn.length, 1);
  assert.match(exact.surface(1), /var<private> margoCoverage:u32/);
});

test('an effect disposed first leaves the pass; a disposed pass hands every effect back', async () => {
  const { engine } = await scene(1),
    oit = OIT.attach(engine),
    gone = fakeEffect(),
    kept = fakeEffect();
  addEffect(oit, gone);
  addEffect(oit, kept);
  gone.released();
  assert.deepEqual([...oit.effects.keys()], [kept]);
  oit.dispose();
  assert.deepEqual(kept.hooks, []);
  assert.throws(() => addEffect(oit, fakeEffect()), /disposed/);
});

test('addEffect refuses what is no effect, and a pass not attached', () => {
  assert.throws(() => addEffect(new OIT(), fakeEffect()), /attach/);
  assert.throws(() => addEffect(new OIT(), {}), /VFX, Splats or PointsPlugin/);
  assert.throws(() => addEffect(new OIT(), null), TypeError);
});
