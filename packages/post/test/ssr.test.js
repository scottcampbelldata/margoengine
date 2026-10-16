import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { FrameGraph, Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import { extendedMaterials } from '../../gltf-pro/dist/extended.js';
import { PBRInstances } from '../../gltf-pro/dist/instancing.js';
import { Material, createMesh } from '../../materials/dist/index.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { wgsl } from '../../core/dist/shaders.js';
import { PostStack, SSR, SSAO } from '../dist/index.js';

function harness(samples = 4, shader = wgsl) {
  const gpu = mockGPU(),
    graph = new FrameGraph(),
    plugins = new Map(),
    resources = [];
  let host = false;
  for (const kind of ['createTexture', 'createBuffer']) {
    const create = gpu.device[kind];
    gpu.device[kind] = (descriptor) => {
      const r = create(descriptor);
      if (!host) resources.push(r);
      return r;
    };
  }
  const engine = {
    gpu: gpu.device,
    frameGraph: graph,
    hasPlugin: (name) => plugins.has(name),
    use(plugin) {
      if (plugins.has(plugin.name)) throw new TypeError('Invalid plugin');
      try {
        graph.withOwner(plugin.name, () => {
          plugin.setup(engine);
          plugin.registerPasses?.(graph);
        });
        plugins.set(plugin.name, plugin);
      } catch (error) {
        graph.removeOwner(plugin.name);
        plugin.dispose?.();
        throw error;
      }
      return engine;
    },
    removePlugin(name) {
      const plugin = plugins.get(name);
      if (plugin) {
        graph.removeOwner(name);
        plugins.delete(name);
        plugin.dispose?.();
      }
    },
  };
  const view = context(gpu, { samples, shader, format: 'bgra8unorm' }),
    draws = [];
  let index = 0;
  const frame = (bindings = []) => {
    host = true;
    view.begin(index++);
    host = false;
    view.c.bindings.push(...bindings);
    view.c.draw = (o) => draws.push({ ...o, color: view.c.color, descriptor: view.c.descriptor });
    graph.execute(view.c);
  };
  return { gpu, engine, view, plugins, draws, frame, live: () => resources.filter((r) => !r.destroyed) };
}
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);
const ibl =
  wgsl.replace(/let linear=([^;]+);/, 'let margoAmbient=vec3f(0.5);let linear=$1+margoAmbient;') +
  '\nfn iblBrdfTerms(nv:f32,r:f32)->vec2f {return vec2f(1,0);}';

for (const samples of [4, 1])
  test(`SSR replays core materials into its targets and composes the stack input (${samples}x)`, () => {
    const h = harness(samples),
      ssr = new SSR(),
      taa = { binding: 8, resource: { buffer: {} } },
      env = { binding: 20, resource: {} };
    h.engine.use(new PostStack([ssr]));
    const log = h.gpu.record(() => h.frame([taa, env]));
    const replay = modules(log).find((code) => code.includes('struct Input'));
    // The whole lit shader stays (every pass binding statically used); the fragment returns the three material targets.
    assert.match(replay, /->MargoSSR \{/);
    assert.match(
      replay,
      /if\(false\)\{let direct=[\s\S]*_=vec4f\(linear,1\);\}return margoSSR\(n,v,i\.color,i\.material\.y,i\.material\.x\);\s*\}/,
    );
    assert.match(replay, /exp2\(-9\.28\*nv\)/, 'no IBL: analytic split-sum weight');
    assert.doesNotMatch(replay, /iblBrdfTerms\(nv,rough\)/);
    const replays = h.draws.filter((d) => d.pipeline);
    assert.equal(replays.length, 1);
    const [draw] = replays;
    assert.deepEqual(
      draw.bindings.map((e) => e.binding),
      [8, 20],
    );
    assert.equal(draw.colorAttachments.length, 2);
    // 1x: depth-equal against the scene depth; 4x: a 1x replay into SSR's own cleared depth (no multisampled targets).
    assert.equal(draw.descriptor.multisample.count, 1);
    assert.equal(draw.clear, samples === 4);
    const pipeline = log.find((e) => e[0] === 'renderPipeline' && e[2].fragment?.targets?.length === 3)[2];
    assert.deepEqual(
      pipeline.fragment.targets.map((t) => t.format),
      ['rgba16float', 'rgb10a2unorm', 'rgb10a2unorm'],
    );
    assert.equal(pipeline.multisample.count, 1);
    assert.deepEqual(
      [pipeline.depthStencil.depthCompare, pipeline.depthStencil.depthWriteEnabled],
      samples === 4 ? ['greater-equal', true] : ['equal', false],
    );
    assert.deepEqual(
      log
        .filter((e) => e[0] === 'texture' && ['rgb10a2unorm', 'r32float'].includes(e[2].format))
        .map((e) => e[2].sampleCount ?? 1),
      [1, 1, 1],
      'no multisampled SSR targets',
    );
    // Composite: one fullscreen pass into the frame target (SSR is the stack's last effect, so it tone maps).
    const composite = modules(log).find((code) => code.includes('fn closest('));
    assert.match(composite, /c=c\/\(1\+c\);/);
    // Steady frames create no GPU objects.
    const steady = h.gpu.record(() => h.frame([taa, env]));
    assert.deepEqual(
      steady.filter((e) => /^(texture|buffer|module|group|renderPipeline|computePipeline|view|sampler)$/.test(e[0])),
      [],
    );
    // Resize releases sized targets; dispose releases everything.
    const before = h.live().length;
    h.view.state.width = 640;
    h.frame();
    assert.equal(h.live().length, before);
    ssr.dispose();
    h.engine.removePlugin('post:stack');
    assert.deepEqual(h.live(), []);
  });

test('SSR replaces the IBL specular from EnvironmentLighting (margoAmbient + its BRDF LUT)', () => {
  const h = harness(4, ibl);
  h.engine.use(new PostStack([new SSAO(), new SSR()]));
  const code = modules(h.gpu.record(() => h.frame())).filter((code) => code.includes('margoSSR'));
  assert.equal(code.length, 1);
  assert.match(
    code[0],
    /let ab=iblBrdfTerms\(nv,rough\);let w=f0\*ab\.x\+ab\.y;let e=iblPrefiltered\(iblSpecular,iblSampler,iblParams,reflect\(-v,n\),rough\)\*w\*iblParams\.w;/,
  );
});

test('SSR.attach runs alone in its own PostStack; options are validated', () => {
  const h = harness(4),
    ssr = SSR.attach(h.engine, { maxRoughness: 0.4 });
  assert.ok(h.plugins.has('post:stack') && h.plugins.has('ssr'));
  h.frame();
  ssr.dispose();
  assert.ok(!h.plugins.has('post:stack') && !h.plugins.has('ssr'));
  assert.deepEqual(h.live(), []);
  assert.throws(() => h.engine.use(new SSR()), /PostStack/);
  for (const options of [
    { maxRoughness: 0 },
    { maxRoughness: 1.5 },
    { thickness: 0 },
    { maxDistance: Infinity },
    { steps: 0 },
    { steps: 1.5 },
    { enabled: 1 },
  ])
    assert.throws(() => new SSR(options), RangeError);
  const effect = new SSR();
  effect.enabled = false;
  assert.equal(effect.enabled, false);
  assert.throws(() => {
    effect.enabled = 1;
  }, TypeError);
});

test('disabled SSR skips the replay, Hi-Z and blur and passes the input through', () => {
  const h = harness(4),
    ssr = new SSR({ enabled: false });
  h.engine.use(new PostStack([ssr]));
  h.frame();
  const log = h.gpu.record(() => h.frame());
  assert.equal(h.draws.filter((d) => d.pipeline).length, 0);
  assert.equal(log.filter((e) => e[0] === 'beginComputePass').length, 0);
  assert.equal(
    log.filter((e) => e[0] === 'beginRenderPass').length,
    1 + 3,
    'composite plus the stack final depth copies and resolve',
  );
});

// gltf-pro models (opaque, MASK, BLEND, unlit, physical clearcoat) and an instanced materials mesh on a real core Engine;
// SSR's frame graph drives their capture with the same pass context. The IBL effect is a stand-in with environment's names.
async function models(gpu) {
  const store = await TransformStore.create(32),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    renderer,
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const fixture = animatedTriangle(),
    primitive = fixture.doc.meshes[0].primitives[0];
  const materials = [
    {},
    { alphaMode: 'MASK', alphaCutoff: 0.3 },
    { alphaMode: 'BLEND' },
    { extensions: { KHR_materials_unlit: {} } },
    { extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1 } } },
  ];
  Object.assign(fixture.doc, {
    materials,
    extensionsUsed: ['KHR_materials_unlit', 'KHR_materials_clearcoat'],
    meshes: materials.map((_, material) => ({ primitives: [{ ...primitive, material }] })),
    nodes: materials.map((_, mesh) => ({ mesh })),
  });
  delete fixture.doc.skins;
  delete fixture.doc.animations;
  const model = parseGLTF(engine, fixture.doc, fixture.buffers, [], { materials: extendedMaterials }),
    ibl = {
      pbr: () => ({
        declarations: 'fn iblBrdfTerms(nv:f32,r:f32)->vec2f {return vec2f(1,0);}\n',
        ambient: 'vec3f(0.5)*s.occlusion',
      }),
      entries: [{ binding: 20, resource: {} }],
      bindings: () => ibl.entries,
    };
  model.addLighting(ibl);
  const mesh = createMesh(
    engine,
    { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
    new Material({ roughness: 0.1, metalness: 1 }),
  );
  mesh.primitives[0].instances = new PBRInstances(3);
  engine.camera.update(4 / 3, true);
  store.tick(false);
  return { engine, model, mesh };
}
for (const samples of [4, 1])
  test(`ssr.add(model) draws gltf-pro and materials into the replay targets with their own materials (${samples}x)`, async () => {
    const h = harness(samples),
      ssr = new SSR();
    h.engine.use(new PostStack([ssr]));
    const { engine, model, mesh } = await models(h.gpu);
    const remove = ssr.add(model);
    assert.equal(ssr.add(model), remove, 'one remover per model');
    const removeMesh = ssr.add(mesh);
    const log = h.gpu.record(() => h.frame());
    const pipelines = log.filter((e) => e[0] === 'renderPipeline' && e[2].fragment.entryPoint === 'capture');
    assert.equal(
      pipelines.length,
      4,
      'opaque, MASK, clearcoat and the materials mesh; BLEND and unlit are not captured',
    );
    for (const [, , p] of pipelines) {
      assert.deepEqual(
        p.fragment.targets.map((t) => t.format),
        ['rgba16float', 'rgb10a2unorm', 'rgb10a2unorm'],
      );
      assert.equal(p.multisample.count, 1);
      assert.deepEqual(
        [p.depthStencil.format, p.depthStencil.depthCompare, p.depthStencil.depthWriteEnabled],
        [samples === 4 ? 'depth32float' : 'depth24plus-stencil8', 'greater-equal', true],
      );
    }
    assert.ok(
      pipelines.some(([, , p]) => p.vertex.buffers.length === 2),
      'instanced materials mesh keeps its instance buffer',
    );
    assert.deepEqual(
      pipelines.map(([, , p]) => p.fragment.constants?.margoAlphaTest ?? 0),
      [0, 1, 0, 0],
      'MASK alpha-tests',
    );
    assert.equal(pipelines[0][2].fragment.constants, undefined, 'compact opaque shaders need no specialization');
    const code = log
      .filter((e) => e[0] === 'module' && e[2].code.includes('@fragment fn capture('))
      .map((e) => e[2].code);
    assert.match(
      code[0],
      /if\(f\.settings\.x>0\.5&&f\.settings\.x<1\.5&&s\.base\.a<f\.settings\.y\)\{discard;\}/,
      'the compact shader retains its material-controlled alpha guard',
    );
    // IBL on the model: the replaced specular is environment's split-sum term times occlusion (and clearcoat/sheen's k).
    for (const c of code.slice(0, 3)) assert.match(c, /let ab=iblBrdfTerms\(nv,rough\)[\s\S]*let o=k\*s\.occlusion;/);
    assert.ok(
      code.some((c) =>
        c.includes(
          'margoCapture(s,v,layers(s,v,normalize(f.light.xyz),vec3f(1))-layers(s,v,normalize(f.light.xyz),vec3f(0)))',
        ),
      ),
      'clearcoat k',
    );
    assert.match(
      code.at(-1),
      /exp2\(-9\.28\*nv\)[\s\S]*mat_baseMap[\s\S]*margoCapture\(s,v,vec3f\(1\)\)/,
      'materials mesh without IBL: analytic weight, its own maps',
    );
    // One capture pass after the core replay, loading SSR's three targets and the depth the Hi-Z is built from.
    const begins = log.map((e, i) => [e, i]).filter(([e]) => e[0] === 'beginRenderPass'),
      capture = begins.find(
        ([e]) => e[1].colorAttachments.length === 3 && e[1].colorAttachments.every((a) => a.loadOp === 'load'),
      );
    assert.ok(capture, 'capture pass');
    const at = capture[1];
    assert.ok(
      log.findIndex((e) => e[0] === 'draw') < at && at < log.findIndex((e) => e[0] === 'beginComputePass'),
      'after the core replay, before the Hi-Z',
    );
    assert.deepEqual(
      [capture[0][1].depthStencilAttachment.depthLoadOp, capture[0][1].depthStencilAttachment.depthStoreOp],
      ['load', 'store'],
    );
    const inPass = log.slice(at, at + log.slice(at).findIndex((e) => e[0] === 'pass.end'));
    assert.deepEqual(
      inPass.filter((e) => e[0] === 'pass.drawIndexed').map((e) => e[2] ?? 1),
      [1, 1, 1, 3],
      'four draws in the one pass, the mesh instanced x3',
    );
    assert.equal(engine.stats.drawCalls, 0, 'captures are not counted as scene draws');
    // With models the composite never removes more specular than a (4x silhouette) pixel holds.
    assert.ok(
      modules(log).some(
        (c) =>
          c.includes('fn closest(') &&
          c.includes('c=max(vec3f(0),c+f*min(1.0,min(q.x,min(q.y,q.z)))*(m.rgb*reflected-e.rgb));'),
      ),
      'guarded composite',
    );
    // Steady frames create no GPU objects; removers and dispose detach the hook.
    const steady = h.gpu.record(() => h.frame());
    assert.deepEqual(
      steady.filter((e) => /^(texture|buffer|module|group|renderPipeline|computePipeline|view|sampler)$/.test(e[0])),
      [],
    );
    remove();
    removeMesh();
    const none = h.gpu.record(() => h.frame());
    assert.equal(none.filter((e) => e[0] === 'pass.drawIndexed').length, 0);
    ssr.add(mesh);
    mesh.dispose();
    assert.equal(
      h.gpu.record(() => h.frame()).filter((e) => e[0] === 'pass.drawIndexed').length,
      0,
      'a disposed mesh is forgotten',
    );
    ssr.add(model);
    ssr.dispose();
    h.engine.removePlugin('post:stack');
    assert.throws(() => ssr.add(model), /disposed/);
    model.dispose();
    engine.dispose();
  });
