// Material features on createMesh meshes, recorded on a mock device: the shader text each option adds (and that it adds
// none while unused), its bindings and live uniforms. browser-check.mjs checks the rendered values on a real adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { Clustered } from '../../clustered/dist/index.js';
import { LocalShadows } from '../../clustered/dist/shadows.js';
import { Shadows } from '../../shadows/dist/index.js';
import {
  LambertMaterial,
  NormalMaterial,
  UnlitMaterial,
  PbrMaterial,
  PhongMaterial,
  Texture,
  createInstancedMesh,
  createMesh,
} from '../dist/index.js';
import { NodeMaterial, normalLocal, positionLocal } from '../../shader/dist/index.js';
import { exportModel } from '../../exporters/dist/model.js';
import { readGLB } from '../../exporters/tests/helpers.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';

async function scene() {
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
  engine.camera.update(4 / 3, true);
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', depthFormat: 'depth32float', shader: wgsl });
  let n = 0;
  const history = [],
    frame = () => {
      const log = gpu.record(() => {
        store.tick(false);
        view.begin(n++);
        engine.frameGraph.execute(view.c);
      });
      history.push(...log);
      return log;
    };
  return { gpu, engine, frame, history };
}
const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
const codes = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);
const lightLoop = (code) => /fn clusterLighting\([\s\S]*?\n\}/.exec(code)?.[0] ?? '';

test('clustered point and spot lights shade Lambert and Phong with their own BRDF, standard materials keep GGX', async () => {
  const s = await scene(),
    lights = Clustered.attach(s.engine);
  lights.setLights([{ position: [0, 0, 1], range: 5, intensity: 3 }]);
  const meshes = [new PbrMaterial(), new LambertMaterial(), new PhongMaterial({ shininess: 12 })].map((m) => {
    const mesh = createMesh(s.engine, quad, m);
    lights.add(mesh);
    return mesh;
  });
  const lit = codes(s.frame()).filter((code) => code.includes('fn clusterLighting(')),
    byShading = Object.fromEntries(
      lit.map((code) => [
        code.includes('mat_phong') ? 'phong' : code.includes('fn margoFront(s:Surface)') ? 'lambert' : 'standard',
        code,
      ]),
    );
  assert.equal(Object.keys(byShading).length, 3, 'one lit shader per material');
  const ggx = 'result+=((1-fresnel)*(1-metal)*base/3.14159265+d*g*fresnel/max(4*nl*nv,0.0001))*nl*';
  assert.ok(lightLoop(byShading.standard).includes(ggx), 'standard: GGX, as before');
  assert.ok(!byShading.standard.includes('margoLocalBrdf'), 'standard: nothing added');
  for (const shading of ['lambert', 'phong']) {
    const loop = lightLoop(byShading[shading]);
    assert.ok(!loop.includes(ggx) && loop.includes('result+=margoLocalBrdf(n,v,l,base)*nl*'), shading);
  }
  assert.ok(
    byShading.lambert.includes(
      'fn margoLocalBrdf(n:vec3f,v:vec3f,l:vec3f,base:vec3f)->vec3f {return base/3.14159265;}',
    ),
  );
  assert.ok(
    byShading.phong.includes(
      'return base/3.14159265+mat_phong.rgb*(mat_phong.w+2)/25.13274123*pow(max(dot(n,h),0.0001),mat_phong.w);}',
    ),
    'the same Blinn-Phong lobe as the directional light',
  );
  for (const mesh of meshes) mesh.destroy();
  lights.dispose();
  s.engine.dispose();
});

const floats = (hex) => new Float32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer);
const bindings = (log) => log.filter((e) => e[0] === 'group').map((e) => e[2].entries.map((entry) => entry.binding));
/** Buffers bound as a feature uniform (binding 198) in the frames of `history`. */
const featureBuffers = (history) =>
  new Set(
    history
      .filter((e) => e[0] === 'group')
      .flatMap((e) => e[2].entries.filter((entry) => entry.binding === 198).map((entry) => entry.resource.buffer)),
  );
/** Feature uniform writes in `log`, as numbers; `history` holds the frames that bound the buffers. */
const featureWrites = (log, history) => {
  const ids = featureBuffers(history);
  return log.filter((e) => e[0] === 'writeBuffer' && ids.has(e[1])).map((e) => [...floats(e[3])]);
};
/** The last feature uniform write in `log`. */
const featureUniform = (log, history) => featureWrites(log, history).at(-1);
const solid = (r, g, b, a = 255) =>
  new Texture(
    { data: new Uint8Array([r, g, b, a, r, g, b, a, r, g, b, a, r, g, b, a]), width: 2, height: 2 },
    { mipmaps: false },
  );
/** GPU calls of one frame drawing `material` on a fresh mock device, cast into every kind of shadow map. */
async function oneFrame(material, hook = false) {
  const s = await scene(),
    mesh = createMesh(s.engine, quad, material),
    remove = casters(s.engine, mesh, hook),
    log = s.frame();
  remove();
  mesh.destroy();
  s.engine.dispose();
  return log;
}
/** Directional shadows and a clustered light shadowed by its integrated maps or (`hook`) LocalShadows, casting `mesh`. */
function casters(engine, mesh, hook) {
  const shadows = Shadows.attach(engine, { resolution: 256, cascades: 1 }),
    lights = Clustered.attach(engine, hook ? {} : { shadows: { resolution: 64, maxLights: 1 } }),
    local = hook ? LocalShadows.attach(engine, { lights, resolution: 64 }) : undefined;
  lights.setLights([{ position: [0, 0, 2], range: 5, ...(hook ? { castShadow: true } : { shadow: true }) }]);
  shadows.add(mesh);
  lights.add(mesh);
  if (local) local.add(mesh);
  else lights.addShadowCaster(mesh);
  return () => {
    for (const plugin of [local, lights, shadows]) if (plugin) engine.removePlugin(plugin.name);
  };
}

test('alphaMap compiles in only while set: green multiplies opacity, bindings 198 and 180-181, live UV rows', async () => {
  const s = await scene(),
    material = new PbrMaterial({ transparent: true }),
    mesh = createMesh(s.engine, quad, material);
  const plain = s.frame();
  assert.ok(codes(plain).length && codes(plain).every((c) => !c.includes('margoFeatures')), 'no feature text');
  assert.ok(bindings(plain).every((list) => !list.includes(198)));
  material.alphaMap = solid(0, 128, 0);
  let log = s.frame();
  assert.ok(
    codes(log).some((c) =>
      c.includes('s.base.a*=textureSample(margoAlphaMap,margoAlphaSampler,margoFeatureUV(i.uv,0u)).g;\n  let mr='),
    ),
    'sampled before alphaTest and blending read s.base.a',
  );
  assert.ok(bindings(log).some((list) => [198, 180, 181].every((b) => list.includes(b))));
  material.setUVTransform({ offset: [0.5, 0.25], scale: [0.5, 0.5] }, 'alphaMap');
  log = s.frame();
  const values = featureUniform(log, s.history);
  assert.deepEqual(values.slice(0, 4), [1, 1, 0, 1]);
  assert.deepEqual(
    values.slice(4, 12).map((v) => v + 0),
    [0.5, 0, 0.5, 0, 0, 0.5, 0.25, 0],
    'alphaMap UV rows, live',
  );
  assert.equal(values[4 + 3 * 8 + 3], 1, 'lightMap rows read UV1');
  assert.throws(() => {
    material.alphaMap = {};
  }, TypeError);
  material.alphaMap = null;
  log = s.frame();
  assert.deepEqual(codes(log), [], 'back to the cached plain pipeline');
  assert.ok(bindings(log).every((list) => !list.includes(198)));
  mesh.destroy();
  s.engine.dispose();
});

// Every feature option at its default; the values that turn each on; what turns them off again (the scalars may stay).
const defaults = {
  alphaMap: null,
  bumpMap: null,
  bumpScale: 1,
  displacementMap: null,
  displacementScale: 1,
  displacementBias: 0,
  lightMap: null,
  lightMapIntensity: 1,
  emissiveIntensity: 1,
};
const used = () => ({
  alphaMap: solid(0, 0, 0),
  bumpMap: solid(0, 0, 0),
  bumpScale: 3,
  displacementMap: solid(0, 0, 0),
  displacementScale: 2,
  displacementBias: 0.5,
  lightMap: solid(0, 0, 0),
  lightMapIntensity: 4,
  emissiveIntensity: 4,
});
const off = { alphaMap: null, bumpMap: null, displacementMap: null, lightMap: null };

test('a material with every feature at its default draws exactly the GPU calls of a plain one', async () => {
  for (const hook of [false, true]) {
    const expected = await oneFrame(new PbrMaterial(), hook);
    assert.ok(
      codes(expected).some((c) => c.includes('fn shadowVisibility(')) &&
        codes(expected).some((c) => c.includes('@fragment fn fragment(i:') && !c.includes('fn surface(')),
      'the frame lights the mesh and draws it into the shadow maps',
    );
    assert.deepEqual(await oneFrame(new PbrMaterial(defaults), hook), expected);
    const toggled = new PbrMaterial(used());
    Object.assign(toggled, off);
    assert.deepEqual(await oneFrame(toggled, hook), expected, 'a feature turned off, scalars left set, adds nothing');
  }
});

test('bumpMap tilts the mapped normal by its screen-space slope; bumpScale is live and validated', async () => {
  const s = await scene(),
    material = new PbrMaterial({ normalMap: solid(128, 128, 255), bumpMap: solid(10, 0, 0), bumpScale: 0.5 }),
    mesh = createMesh(s.engine, quad, material);
  const log = s.frame();
  const code = codes(log).find((c) => c.includes('margoBump'));
  assert.ok(
    /\n {2}s\.n=normalize\(t\*sampledNormal[^\n]*\);\n {2}s\.n=margoBump\(s\.n,i\.position,textureSample\(margoBumpMap,margoBumpSampler,margoFeatureUV\(i\.uv,1u\)\)\.r\*margoFeatures\.values\.x,facing\);/.test(
      code,
    ),
    'right after the normal-mapped normal',
  );
  assert.ok(code.includes('fn margoBump(n:vec3f,p:vec3f,height:f32,facing:bool)->vec3f {'));
  assert.ok(!code.includes('margoAlphaMap'), 'only the maps in use are bound');
  assert.ok(bindings(log).some((list) => [198, 182, 183].every((b) => list.includes(b)) && !list.includes(180)));
  assert.equal(featureUniform(log, s.history)[0], 0.5);
  material.bumpScale = -2;
  assert.equal(featureUniform(s.frame(), s.history)[0], -2, 'live');
  assert.throws(() => {
    material.bumpScale = '1';
  }, TypeError);
  assert.throws(() => {
    material.bumpScale = Infinity;
  }, RangeError);
  mesh.destroy();
  s.engine.dispose();
});

test('displacementMap moves vertices along the normal in mesh space, in the beauty and in every shadow map', async () => {
  for (const hook of [false, true]) {
    const s = await scene(),
      material = new PbrMaterial({ displacementMap: solid(255, 0, 0), displacementScale: 0.5, displacementBias: 0.1 }),
      mesh = createMesh(s.engine, quad, material),
      remove = casters(s.engine, mesh, hook);
    let log = s.frame();
    const all = codes(log),
      beauty = all.filter((c) => c.includes('fn surface(')),
      depth = all.filter((c) => !c.includes('fn surface(') && c.includes('@vertex'));
    assert.ok(
      beauty.length &&
        beauty.every((c) => c.includes('let p=f.model*vec4f(i.position.xyz+i.normal.xyz*margoDisplacement(i.uv),1);')),
    );
    assert.ok(beauty[0].includes('fn margoDisplacement(uv:vec4f)->f32 {'));
    const displaced = depth.filter((c) => c.includes('vec4f(i.position.xyz+i.normal.xyz*margoDisplacement(i.uv),1)'));
    assert.equal(displaced.length, 2, `the directional and the ${hook ? 'LocalShadows' : 'integrated'} caster shaders`);
    for (const c of displaced) assert.ok(c.includes('@location(0) position:vec4f,@location(1) normal:vec4f,'));
    const modules = new Map(log.filter((e) => e[0] === 'module').map((e) => [e[1], e[2].code])),
      pipelines = log.filter((e) => e[0] === 'renderPipeline' && displaced.includes(modules.get(e[2].vertex.module)));
    assert.equal(pipelines.length, 2);
    for (const e of pipelines)
      assert.deepEqual(e[2].vertex.buffers[0].attributes[1], { format: 'float32x4', offset: 16, shaderLocation: 1 });
    // The casters bind the material's feature uniform, the map and its sampler.
    const [uniform] = featureBuffers(s.history);
    assert.equal(
      log.filter((e) => e[0] === 'group' && e[2].entries.length === 3 && e[2].entries[0].resource.buffer === uniform)
        .length,
      2,
    );
    assert.deepEqual(featureUniform(log, s.history).slice(1, 3), [0.5, 0.1].map(Math.fround));
    material.displacementBias = -0.25;
    log = s.frame();
    assert.equal(featureUniform(log, s.history)[2], -0.25, 'live');
    remove();
    mesh.destroy();
    s.engine.dispose();
  }
});

test('features apply after a subclass patch: NodeMaterial positions and instances displace too', async () => {
  const s = await scene(),
    node = new NodeMaterial({
      positionNode: positionLocal.add(normalLocal.mul(0.25)),
      displacementMap: solid(255, 0, 0),
    }),
    a = createMesh(s.engine, quad, node),
    b = createInstancedMesh(s.engine, quad, new PbrMaterial({ displacementMap: solid(255, 0, 0) }), 2);
  b.instances.count = 2;
  const all = codes(s.frame());
  assert.ok(
    all.some((c) =>
      c.includes('let p=f.model*vec4f(i.position.xyz + (i.normal.xyz * 0.25)+i.normal.xyz*margoDisplacement(i.uv),1);'),
    ),
    "on top of the node's position",
  );
  assert.ok(all.some((c) => c.includes('let p=margoI*vec4f(i.position.xyz+i.normal.xyz*margoDisplacement(i.uv),1);')));
  a.destroy();
  b.destroy();
  s.engine.dispose();
});

test('lightMap adds baked light on lit shadings, multiplies unlit colour, reads UV1 and sRGB, and is ignored elsewhere', async () => {
  const s = await scene(),
    map = solid(64, 64, 64),
    [lambert, unlit, normal] = [
      new LambertMaterial({ lightMap: map, lightMapIntensity: 2 }),
      new UnlitMaterial({ lightMap: map }),
      new NormalMaterial({ lightMap: map }),
    ],
    meshes = [lambert, unlit, normal].map((m) => createMesh(s.engine, quad, m));
  const log = s.frame(),
    all = codes(log),
    sampled = 'textureSample(margoLightMap,margoLightSampler,margoFeatureUV(i.uv,3u)).rgb*margoFeatures.values.w';
  assert.ok(
    all.some((c) =>
      c.includes(`s.emissive+=s.base.rgb*(1-s.metal)*s.occlusion*${sampled};
  let facing=`),
    ),
    'lit: indirect diffuse',
  );
  assert.ok(
    all.some((c) => c.includes(`s.base=vec4f(s.base.rgb*${sampled},s.base.a);`)),
    'unlit: multiplies the colour',
  );
  assert.equal(all.filter((c) => c.includes('margoLightMap')).length, 2, 'normal shading compiles none of it');
  assert.equal(bindings(log).filter((list) => list.includes(186)).length, 2, 'nor binds it');
  const views = log.filter((e) => e[0] === 'view' && e[2]?.format);
  assert.ok(
    views.some((e) => e[2].format === 'rgba8unorm-srgb'),
    'a colour map: sRGB by default',
  );
  assert.ok(
    featureWrites(log, s.history).some((v) => v[3] === 2 && v[4 + 3 * 8 + 3] === 1),
    'lightMapIntensity, on UV1',
  );
  lambert.setUVTransform({ offset: [0.5, 0] }, 'lightMap');
  lambert.setUVTransform({ scale: [2, 2] });
  const rows = featureWrites(s.frame(), s.history)
    .map((v) => v.slice(4 + 3 * 8))
    .find((v) => v[2] === 0.5);
  assert.deepEqual([rows[0], rows[3]], [1, 1], 'its own slot keeps UV1 and ignores the all-slot transform');
  for (const mesh of meshes) mesh.destroy();
  s.engine.dispose();
});

test('emissiveIntensity scales the emission gltf-pro draws, live and validated, with no shader change', async () => {
  const s = await scene(),
    material = new PbrMaterial({ emissive: [1, 0.5, 0], emissiveIntensity: 3 }),
    mesh = createMesh(s.engine, quad, material),
    emission = (log) => {
      const frame = log.filter((e) => e[0] === 'writeBuffer' && e[3].length >= 880 * 2).at(-1);
      return [...floats(frame[3]).slice(84, 87)];
    };
  let log = s.frame();
  assert.ok(codes(log).every((c) => !c.includes('margoFeatures')));
  assert.deepEqual(emission(log), [3, 1.5, 0]);
  material.emissiveIntensity = 0.5;
  material.emissive.set([0.5, 0.5, 1]);
  log = s.frame();
  assert.deepEqual(emission(log), [0.25, 0.25, 0.5], 'live, with the live colour');
  assert.deepEqual([...material.emissive], [0.5, 0.5, 1], 'the colour itself is not scaled');
  for (const bad of [-1, Infinity, Number.NaN])
    assert.throws(() => {
      material.emissiveIntensity = bad;
    }, RangeError);
  assert.throws(() => {
    material.emissiveIntensity = '2';
  }, TypeError);
  mesh.destroy();
  s.engine.dispose();
});

test('exportModel writes emissiveIntensity as KHR_materials_emissive_strength over the emissive factor', () =>
  headlessModels(async () => {
    const engine = await headless(),
      material = async (m) =>
        readGLB(await exportModel(createMesh(engine, quad, m), { binary: true })).json.materials[0];
    const strong = await material(new PbrMaterial({ emissive: [1, 0.5, 0], emissiveIntensity: 3 }));
    assert.deepEqual(strong.emissiveFactor, [1, 0.5, 0]);
    assert.deepEqual(strong.extensions.KHR_materials_emissive_strength, { emissiveStrength: 3 });
    const dim = await material(new PbrMaterial({ emissive: [0.5, 0.5, 0.5], emissiveIntensity: 0.5 }));
    assert.deepEqual(
      [dim.emissiveFactor, dim.extensions.KHR_materials_emissive_strength],
      [[0.5, 0.5, 0.5], { emissiveStrength: 0.5 }],
    );
    const plain = await material(new PbrMaterial({ emissive: [0.5, 0.5, 0.5] }));
    assert.equal(plain.extensions?.KHR_materials_emissive_strength, undefined);
    const off = await material(new PbrMaterial({ emissive: [1, 1, 1], emissiveIntensity: 0 }));
    assert.equal(off.emissiveFactor, undefined);
  }));
