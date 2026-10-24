// Material features on createMesh meshes, recorded on a mock device: the shader text each option adds (and that it adds
// none while unused), its bindings and live uniforms. browser-check.mjs checks the rendered values on a real adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { Clustered } from '../../clustered/dist/index.js';
import { LocalShadows } from '../../clustered/dist/shadows.js';
import { DirectionalLights } from '../../clustered/dist/directional.js';
import { Shadows } from '../../shadows/dist/index.js';
import {
  LambertMaterial,
  NormalMaterial,
  UnlitMaterial,
  PbrMaterial,
  PhongMaterial,
  ShadowCatcherMaterial,
  Texture,
  WgslMaterial,
  clearcoat,
  createInstancedMesh,
  createMesh,
  materialLobes,
  nodeMaterial,
} from '../dist/index.js';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import { NodeMaterial, normalLocal, positionLocal } from '../../shader/dist/index.js';
import { Fog } from '../../environment/dist/index.js';
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
const codeOf = (log, id) => log.find((e) => e[0] === 'module' && e[1] === id)?.[2].code;
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

test('extra directional lights (clustered/directional) shade Lambert and Phong with their BRDF and count in a catcher', async () => {
  const s = await scene(),
    lights = Clustered.attach(s.engine),
    suns = DirectionalLights.attach(s.engine, { lights });
  suns.setLights([{ direction: [0, -1, -1], intensity: 2 }]);
  const meshes = [new PbrMaterial(), new LambertMaterial(), new PhongMaterial(), new ShadowCatcherMaterial()].map(
    (m) => {
      const mesh = createMesh(s.engine, quad, m);
      lights.add(mesh);
      return mesh;
    },
  );
  const lit = codes(s.frame()).filter((code) => code.includes('clusterDirectional.lights[j]')),
    ggx = 'result+=((1-fresnel)*(1-metal)*base/3.14159265+d*g*fresnel/max(4*nl*nv,0.0001))*nl*';
  const loops = lit.map((code) => lightLoop(code));
  assert.ok(
    loops.some((loop) => loop.split(ggx).length === 3),
    'standard: GGX in the point and directional loops',
  );
  assert.ok(
    loops.filter((loop) => !loop.includes(ggx) && loop.split('result+=margoLocalBrdf(n,v,l,base)*nl*').length === 3)
      .length >= 2,
    'Lambert and Phong: their BRDF in both loops',
  );
  const catcher = lit.find((code) => code.includes('fn margoCatcher('));
  assert.ok(
    catcher.includes('let margoLocal=dot(clusterLighting('),
    'unshadowed: lights the shadow of the sun as the rest',
  );
  for (const mesh of meshes) mesh.destroy();
  suns.dispose();
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
const off = {
  alphaMap: null,
  bumpMap: null,
  displacementMap: null,
  lightMap: null,
  flatShading: false,
  vertexColors: true,
  fog: true,
  toneMapped: true,
};
const defaults = {
  ...off,
  bumpScale: 1,
  displacementScale: 1,
  displacementBias: 0,
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
  flatShading: true,
  vertexColors: false,
  fog: false,
  toneMapped: false,
});

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

test('flatShading shades with the face normal for lit, normal and matcap shading; unlit ignores it', async () => {
  const s = await scene(),
    materials = [new LambertMaterial(), new NormalMaterial(), new UnlitMaterial()].map((m) =>
      Object.assign(m, { flatShading: true }),
    ),
    meshes = materials.map((m) => createMesh(s.engine, quad, m));
  const flat = codes(s.frame()).filter((c) => c.includes('let n=normalize(cross(dpdy(i.position),dpdx(i.position)));'));
  assert.equal(flat.length, 2, 'Lambert and normal, not unlit');
  assert.ok(flat.every((c) => !c.includes('let n=normalize(i.normal)*select(-1.0,1.0,facing);')));
  assert.throws(() => {
    materials[0].flatShading = 1;
  }, TypeError);
  materials[0].flatShading = false;
  const smooth = codes(s.frame());
  assert.ok(
    smooth.length === 1 && smooth[0].includes('let n=normalize(i.normal)*select(-1.0,1.0,facing);'),
    'off again, live: the smooth variant',
  );
  for (const mesh of meshes) mesh.destroy();
  s.engine.dispose();
});

test('tangent-space maps and anisotropy point the derived frame up bottom-left-origin UVs (+b); other materials keep the text', async () => {
  const s = await scene(),
    tilt = solid(128, 200, 200),
    materials = [
      new PbrMaterial({ map: tilt }),
      new PbrMaterial({ normalMap: tilt }),
      new PbrMaterial({ clearcoat: 1, clearcoatNormalMap: tilt }),
      new PbrMaterial({ anisotropy: 0.5, anisotropyRotation: 1 }),
    ],
    meshes = materials.map((m) => createMesh(s.engine, quad, m)),
    signs = codes(s.frame()).map((c) => /return mat3x3f\(t\*scale,(-?)b\*scale,n\);/.exec(c)?.[1]);
  // gltf-pro's frame (glTF: B toward decreasing v) only for the material without one; b = cross(n, t) * w untouched.
  assert.deepEqual(signs.sort(), ['', '', '', '-']);
  for (const mesh of meshes) mesh.destroy();
  s.engine.dispose();
});

test('extension lobes sampling a tangent-space map take the materials frame (+b) on createMesh meshes, not on glTF', async () => {
  const s = await scene(),
    texture = { view: s.gpu.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 4 }).createView() },
    graph = (normal) => ({
      nodes: [
        {
          type: 'emit',
          color: { type: 'color', value: [1, 1, 1, 1] },
          ...(normal ? { normal: { type: 'normalMap', texture: { type: 'texture', texture } } } : {}),
        },
      ],
    }),
    // glTF quad without TANGENT: the same extension keeps glTF's B (decreasing v) there.
    doc = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 60 }],
      bufferViews: [{ buffer: 0, byteLength: 60 }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC2', byteOffset: 36 },
      ],
      materials: [{}],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
      nodes: [{ mesh: 0 }],
    },
    gltf = () => parseGLTF(s.engine, doc, [new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 0])]);
  const sign = (model, extension) => {
    model.primitives[0].extension = extension;
    const found = codes(s.frame()).map((c) => /return mat3x3f\(t\*scale,(-?)b\*scale,n\);/.exec(c)?.[1]);
    model.destroy();
    return found.join();
  };
  const mesh = () => createMesh(s.engine, quad, new PbrMaterial());
  assert.equal(sign(mesh(), clearcoat({ factor: 1, clearcoatNormalTexture: texture })), '');
  assert.equal(sign(mesh(), materialLobes({ anisotropy: { strength: 1 } })), '');
  assert.equal(sign(mesh(), nodeMaterial(graph(true))), '');
  // Feature off: lobes without a tangent-space map, and a physical material with maps but no normal map, keep the text.
  assert.equal(sign(mesh(), clearcoat({ factor: 1 })), '-');
  assert.equal(sign(mesh(), materialLobes({ sheen: { colorFactor: [1, 1, 1] } })), '-');
  assert.equal(sign(mesh(), nodeMaterial(graph(false))), '-');
  assert.equal(sign(createMesh(s.engine, quad, new PbrMaterial({ sheen: 1, sheenColorMap: solid(9, 9, 9) }))), '-');
  assert.equal(sign(gltf(), clearcoat({ factor: 1, clearcoatNormalTexture: texture })), '-');
  s.engine.dispose();
});

test('vertexColors false passes white from the vertex stage; instance tints still multiply in', async () => {
  const s = await scene(),
    material = new PbrMaterial({ vertexColors: false }),
    meshes = [createMesh(s.engine, quad, material), createInstancedMesh(s.engine, quad, material, 1)];
  meshes[1].instances.count = 1;
  const all = codes(s.frame());
  assert.ok(all.some((c) => c.includes('o.uv=i.uv; o.color=vec4f(1); return o;')));
  assert.ok(
    all.some((c) => c.includes('o.color=vec4f(1)*k.tint;')),
    'instanced',
  );
  assert.ok(all.every((c) => !c.includes('o.color=i.color')));
  assert.throws(() => {
    material.vertexColors = 'no';
  }, TypeError);
  for (const mesh of meshes) mesh.destroy();
  s.engine.dispose();
});

test('fog false keeps a lit material out of the scene fog; toneMapped false clamps instead of tone mapping', async () => {
  const s = await scene(),
    fog = Fog.attach(s.engine, { color: '#ff00ff', near: 0, far: 1 }),
    materials = [
      new PhongMaterial({ fog: false }),
      new LambertMaterial({ toneMapped: false }),
      new PbrMaterial({ fog: false, toneMapped: false }),
      new UnlitMaterial({ fog: false, toneMapped: true }),
    ],
    meshes = materials.map((m) => createMesh(s.engine, quad, m));
  for (const mesh of meshes) fog.add(mesh);
  const lit = codes(s.frame()).filter((c) => c.includes('fogAmount(i.position,f.eye.xyz)'));
  const phong = lit.find((c) => c.includes('mat_phong')),
    lambert = lit.find((c) => c.includes('fn margoFront(s:Surface)') && !c.includes('mat_phong')),
    both = lit.find((c) => c.includes('margoUnfogged') && c.includes('margoNeutral'));
  assert.ok(
    phong.includes(',fogAmount(i.position,f.eye.xyz));if(f.settings.w<0.5) {}color=margoUnfogged;'),
    'fog mixed, then dropped',
  );
  assert.ok(!phong.includes('margoNeutral'), 'still tone mapped');
  assert.ok(lambert.includes('fn pbrNeutral(input:vec3f)->vec3f {return min(input,vec3f(1));}\nfn margoNeutral('));
  assert.ok(!lambert.includes('margoUnfogged'), 'still fogged');
  assert.ok(both, 'both together');
  assert.equal(lit.length, 4, 'the unlit material is unchanged (it is neither fogged nor tone mapped)');
  assert.deepEqual(
    [new PbrMaterial().toneMapped, new UnlitMaterial().toneMapped, new NormalMaterial().toneMapped],
    [true, false, false],
    'defaults',
  );
  assert.throws(() => {
    materials[0].fog = 0;
  }, TypeError);
  s.engine.removePlugin(fog.name);
  for (const mesh of meshes) mesh.destroy();
  s.engine.dispose();
});

test('ShadowCatcherMaterial draws its colour with the shadowed share of sun and clustered light as alpha', async () => {
  for (const hook of [false, true]) {
    const s = await scene(),
      catcher = new ShadowCatcherMaterial({ color: '#204060', opacity: 0.6 }),
      mesh = createMesh(s.engine, quad, catcher),
      remove = casters(s.engine, mesh, hook);
    assert.deepEqual([catcher.shading, catcher.transparent, catcher.opacity], ['lambert', true, 0.6]);
    const log = s.frame(),
      beauty = codes(log).filter((c) => c.includes('fn margoCatcher(')),
      code = beauty.find((c) => c.includes('@fragment fn fragment('));
    assert.ok(code.includes('let margoShadow=margoCatcher(i,s); color=f.base.rgb;'), 'its own colour');
    assert.ok(code.includes('return vec4f(color,margoShadow);'), 'the shadow as alpha');
    assert.ok(code.includes('var lit=sun*shadowVisibility(i.position,n); var all=sun;'), 'the sun, shadowed and not');
    const unshadowed = /fn margoCatcherLights\([\s\S]*?\n\}/.exec(code)[0];
    assert.ok(!/clusterShadow/.test(unshadowed) && unshadowed.includes('margoLocalBrdf'), 'Lambert lights, unshadowed');
    assert.ok(code.includes('lit+=dot(clusterLighting(') && code.includes('all+=dot(margoCatcherLights('));
    assert.ok(!code.includes('return 0.0;}'), 'the placeholder is gone');
    const pipeline = log.find(
      (e) => e[0] === 'renderPipeline' && e[2].fragment?.module && codeOf(log, e[2].fragment.module) === code,
    );
    assert.ok(
      pipeline[2].fragment.targets[0].blend && !pipeline[2].depthStencil.depthWriteEnabled,
      'blended, no depth',
    );
    remove();
    mesh.destroy();
    s.engine.dispose();
  }
  // Clones are catchers too; with no shadowing effect the alpha is 0 everywhere.
  const s = await scene(),
    mesh = createMesh(s.engine, quad, new ShadowCatcherMaterial().clone()),
    code = codes(s.frame()).find((c) => c.includes('fn margoCatcher(') && c.includes('@fragment fn fragment('));
  assert.ok(code.includes('var lit=sun; var all=sun;\n  return f.base.a*select('));
  mesh.destroy();
  s.engine.dispose();
});

const shade = `fn shade(i: Out, s: Surface) -> Surface {
  var o = s;
  o.base = vec4f(uniforms.tint * textureSample(noise, noiseSampler, i.uv.xy).rgb * uniforms.gain, 1.0);
  return o;
}`;

test('WgslMaterial validates its WGSL entry points and names, uniforms and textures', () => {
  const ok = { wgsl: shade, uniforms: { tint: [1, 1, 1], gain: 1 }, textures: { noise: solid(1, 2, 3) } };
  assert.equal(new WgslMaterial(ok).shading, 'standard');
  for (const [options, error] of [
    [{}, TypeError],
    [{ wgsl: 'fn shade(i: Out) -> Surface {}' }, TypeError],
    [{ ...ok, wgsl: shade + '\nfn displace(i: Out) -> vec3f {return vec3f(0);}' }, TypeError],
    [{ ...ok, uniforms: { 'bad-name': 1 } }, TypeError],
    [{ ...ok, uniforms: { margoTint: 1 } }, TypeError],
    [{ ...ok, uniforms: { f: 1 } }, TypeError],
    [{ ...ok, uniforms: { tint: [1, 2, 3, 4, 5] } }, TypeError],
    [{ ...ok, uniforms: { tint: [1] } }, TypeError],
    [{ ...ok, uniforms: { tint: [1, Infinity, 1] } }, RangeError],
    [{ ...ok, textures: { noise: {} } }, TypeError],
    [{ ...ok, textures: { gain: solid(0, 0, 0) } }, TypeError],
  ])
    assert.throws(() => new WgslMaterial(options), error, JSON.stringify(Object.keys(options)));
  const m = new WgslMaterial(ok);
  assert.throws(() => {
    m.uniforms.tint = 2;
  }, TypeError);
  assert.throws(() => {
    m.uniforms.extra = 2;
  }, TypeError);
  assert.throws(() => {
    m.textures.noise = null;
  }, TypeError);
});

test('WgslMaterial splices shade() and displace(), binds its uniforms and textures, all live', async () => {
  const s = await scene(),
    noise = solid(10, 20, 30),
    material = new WgslMaterial({
      shading: 'basic',
      wgsl: `${shade}\nfn displace(i: Input) -> vec3f {return i.position.xyz * uniforms.gain;}`,
      uniforms: { tint: [1, 0.5, 0.25], gain: 2 },
      textures: { noise },
    }),
    mesh = createMesh(s.engine, quad, material);
  let log = s.frame();
  const code = codes(log).find((c) => c.includes('fn shade('));
  assert.ok(
    code.startsWith(
      'struct WgslUniforms {@align(16) tint:vec3f, @align(16) gain:f32}\n@group(2) @binding(48) var<uniform> uniforms:WgslUniforms;\n@group(2) @binding(50) var noise:texture_2d<f32>;\n@group(2) @binding(51) var noiseSampler:sampler;\n',
    ),
  );
  assert.ok(
    code.includes('fn surface(i:Out,front:bool)->Surface {\n  _=&uniforms;_=noise;_=noiseSampler;'),
    'every binding stays in the layout',
  );
  assert.ok(/s=shade\(i,s\);\n {2}if\(margoFaceTest&&!facing/.test(code), 'before the face and alpha tests');
  assert.ok(code.includes('let p=f.model*vec4f(displace(i),1);'));
  assert.ok(code.endsWith(`${material.wgsl}\n`));
  const uniform = log
      .find((e) => e[0] === 'group' && e[2].entries.some((x) => x.binding === 48))[2]
      .entries.find((x) => x.binding === 48).resource.buffer,
    written = () => [...floats(log.filter((e) => e[0] === 'writeBuffer' && e[1] === uniform).at(-1)[3])];
  assert.deepEqual(written(), [1, 0.5, 0.25, 0, 2, 0, 0, 0]);
  material.uniforms.gain = 3;
  material.uniforms.tint[1] = 0.75;
  assert.deepEqual([...material.uniforms.tint], [1, 0.75, 0.25]);
  log = s.frame();
  assert.deepEqual(written(), [1, 0.75, 0.25, 0, 3, 0, 0, 0], 'live, also element by element');
  assert.deepEqual(codes(log), [], 'no new shader');
  const copy = material.clone();
  copy.uniforms.gain = 9;
  assert.equal(material.uniforms.gain, 3, 'a clone has its own uniforms');
  assert.equal(copy.textures.noise, noise, 'and shares the textures');
  material.textures.noise = solid(1, 1, 1);
  log = s.frame();
  assert.ok(
    log.some((e) => e[0] === 'group' && e[2].entries.some((x) => x.binding === 50)),
    'a texture swap rebinds',
  );
  assert.deepEqual(codes(log), [], 'with the same shader');
  mesh.destroy();
  s.engine.dispose();
});

test('Lambertian lightMap response converts physical irradiance in the existing uniform and keeps raw intensity live', async () => {
  const s = await scene();
  const texture = new Texture(
    { data: new Uint8Array(16).fill(255), width: 2, height: 2 },
    { colorSpace: 'linear', mipmaps: false },
  );
  const material = new PbrMaterial({ lightMap: texture, lightMapIntensity: 1, lightMapResponse: 'lambertian' });
  const mesh = createMesh(s.engine, quad, material);
  try {
    assert.equal(material.lightMapResponse, 'lambertian');
    assert.equal(material.lightMapIntensity, 1);
    let log = s.frame();
    assert.equal(featureUniform(log, s.history)[3], Math.fround(1 / Math.PI));
    const modules = codes(log);
    assert.ok(modules.some((code) => code.includes('margoLightMap')));
    assert.ok(
      !log.some((e) => e[0] === 'view' && e[2]?.format === 'rgba8unorm-srgb'),
      'explicit linear irradiance stays linear',
    );
    material.lightMapIntensity = 12;
    log = s.frame();
    assert.equal(featureUniform(log, s.history)[3], Math.fround(12 / Math.PI));
    assert.equal(material.lightMapIntensity, 12);
    assert.deepEqual(codes(log), [], 'response/intensity updates keep shader and bindings');
    material.lightMapResponse = 'multiply';
    assert.equal(featureUniform(s.frame(), s.history)[3], 12);
    material.lightMapResponse = 'lambertian';
    const clone = material.clone(),
      copy = new PbrMaterial().copy(material);
    for (const other of [clone, copy]) {
      assert.equal(other.lightMapResponse, 'lambertian');
      assert.equal(other.lightMapIntensity, 12);
      assert.equal(other.lightMap, texture);
      const next = createMesh(s.engine, quad, other);
      assert.ok(featureWrites(s.frame(), s.history).some((values) => values[3] === Math.fround(12 / Math.PI)));
      other.lightMapResponse = 'multiply';
      assert.equal(material.lightMapResponse, 'lambertian');
      next.destroy();
      other.dispose();
    }
  } finally {
    mesh.destroy();
    material.dispose();
    texture.dispose();
    s.engine.dispose();
  }
});

test('Lambertian lightMap response rejects invalid dormant modes and intensities before changing live state', () => {
  const material = new LambertMaterial({ lightMapIntensity: 2, lightMapResponse: 'lambertian' });
  for (const bad of [null, 1, '', 'physical']) {
    assert.throws(() => {
      material.lightMapResponse = bad;
    }, TypeError);
    assert.equal(material.lightMapResponse, 'lambertian');
    assert.equal(material.lightMapIntensity, 2);
  }
  for (const bad of [-1, Infinity, NaN, 2 ** 128]) {
    assert.throws(() => {
      material.lightMapIntensity = bad;
    }, RangeError);
    assert.equal(material.lightMapIntensity, 2);
  }
  for (const Ctor of [UnlitMaterial, NormalMaterial])
    assert.throws(() => new Ctor({ lightMapResponse: 'lambertian' }), /lightMapResponse.*lit|Lambertian.*lit/);
  assert.throws(() => new PbrMaterial({ lightMapIntensity: -2, lightMapResponse: 'lambertian' }), RangeError);
  const legacy = new PbrMaterial({ lightMapIntensity: -2 });
  assert.equal(legacy.lightMapResponse, 'multiply');
  assert.throws(() => {
    legacy.lightMapResponse = 'lambertian';
  }, RangeError);
  assert.equal(legacy.lightMapResponse, 'multiply');
  assert.equal(legacy.lightMapIntensity, -2);
  legacy.dispose();
  material.dispose();
});
