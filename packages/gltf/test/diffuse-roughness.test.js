// KHR_materials_diffuse_roughness (draft): parsing, the extended shader and the uniform rows, and the EON maths of the
// shipped WGSL against support/eon-reference.js. The same WGSL runs on a real GPU in
// scripts/test-diffuse-roughness-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extendedMaterials } from '../dist/extended.js';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, parseGLTF } from '../dist/pbr.js';
import { animatedTriangle } from '../../../tests/support/gltf-pbr-fixture.js';
import { eonWgsl, extendedPlan, extendedShader } from '../src/shader.ts';
import { direction, eonAlbedo, eonBRDF, hemisphere } from './support/eon-reference.js';

const name = 'KHR_materials_diffuse_roughness';
const rough = (diffuseRoughnessFactor, extra = {}) => ({ [name]: { diffuseRoughnessFactor, ...extra } });
const off = { iridescence: false, anisotropy: false, diffuseTransmission: false, bump: false, scatter: false };

// The shipped WGSL, run on the CPU for a one-channel albedo: only its type annotations need removing.
const wgsl = new Function(
  `const max=Math.max, clamp=(x,a,b)=>Math.min(Math.max(x,a),b), select=(f,t,c)=>c?t:f, vec3f=(x)=>x,
  vec4f=(rgb,a)=>({rgb,a});
  ${eonWgsl
    .replace(/fn (\w+)\(([^)]*)\)->\w+ /g, (_, fn, args) => `function ${fn}(${args.replace(/:\w+/g, '')}) `)
    .replace(/\blet /g, 'const ')
    .replace(/\}\n|\}$/gm, ';}\n')
    .replace(/;;\}/g, ';}')}
  return {margoEON, margoEONAlbedo};`,
)();

test('the shipped EON lobe matches the paper oracle, is reciprocal and is Lambert at roughness 0', () => {
  for (const rho of [0, 0.18, 0.6, 1])
    for (const r of [0, 1e-6, 0.3, 0.7, 1])
      for (const ti of [0, 0.4, 1, 1.5])
        for (const to of [0, 0.7, 1.45])
          for (const phi of [0, 1.2, Math.PI]) {
            const l = direction(ti),
              v = direction(to, phi),
              st = l[0] * v[0] + l[1] * v[1],
              got = wgsl.margoEON(rho, r, l[2], v[2], st) / Math.PI,
              label = `rho ${rho} r ${r} ${ti} ${to} ${phi}`;
            // The shader's polynomial albedo is within 0.1% of the exact one (paper, Figure 7).
            assert.ok(Math.abs(got - eonBRDF(rho, r, l, v)) < 1e-3, label);
            assert.ok(got >= 0, label);
            assert.ok(Math.abs(got - wgsl.margoEON(rho, r, v[2], l[2], st) / Math.PI) < 1e-12, label);
            if (r === 0) assert.ok(Math.abs(got - rho / Math.PI) < 1e-12, label);
          }
  // By hand: white, r = 1, both directions on the normal: pi f = E(N) + (1 - E(N))^2 / (1 - <E>), with
  // E(N) = 1 / (1 + c1) = 0.776524 and <E> = (1 + c2) / (1 + c1) = 0.832811.
  assert.ok(Math.abs(wgsl.margoEON(1, 1, 1, 1, 0) - 1.07524) < 1e-4);
});

test('energy: a white furnace returns all light and the ambient albedo is the integral of the lobe', () => {
  for (const r of [0.25, 0.6, 1])
    for (const to of [0, 0.8, 1.4]) {
      const v = direction(to),
        lobe = (rho) => hemisphere((l) => wgsl.margoEON(rho, r, l[2], v[2], l[0] * v[0] + l[1] * v[1]) / Math.PI);
      assert.ok(Math.abs(lobe(1) - 1) < 2e-3, `furnace r ${r} ${to}`);
      for (const rho of [0.2, 0.75]) {
        const albedo = wgsl.margoEONAlbedo(rho, r, v[2]);
        assert.ok(Math.abs(albedo - lobe(rho)) < 2e-3, `integral rho ${rho} r ${r} ${to}`);
        assert.ok(Math.abs(albedo - eonAlbedo(rho, r, v[2])) < 1e-3, `oracle rho ${rho} r ${r} ${to}`);
        // Never more than the albedo reflected by a white surface, never negative.
        assert.ok(albedo >= 0 && albedo <= 1);
      }
    }
  // Rough surfaces brighten at grazing views relative to head-on (the extension's "flattening").
  assert.ok(wgsl.margoEONAlbedo(0.5, 1, 0.05) > wgsl.margoEONAlbedo(0.5, 1, 1));
});

test('parse: factor bounds, default 0, the R texture in slot 21, exclusions', () => {
  assert.equal(extendedMaterials.parse({ [name]: {} }), undefined, 'default factor 0 is Lambert');
  assert.equal(extendedMaterials.parse(rough(0, { diffuseRoughnessTexture: { index: 0 } })), undefined);
  for (const bad of [-0.01, 1.01, NaN, Infinity, '0.5'])
    assert.throws(() => extendedMaterials.parse(rough(bad)), /diffuse roughness/, String(bad));
  const factor = extendedMaterials.parse(rough(0.4));
  assert.deepEqual(factor.features, { ...off, bump: false, diffuseRoughness: true });
  assert.equal(factor.maps.length, 8);
  assert.equal(factor.rows[7], 0.4);
  assert.equal(factor.rows.length, 24);
  const mapped = extendedMaterials.parse(rough(1, { diffuseRoughnessTexture: { index: 3, texCoord: 1 } }));
  assert.deepEqual(mapped.maps[8], { index: 3, texCoord: 1 });
  for (const excluded of ['KHR_materials_unlit', 'KHR_materials_pbrSpecularGlossiness'])
    assert.equal(extendedMaterials.parse({ ...rough(1), [excluded]: {} }), undefined, excluded);
  // A material without the extension reads as before: no new key, map or row.
  const other = extendedMaterials.parse({ KHR_materials_iridescence: { iridescenceFactor: 1 } });
  assert.equal('diffuseRoughness' in other.features, false);
  assert.equal(other.maps.length, 8);
  assert.equal(other.rows[7], 0);
});

test('a file that requires the extension needs the materials decoder', () => {
  const { doc, buffers } = animatedTriangle();
  doc.extensionsRequired = doc.extensionsUsed = [name];
  assert.throws(() => new GLTFAsset(doc, buffers), /KHR_materials_diffuse_roughness \(pass a materials decoder\)/);
  assert.doesNotThrow(() => new GLTFAsset(doc, buffers, undefined, { materials: extendedMaterials }));
});

test('shader: only a diffuse-rough plan compiles the lobe, in direct, ambient and back-side transmission', () => {
  const features = { ...off, diffuseTransmission: true, iridescence: true },
    plain = extendedShader(extendedPlan([], features)),
    code = extendedShader(extendedPlan([], { ...features, diffuseRoughness: true }));
  assert.equal(/margoEON|s\.dr|dr:vec2f/.test(plain), false);
  assert.ok(plain.includes('uvt:array<vec4f,42>'));
  assert.ok(code.includes('uvt:array<vec4f,42>') && code.includes('dr:vec2f'));
  assert.ok(code.includes('margoEON(s.base.rgb,s.dr.x,nl,nv,st)'), 'direct, reflected');
  assert.ok(code.includes('margoEON(s.dt.rgb,s.dr.x,back,nv,st)'), 'direct, diffusely transmitted');
  assert.ok(code.includes('sum+=(1-s.metal)*(margoAmbientTerm(i,d,v)-lambert)'), 'ambient hooks (IBL)');
  assert.ok(code.includes('margoEONAlbedo(s.dt.rgb,s.dr.x,s.dr.y)'), 'ambient, back side');
  const maps = Array(22);
  maps[21] = { index: 0 };
  const plan = extendedPlan(maps, { ...off, diffuseRoughness: true }),
    mapped = extendedShader(plan);
  assert.equal(plan.slots.length, 22);
  assert.equal(plan.slots[21], 0);
  assert.ok(mapped.includes('uvt:array<vec4f,44>'));
  assert.ok(mapped.includes('f.aniso.w*textureSample(margoMap0,margoSampler0,uv(i,21)).r'));
});

async function draw(extensions) {
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
    materials: [{ extensions }],
    meshes: [{ primitives: [{ ...primitive, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    textures: [{ source: 0 }],
    images: [{}],
  });
  delete fixture.doc.skins;
  delete fixture.doc.animations;
  const model = parseGLTF(engine, fixture.doc, fixture.buffers, [{ width: 1, height: 1, close() {} }], {
    materials: extendedMaterials,
  });
  store.tick(false);
  const view = context(gpu, { samples: 4, format: 'rgba16float', depthFormat: 'depth32float' }),
    log = gpu.record(() => {
      view.begin(0);
      model.draw(view.c, 'beauty', view.c.color, view.c.depth);
    });
  const out = {
    material: model.primitives[0].material,
    uniform: model['resources'][0].uniform,
    code: log.find((e) => e[0] === 'module')[2].code,
  };
  out.floats = Array.from(out.uniform.contents);
  out.size = out.uniform.binding.size;
  model.dispose();
  engine.dispose();
  return out;
}

test('uniform: the factor sits in the free aniso lane; the texture adds one UV slot (1264 bytes)', async () => {
  const factor = await draw(rough(0.75));
  assert.equal(factor.size, 1232);
  assert.equal(factor.floats[272 + 19], 0.75);
  assert.ok(factor.code.includes('fn margoEON('));
  const mapped = await draw(rough(0.5, { diffuseRoughnessTexture: { index: 0 } }));
  assert.equal(mapped.size, 1264);
  assert.equal(mapped.material.maps.length, 22);
  assert.equal(mapped.floats[280 + 19], 0.5);
  assert.deepEqual(mapped.floats.slice(104 + 21 * 8, 104 + 21 * 8 + 4), [1, 0, 0, 0], 'slot 21 UV row');
});
