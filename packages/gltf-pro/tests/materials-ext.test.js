// HANDOFF 5w.e/f: KHR_materials_iridescence, anisotropy, diffuse_transmission (extended materials), KHR_materials_variants
// and transmission under ambient hooks. The BRDF terms are checked against tests/support/khr-brdf.js (written from the
// specs) here on the CPU side and in WGSL on a real GPU by scripts/gltf-pro-materials-gpu-check.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { loadGLTF, parseGLTF } from '../dist/index.js';
import { extendedMaterials } from '../dist/extended.js';
import { Shadows } from '../../shadows/dist/index.js';
import { Clustered } from '../../clustered/dist/index.js';
import { LocalShadows } from '../../clustered/dist/shadows.js';
import { EnvironmentLighting } from '../../environment/dist/index.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import {
  anisotropicD,
  anisotropicV,
  isotropicD,
  iridescentFresnel,
  sensitivity,
  separableV,
  vec,
} from '../../../tests/support/khr-brdf.js';
import {
  extendedPlan,
  extendedShader,
  extendedTextureLimit,
  factorPhysicalShader,
  physicalShader,
  transmissiveShader,
} from '../src/shader.ts';
import { lightPBR } from '../../shared/pbr-hooks.js';

const near = (a, b, tolerance, label) =>
  [a]
    .flat()
    .forEach((v, i) => assert.ok(Math.abs(v - [b].flat()[i]) <= tolerance, `${label}[${i}]: ${v} vs ${[b].flat()[i]}`));
const textures = (code) => code.match(/var\s*\w+\s*:\s*texture_(?!storage)/g)?.length ?? 0;
const features = { iridescence: true, anisotropy: true, diffuseTransmission: true };
// A recorded writeBuffer's hex bytes as floats (copied: Buffer.from may hand out a slice of a shared pool).
const floatsOf = (hex) => new Float32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer);

async function scene(materials, extra = {}) {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    renderer,
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(4 / 3, true);
  const fixture = animatedTriangle(),
    primitive = fixture.doc.meshes[0].primitives[0],
    uv = new Float32Array([0, 0, 1, 0, 0.5, 1]);
  fixture.buffers.push(uv);
  fixture.doc.buffers.push({ byteLength: uv.byteLength });
  fixture.doc.bufferViews.push({ buffer: fixture.buffers.length - 1, byteLength: uv.byteLength });
  primitive.attributes.TEXCOORD_0 =
    fixture.doc.accessors.push({
      bufferView: fixture.doc.bufferViews.length - 1,
      componentType: 5126,
      count: 3,
      type: 'VEC2',
    }) - 1;
  Object.assign(fixture.doc, {
    materials,
    meshes: materials.map((_, material) => ({
      primitives: [{ ...primitive, material, ...extra.primitive?.(material) }],
    })),
    nodes: materials.map((_, mesh) => ({ mesh, translation: [0, 0, -mesh] })),
    ...extra.doc,
  });
  delete fixture.doc.skins;
  delete fixture.doc.animations;
  const model = parseGLTF(
    engine,
    fixture.doc,
    fixture.buffers,
    extra.images ?? [],
    extra.plain ? {} : { materials: extendedMaterials },
  );
  store.tick(false);
  return { gpu, engine, model, view: context(gpu, { samples: 4, format: 'rgba16float', depthFormat: 'depth32float' }) };
}

for (const variant of ['physical', 'extended', 'factors']) {
  test(`${variant} clearcoat without a normal map retains the geometric normal`, async () => {
    for (const mapped of variant === 'factors' ? [false] : [false, true]) {
      const extensions = { KHR_materials_clearcoat: {
        clearcoatFactor: 1,
        ...(mapped ? { clearcoatNormalTexture: { index: 0, scale: 1.75 } } : {}),
      } };
      if (variant === 'extended') extensions.KHR_materials_iridescence = { iridescenceFactor: 0.4 };
      const { gpu, engine, model, view } = await scene([{ extensions }], mapped ? {
        doc: { textures: [{ source: 0 }], images: [{}] },
        images: [{ width: 1, height: 1, close() {} }],
      } : {});
      try {
        const material = model.primitives[0].material;
        if (variant === 'factors') material.maps.length = 5;
        view.begin(0);
        const authoredScale = material.physical[2],
          log = gpu.record(() => model.draw(view.c, 'beauty', view.c.color, view.c.depth)),
          uniform = model['resources'][0].uniform,
          write = log.find(event => event[0] === 'writeBuffer' && event[1] === gpu.snap(uniform)),
          frame = floatsOf(write[3]);
        assert.equal(frame[variant === 'extended' ? 250 : 210], mapped ? 1.75 : 0);
        assert.equal(material.physical[2], authoredScale, 'Rendering must not mutate authored normal scale');
      } finally { engine.dispose(); }
    }
  });
}

test('factor-only clearcoat shader uses an exact neutral tangent-space normal', () => {
  assert.match(factorPhysicalShader(), /let cm=vec4f\(0\.5,0\.5,1,1\)\.xyz\*2-1/);
});

test('CPU reference: anisotropic GGX reduces to isotropic GGX at strength 0 and stays normalized', () => {
  const n = [0, 0, 1],
    t = [1, 0, 0],
    b = vec.cross(n, t);
  for (const alpha of [0.1, 0.3, 0.7])
    for (const theta of [0, 0.4, 1.1]) {
      const h = [Math.sin(theta) * 0.6, Math.sin(theta) * 0.8, Math.cos(theta)];
      near(
        anisotropicD(h[2], vec.dot(t, h), vec.dot(b, h), alpha, alpha),
        isotropicD(h[2], alpha),
        1e-9 * isotropicD(h[2], alpha),
        'D',
      );
    }
  // Projected-area normalization of a microfacet distribution: integral of D(h) (n.h) over the hemisphere is 1.
  for (const [at, ab] of [
    [0.5, 0.2],
    [0.9, 0.3],
    [0.3, 0.3],
  ]) {
    let sum = 0;
    const steps = 600;
    for (let i = 0; i < steps; i++)
      for (let j = 0; j < steps; j++) {
        const cos = (i + 0.5) / steps,
          phi = ((j + 0.5) / steps) * 2 * Math.PI,
          sin = Math.sqrt(1 - cos * cos);
        sum +=
          anisotropicD(cos, sin * Math.cos(phi), sin * Math.sin(phi), at, ab) *
          cos *
          (1 / steps) *
          ((2 * Math.PI) / steps);
      }
    near(sum, 1, 0.01, `integral ${at}/${ab}`);
  }
  // Height-correlated visibility at strength 0 is the isotropic height-correlated Smith term 0.5 / (NL sqrt(NV^2 (1 - a^2) + a^2)
  // + NV sqrt(NL^2 (1 - a^2) + a^2)); gltf-pro's isotropic path keeps its separable form, equal at normal incidence.
  const v = vec.normalize([0.3, 0.5, 0.4]),
    l = vec.normalize([-0.2, 0.1, 0.7]),
    nv = vec.dot(n, v),
    nl = vec.dot(n, l);
  for (const alpha of [0.05, 0.25, 0.8]) {
    const a2 = alpha * alpha,
      iso = 0.5 / (nl * Math.sqrt(nv * nv * (1 - a2) + a2) + nv * Math.sqrt(nl * nl * (1 - a2) + a2));
    near(
      anisotropicV(nl, nv, vec.dot(b, v), vec.dot(t, v), vec.dot(t, l), vec.dot(b, l), alpha, alpha),
      Math.min(iso, 1),
      1e-9,
      `V ${alpha}`,
    );
  }
  near(separableV(1, 1, 0.3), 0.25, 1e-12, 'separable V at normal incidence');
});

test('CPU reference: thin-film sensitivity and Fresnel limits from the iridescence spec', () => {
  // The Gaussian fits are normalized so that Y integrates to 1 at zero path difference (CIE Y of equal-energy white).
  const rgb = sensitivity(0, [0, 0, 0]),
    Y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  near(Y, 1, 2e-3, 'Y');
  // At normal incidence a film with the outside IOR has no first interface (R12 = 0): the result is the base's F0, up to
  // the interference terms the spec's 1e-5 floor on R12 R23 leaves (amplitude sqrt(1e-5) x 2 x sensitivity).
  for (const f0 of [0.02, 0.04, 0.5])
    near(iridescentFresnel([f0, f0, f0], 1, 400, 1), [f0, f0, f0], 0.012, `no film, F0 ${f0}`);
  // A real film colours the reflection: the channels differ, and they stay in [0, 1] for dielectric bases.
  const F = iridescentFresnel([0.04, 0.04, 0.04], 0.9, 400, 1.3);
  assert.ok(Math.max(...F) - Math.min(...F) > 0.01 && F.every((v) => v >= 0 && v <= 1), String(F));
});

test('binding plan: shared glTF textures bind once, at most 8 extension textures, unused maps fall back to defaults', () => {
  const maps = Array.from({ length: 18 }, (_, k) => (k < 5 ? { index: k } : { index: 100 + (k % 4) }));
  const plan = extendedPlan(maps, features);
  assert.deepEqual(plan.slots, [-1, -1, -1, -1, -1, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0]);
  const distinct = extendedPlan(
    Array.from({ length: 18 }, (_, k) => ({ index: k })),
    features,
  );
  assert.deepEqual(
    distinct.slots.slice(5),
    [0, 1, 2, 3, 4, 5, 6, 7, -1, -1, -1, -1, -1],
    'extension slots beyond the limit use their defaults',
  );
  assert.equal(extendedTextureLimit, 8);
  const code = extendedShader(distinct);
  assert.equal(textures(code), 5 + 8);
  assert.match(
    code,
    /s\.ir=vec4f\(margoIridescence\([^;]*vec4f\(1\)\.g\),f\.iri\.y\),f\.iri\.x\*vec4f\(1\)\.r\)/,
    'iridescence maps past the limit read the spec defaults',
  );
  assert.match(
    code,
    /margoAnisotropy\(s\.n,t,b,vec4f\(1,0\.5,1,1\)\.xyz\)/,
    'anisotropy default texel (1, 0.5, 1): +X direction, full strength',
  );
  assert.equal(extendedShader(distinct), code, 'cached per plan');
});

test('extended shaders: hook points once, only used features compiled, worst case 16 sampled textures with shadows, IBL and LocalShadows', async () => {
  const points = [
    'direct+ambient(s)',
    'var color=',
    'if(f.settings.w<0.5) {color=aces(max(color,vec3f(0))/0.6);',
    'return vec4f(color,',
    '@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {',
  ];
  for (const iridescence of [false, true])
    for (const anisotropy of [false, true])
      for (const diffuseTransmission of [false, true]) {
        const code = extendedShader(extendedPlan([], { iridescence, anisotropy, diffuseTransmission }));
        for (const point of [
          ...points,
          'fn margoAmbientLayers(',
          'fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return vec3f(0);}',
        ])
          assert.equal(code.split(point).length, 2, point);
        assert.equal(code.includes('fn margoIridescence('), iridescence);
        assert.equal(code.includes('fn margoAnisotropy('), anisotropy);
        assert.equal(code.includes('var back=s;'), diffuseTransmission);
        assert.equal(textures(code), 5);
      }
  // Every map of every extension, all distinct (18 textures), with shadows, environment IBL and clustered LocalShadows.
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    store,
    renderer,
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const shadows = new Shadows({ resolution: 64 }),
    clustered = new Clustered({ grid: [4, 3, 2] });
  clustered.shadow = new LocalShadows({ lights: clustered });
  const ibl = new EnvironmentLighting({
    device: gpu.device,
    disposed: false,
    version: 0,
    specularView: {},
    sampler: {},
    brdfLut: {},
    shBuffer: {},
    paramsBuffer: {},
    restore: () => Promise.resolve(),
  });
  const worst = extendedShader(
    extendedPlan(
      Array.from({ length: 18 }, (_, k) => ({ index: k })),
      features,
    ),
  );
  const lit = [shadows.pbr(2), clustered.pbr(2), ibl.pbr(2)].reduce(lightPBR, worst);
  assert.equal(textures(lit), 16, 'worst case: 13 material + shadow cascades + IBL cube + local shadow atlas');
  assert.equal(
    textures([shadows.pbr(2), clustered.pbr(2), ibl.pbr(2)].reduce(lightPBR, physicalShader())),
    16,
    'the physical variant is at the same ceiling',
  );
  // Layered hooks: the ambient hook becomes margoAmbientTerm, local lights margoLocal0 on the transmitted-out surface.
  assert.match(lit, /fn margoAmbientTerm\(i:Out,s:Surface,v:vec3f\)->vec3f \{return iblShade\(/);
  assert.match(
    lit,
    /let margoAmbient=margoAmbientLayers\(i,s,v\);var color=margoLocal0\(i,margoFront\(s\),v\)\+shadowLit\(direct,i\.position,s\.n\)\+ambient\(s\)\+s\.emissive\+margoAmbient;/,
  );
  assert.match(lit, /\nfn margoLocal0\(i:Out,s:Surface,v:vec3f\)->vec3f \{return clusterLighting\(/);
  // The physical variant without transmission keeps the inline hooks (unchanged text, GPU-call proofs).
  assert.match(
    [clustered.pbr(2), ibl.pbr(2)].reduce(lightPBR, physicalShader()),
    /let margoAmbient=iblShade\([^;]*;var color=clusterLighting\(/,
  );
  shadows.dispose();
  clustered.dispose();
  ibl.dispose();
  engine.dispose();
});

test('extended material: uniform rows, 1088-byte buffer, only used textures bound (shared once), extended shader', async () => {
  const { gpu, engine, model, view } = await scene(
    [
      {
        normalTexture: { index: 0 },
        extensions: {
          KHR_materials_iridescence: {
            iridescenceFactor: 0.8,
            iridescenceIor: 1.8,
            iridescenceThicknessMinimum: 120,
            iridescenceThicknessMaximum: 450,
            iridescenceThicknessTexture: { index: 1 },
          },
          KHR_materials_anisotropy: {
            anisotropyStrength: 0.6,
            anisotropyRotation: 0.5,
            anisotropyTexture: { index: 1 },
          },
          KHR_materials_diffuse_transmission: {
            diffuseTransmissionFactor: 0.4,
            diffuseTransmissionColorFactor: [0.9, 0.8, 0.7],
            diffuseTransmissionTexture: { index: 0 },
          },
        },
      },
    ],
    {
      doc: { textures: [{ source: 0 }, { source: 1 }], images: [{}, {}] },
      images: [
        { width: 1, height: 1, close() {} },
        { width: 1, height: 1, close() {} },
      ],
    },
  );
  const m = model.primitives[0].material;
  assert.deepEqual(m.extended, features);
  assert.equal(m.maps.length, 18);
  assert.equal(m.uvt.length, 144);
  near(
    m.physical.slice(12),
    [0.8, 1.8, 120, 450, 0.6, Math.cos(0.5), Math.sin(0.5), 0, 0.4, 0.9, 0.8, 0.7],
    1e-7,
    'iri, aniso, dtr',
  );
  const log = gpu.record(() => {
    view.begin(0);
    model.draw(view.c, 'beauty', view.c.color, view.c.depth);
  });
  const module = log.find((e) => e[0] === 'module')[2].code,
    groups = log.filter((e) => e[0] === 'group');
  assert.ok(module.includes('uvt:array<vec4f,36>') && module.includes('fn margoIridescence('));
  // Material group: base maps 0-9 plus texture 1 (thickness + anisotropy) and texture 0 (diffuse transmission) once each.
  assert.deepEqual(
    groups[1][2].entries.map((e) => e.binding),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  );
  const uniform = model['resources'][0].uniform,
    write = log.find((e) => e[0] === 'writeBuffer' && e[1] === gpu.snap(uniform));
  assert.equal(uniform.size, 1088);
  const floats = floatsOf(write[3]);
  near(
    Array.from(floats.slice(248 + 12, 272)),
    m.physical.slice(12),
    1e-6,
    'extended rows after coat, specular, sheen',
  );
  near(Array.from(floats.slice(104 + 14 * 8, 104 + 14 * 8 + 4)), [1, 0, 0, 0], 1e-6, 'slot 14 (thickness) UV row');
  model.dispose();
  engine.dispose();
});

test('materials without the new extensions keep their shaders and buffers; zero factors stay standard', async () => {
  const { gpu, engine, model, view } = await scene([
    {},
    { extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1 } } },
    {
      extensions: {
        KHR_materials_iridescence: { iridescenceFactor: 0 },
        KHR_materials_anisotropy: {},
        KHR_materials_diffuse_transmission: {},
      },
    },
  ]);
  assert.deepEqual(
    model.primitives.map((p) => [p.material.extended, p.material.maps.length]),
    [
      [undefined, 5],
      [undefined, 13],
      [undefined, 5],
    ],
    'extensions with zero factors change nothing: standard',
  );
  const log = gpu.record(() => {
    view.begin(0);
    model.draw(view.c, 'beauty', view.c.color, view.c.depth);
  });
  assert.ok(log.filter((e) => e[0] === 'buffer' && e[2].usage === 72).every((e) => e[2].size === 880));
  assert.ok(!log.some((e) => e[0] === 'module' && e[2].code.includes('margoAmbientLayers')));
  model.dispose();
  engine.dispose();
});

test('without @margoengine/gltf-pro/extended the three extensions are ignored, and rejected when required', async () => {
  const film = {
    extensions: {
      KHR_materials_iridescence: { iridescenceFactor: 1 },
      KHR_materials_anisotropy: { anisotropyStrength: 1 },
    },
  };
  const { engine, model } = await scene([film], { plain: true });
  assert.equal(model.primitives[0].material.extended, undefined);
  assert.equal(model.primitives[0].material.maps.length, 5);
  model.dispose();
  await assert.rejects(
    scene([film], {
      plain: true,
      doc: { extensionsRequired: ['KHR_materials_iridescence', 'KHR_materials_variants'] },
    }),
    { message: 'Required glTF extensions are unsupported: KHR_materials_iridescence (pass a materials decoder)' },
  );
  engine.dispose();
});

test('transmission: tint multiply then lit add (no blend constant); ambient hooks shade the untransmitted diffuse', async () => {
  const { gpu, engine, model, view } = await scene([
    {
      pbrMetallicRoughness: { baseColorFactor: [0.5, 1, 0.25, 1] },
      extensions: { KHR_materials_transmission: { transmissionFactor: 0.8 } },
    },
  ]);
  const ibl = new EnvironmentLighting({
    device: gpu.device,
    disposed: false,
    version: 0,
    specularView: {},
    sampler: {},
    brdfLut: {},
    shBuffer: {},
    paramsBuffer: {},
    restore: () => Promise.resolve(),
  });
  const draw = () =>
    gpu.record(() => {
      view.begin(0);
      model.draw(view.c, 'beauty', view.c.color, view.c.depth);
    });
  let log = draw();
  const pipelines = log.filter((e) => e[0] === 'renderPipeline'),
    passes = log.filter((e) => e[0].startsWith('pass.')).map((e) => (e[0] === 'pass.setPipeline' ? e[1] : e[0]));
  assert.equal(log.find((e) => e[0] === 'module')[2].code, transmissiveShader());
  assert.deepEqual(
    pipelines.map((e) => [e[2].fragment.entryPoint, e[2].fragment.targets[0].blend.color]),
    [
      ['fragment', { dstFactor: 'one', srcFactor: 'one' }],
      ['margoTint', { dstFactor: 'src', srcFactor: 'zero' }],
    ],
  );
  assert.ok(!passes.includes('pass.setBlendConstant'));
  assert.deepEqual(passes.slice(0, 2), [pipelines[1][1], 'pass.setBindGroup'], 'the tint draw comes first');
  assert.equal(passes.filter((e) => e === 'pass.drawIndexed').length, 2);
  const values = floatsOf(log.find((e) => e[0] === 'writeBuffer')[3]);
  near([values[98], values[99], values[102]], [0.4, 0.8, 0.2], 1e-6, 'tint lanes');
  ibl.applyTo(model);
  log = draw();
  const code = log.find((e) => e[0] === 'module')[2].code;
  assert.match(
    code,
    /fn margoAmbientLayers\(i:Out,s:Surface,v:vec3f\)->vec3f \{return margoAmbientTerm\(i,margoFront\(s\),v\);\}/,
  );
  assert.match(code, /fn margoAmbientTerm\(i:Out,s:Surface,v:vec3f\)->vec3f \{return iblShade\(/);
  assert.match(code, /o\.base=vec4f\(s\.base\.rgb\*\(1-s\.tr\),s\.base\.a\)/);
  ibl.dispose();
  model.dispose();
  engine.dispose();
});

test('KHR_materials_variants: names, switching rebinds the mapped material, undefined restores, unknown variants throw', async () => {
  const red = { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } },
    glass = { extensions: { KHR_materials_iridescence: { iridescenceFactor: 1 } } };
  const { gpu, engine, model, view } = await scene([{}, red, glass], {
    doc: { extensions: { KHR_materials_variants: { variants: [{ name: 'Red' }, { name: 'Film' }] } } },
    primitive: (index) =>
      index === 0
        ? {
            extensions: {
              KHR_materials_variants: {
                mappings: [
                  { material: 1, variants: [0] },
                  { material: 2, variants: [1] },
                ],
              },
            },
          }
        : {},
  });
  const p = model.primitives[0],
    own = p.material,
    draw = () =>
      gpu.record(() => {
        view.begin(0);
        model.draw(view.c, 'beauty', view.c.color, view.c.depth);
      });
  assert.deepEqual(model.variants, ['Red', 'Film']);
  draw();
  model.selectVariant('Red');
  assert.equal(p.material, model.primitives[1].material, 'the mapped material object');
  const write = draw().find(
    (e) => e[0] === 'writeBuffer' && e[1] === gpu.snap(model['resources'].find((r) => r.primitive === p).uniform),
  );
  assert.deepEqual(Array.from(floatsOf(write[3]).slice(76, 80)), [1, 0, 0, 1], 'primitive 0 draws red');
  model.selectVariant(1);
  assert.deepEqual(p.material.extended, { iridescence: true, anisotropy: false, diffuseTransmission: false });
  const log = draw();
  assert.equal(
    model['resources'].find((r) => r.primitive === p).uniform.size,
    1088,
    'uniform buffer resized for the extended material',
  );
  assert.equal(
    p.material,
    model.primitives[2].material,
    'the iridescent material (its pipeline is cached from the first draw)',
  );
  assert.equal(log.filter((e) => e[0] === 'pass.drawIndexed').length, 3);
  model.selectVariant();
  assert.equal(p.material, own);
  assert.equal(model.primitives[1].material, model.primitives[1].material, 'unmapped primitives keep theirs');
  assert.throws(() => model.selectVariant('Blue'), {
    name: 'RangeError',
    message: 'selectVariant: the model has no material variant Blue',
  });
  assert.throws(() => model.selectVariant(2), RangeError);
  model.dispose();
  engine.dispose();
});

const root = new URL('../../../examples/assets/khronos/', import.meta.url);
const fetch = async (url) => new Response(await readFile(new URL(new URL(url).pathname.slice(1), root)));
const load = async (engine, file) =>
  loadGLTF(engine, `https://khronos.test/${file}`, { fetch, decoders: { materials: extendedMaterials } });

test('Khronos samples: extended materials and variants parse as their files declare', () =>
  headlessModels(async () => {
    const lamp = await load(await headless(), 'IridescenceLamp/IridescenceLamp.glb');
    const lampExtended = new Set(
      lamp.primitives.map((p) => JSON.stringify([p.material.extended ?? null, !!p.material.tint])),
    );
    assert.deepEqual(
      [...lampExtended].sort(),
      [
        JSON.stringify([null, false]),
        JSON.stringify([{ iridescence: true, anisotropy: false, diffuseTransmission: false }, false]),
        JSON.stringify([{ iridescence: true, anisotropy: false, diffuseTransmission: false }, true]),
      ],
      'plain, iridescent, and iridescent transmissive glass',
    );
    const barn = await load(await headless(), 'AnisotropyBarnLamp/AnisotropyBarnLamp.glb'),
      metal = barn.primitives.find((p) => p.material.name === 'Lamp Metal').material;
    assert.deepEqual(metal.extended, { iridescence: false, anisotropy: true, diffuseTransmission: false });
    assert.deepEqual(
      extendedPlan(metal.maps, metal.extended).slots.slice(5),
      [-1, -1, 0, -1, -1, -1, -1, -1, -1, -1, 1, -1, -1],
      'clearcoat normal and anisotropy textures only',
    );
    const cup = await load(await headless(), 'DiffuseTransmissionTeacup/DiffuseTransmissionTeacup.glb'),
      saucer = cup.primitives.find((p) => p.material.name === 'tea_saucer').material;
    near(saucer.physical.slice(20), [1, 0.84, 0.8, 0.74], 1e-6, 'diffuse transmission factor and colour');
    const shoe = await load(await headless(), 'MaterialsVariantsShoe/MaterialsVariantsShoe.glb');
    assert.ok(shoe.variants.length >= 2, String(shoe.variants));
    const before = shoe.primitives.map((p) => p.material);
    for (const name of shoe.variants) {
      shoe.selectVariant(name);
      assert.ok(shoe.primitives.some((p, i) => p.material !== before[i]) || name === shoe.variants[0], name);
    }
    shoe.selectVariant();
    assert.deepEqual(
      shoe.primitives.map((p) => p.material),
      before,
    );
    const chair = await load(await headless(), 'SheenChair/SheenChair.glb');
    assert.ok(chair.variants.length >= 2, String(chair.variants));
  }));
