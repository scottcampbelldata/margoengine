import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import { Material, createMesh } from '../../materials/dist/index.js';
import { OIT } from '../dist/index.js';
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
  const model = parseGLTF(engine, fixture.doc, fixture.buffers);
  engine.camera.update(4 / 3, true);
  store.tick(false);
  const view = context(gpu, { samples, format: 'bgra8unorm', depthFormat: 'depth32float-stencil8' });
  const frame = (n) =>
    gpu.record(() => {
      view.begin(n);
      engine.frameGraph.execute(view.c);
    });
  return { gpu, engine, model, view, frame, id: (value) => gpu.snap(value) };
}
const of = (log, name) => log.filter((e) => e[0] === name);
const passes = (log) => of(log, 'beginRenderPass').map((e) => e[1]);
const draws = (log) => of(log, 'pass.drawIndexed').length;

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
  assert.deepEqual(composite.colorAttachments, [{ view: id(view.c.color), loadOp: 'load', storeOp: 'store' }]);
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
    5,
    'opaque + transmission (tint, then lit: gltf-pro 5w.f) in beauty, two BLEND primitives accumulated',
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
  assert.equal(draws(hidden), 3, 'opaque + transmission twice');
  for (const i of [1, 3]) model.nodes[i].visible = true;
  oit.dispose();
  assert.equal(engine.hasPlugin(oit.name), false);
  const sorted = frame(2);
  assert.equal(passes(sorted).length, 4, 'opaque pass + one pass per blended primitive');
  assert.equal(draws(sorted), 5, 'transmission draws twice');
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
    of(log, 'module').some((e) => e[2].code.includes('mat_baseMap') && e[2].code.includes('@fragment fn transparent(')),
    'materials text patch composes with the hook',
  );
  glass.material.transparent = false;
  assert.deepEqual(
    passes(frame(3)).map((p) => p.label),
    [undefined, undefined],
    'opaque again: drawn by the materials pass',
  );
  assert.throws(() => model.setTransparency({}), TypeError);
});
