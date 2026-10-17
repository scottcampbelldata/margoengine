// Proof that gltf-pro's transparency hook (HANDOFF 5f.b, @margoengine/oit) changes nothing on the GPU while no hook is set:
// gltf-pro at `ref` (before the hook) and in the working tree record every GPU call, descriptor, shader module and buffer
// write of a 6-frame story: opaque, MASK, BLEND (twice), BLEND + clearcoat (physical) and a BLEND material
// with a custom renderState, a text-patching lighting effect added and removed, a hidden blended node, an HDR and a
// canvas target, MSAA 1x/4x, beauty/SSAO-ambient/G-buffer draws through the frame graph and directly. They must be identical.
// Run (after npm run build:packages): node examples/package-benchmarks/proofs/oit-detached.proof.js [ref] [pin] [--current]
// Pinned: b803d56 against 0e02ead, the commit that made this claim. --current: b3ed8ac against the working tree;
// this includes the intentional PBR uniform and draw coalescing changes through 2091f12 (claims.md).
import assert from 'node:assert/strict';
import { refs, versions } from './compare.js';
import { mockGPU, context } from './gpu-recorder.js';
import { Engine, TransformStore } from '../../../packages/core/dist/extension.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';

const { ref, pin } = refs('b803d56', '0e02ead', 'b3ed8ac');
const { baseline, candidate } = await versions('gltf-pro', ref, undefined, pin);
const materials = [
  {},
  { alphaMode: 'MASK', alphaCutoff: 0.3 },
  { alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.5] } },
  // Was BLEND + KHR_materials_transmission (0.5) until 5w.f: transmission now draws twice (tint multiply, then the lit
  // surface) with the transmissive shader, by design; packages/gltf-pro/tests/materials-ext.test.js covers it.
  { alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [1, 1, 0, 0.6] } },
  {
    alphaMode: 'BLEND',
    pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 0.4] },
    extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1 } },
  },
  { alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 0.3] } },
];

async function story(gltf, samples) {
  const gpu = mockGPU(),
    store = await TransformStore.create(32),
    canvas = { width: 128, height: 96, clientWidth: 128, clientHeight: 96 };
  const renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(canvas, store, renderer, { position: [0, 0, 4], target: [0, 0, 0] }, null);
  const fixture = animatedTriangle(),
    primitive = fixture.doc.meshes[0].primitives[0];
  Object.assign(fixture.doc, {
    materials,
    extensionsUsed: ['KHR_materials_clearcoat'],
    meshes: materials.map((_, material) => ({ primitives: [{ ...primitive, material }] })),
    nodes: materials.map((_, mesh) => ({ mesh, translation: [0.1 * mesh, 0, -mesh] })),
  });
  delete fixture.doc.skins;
  delete fixture.doc.animations;
  const log = gpu.record(() => {
    const model = gltf.parseGLTF(engine, fixture.doc, fixture.buffers);
    engine.camera.update(4 / 3, true);
    store.tick(false);
    model.primitives[5].material.renderState = {
      blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } },
      depthWrite: false,
    };
    const view = context(gpu, { samples, format: 'rgba16float', depthFormat: 'depth32float-stencil8' });
    const custom = { shader: (source) => '// custom\n' + source, bindings: () => [] };
    let remove;
    const steps = [
      () => {},
      () => {
        remove = model.addLighting(custom);
      },
      () => {
        model.nodes[2].visible = false;
      },
      () => {
        view.state.format = 'bgra8unorm';
      },
      () => {
        model.nodes[2].visible = true;
        remove();
      },
      () => {
        view.state.samples = samples === 4 ? 1 : 4;
      },
    ];
    steps.forEach((step, frame) => {
      step();
      view.begin(frame);
      gpu.note('graph', frame);
      engine.frameGraph.execute(view.c);
      for (const mode of ['ambient', 'gbuffer']) {
        gpu.note('draw', frame, mode);
        model.draw(view.c, mode, view.c.color, view.c.depth);
      }
    });
    model.dispose();
  });
  engine.dispose();
  return log;
}

let calls = 0,
  modules = 0;
for (const samples of [1, 4]) {
  const expected = await story(baseline, samples),
    actual = await story(candidate, samples);
  assert.ok(expected.filter((e) => e[0] === 'beginRenderPass').length > 20, 'story must draw');
  assert.deepEqual(actual, expected, `gltf-pro GPU calls differ at ${samples}x without a transparency hook`);
  calls += expected.length;
  modules += expected.filter((e) => e[0] === 'module').length;
}
console.log(
  JSON.stringify({
    package: 'gltf-pro',
    baseline: ref,
    identicalCalls: calls,
    shaderModules: modules,
    writes: 'byte-identical',
  }),
);
