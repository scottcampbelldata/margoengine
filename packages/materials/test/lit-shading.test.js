// Lambert and Phong shading: options, the WGSL rewrite, lighting-hook composition and the glTF export mapping.
// The rendered values are checked on a real adapter by browser-check.mjs (lambert, phong, phongFog, iblLambert, litEffects).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Material, createMesh, materialShader } from '../dist/index.js';
import { pbrShader, extendedPBRShader } from '../../gltf-pro/src/shader.ts';
import { lightPBR } from '../../shared/pbr-hooks.js';
import { Shadows } from '../../shadows/dist/index.js';
import { Clustered } from '../../clustered/dist/index.js';
import { exportModel } from '../../exporters/dist/model.js';
import { readGLB } from '../../exporters/tests/helpers.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('lambert and phong materials validate their options and bind the live Phong uniform', () => {
  const phong = new Material({ shading: 'phong' });
  assert.deepEqual(
    phong.specular.map((c) => c.toFixed(5)),
    ['0.00561', '0.00561', '0.00561'],
    'default sRGB #111111, linear',
  );
  assert.equal(phong.shininess, 30);
  assert.equal(new Material({ shading: 'lambert' }).shading, 'lambert');
  for (const shininess of [-1, Number.NaN, Infinity])
    assert.throws(() => new Material({ shading: 'phong', shininess }), RangeError);
  assert.throws(() => new Material({ specular: '#ffffff' }), TypeError, 'specular needs phong');
  assert.throws(() => new Material({ shading: 'lambert', shininess: 4 }), TypeError);
  assert.throws(() => new Material({ shading: 'phong', specular: 'red' }), TypeError);
  assert.throws(
    () => new Material({ shading: 'phong', clearcoat: 1 }),
    TypeError,
    'physical options stay standard-only',
  );
  const h = optionalGPU(),
    device = h.engine.gpu;
  device.queue.writeTexture = () => {};
  try {
    const m = new Material({ shading: 'phong', specular: [0.25, 0.5, 1], shininess: 8 });
    m.shininess = 64;
    m.specular[0] = 0.125;
    const entries = m.bindings(device);
    assert.deepEqual(
      entries.map((e) => e.binding),
      [32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 197],
    );
    assert.deepEqual([...new Float32Array(entries.at(-1).resource.buffer.data)], [0.125, 0.5, 1, 64], 'live values');
    assert.ok(!new Material({ shading: 'lambert' }).bindings(device).some((e) => e.binding === 197));
  } finally {
    h.cleanup();
  }
});

test('lambert and phong rewrite only the direct and hemisphere terms and keep every lighting hook point', () => {
  for (const source of [pbrShader, extendedPBRShader]) {
    const lambert = materialShader(source, 2, 'lambert'),
      phong = materialShader(source, 2, 'phong');
    for (const code of [lambert, phong]) {
      assert.ok(code.includes('textureSample(mat_baseMap,mat_baseMapS,'), 'material maps');
      assert.ok(!/fn direct_light[^}]*fresnel/.test(code), 'no GGX in the direct term');
      assert.match(code, /fn hemisphere_ambient\(s:Surface\)->vec3f \{return s\.base\.rgb\*mix\(/);
      assert.ok(code.includes('var color=direct+ambient(s)+s.emissive;'));
      assert.ok(code.includes('fn margoAmbientLayers(i:Out,s:Surface,v:vec3f)->vec3f'));
      assert.ok(!code.includes('if(f.coordsB.w<0.5)'), 'lit, not an early-return output');
    }
    assert.ok(!lambert.includes('mat_phong') && !/fn direct_light[^}]*pow\(/.test(lambert), 'Lambert has no highlight');
    assert.match(phong, /@group\(2\) @binding\(197\) var<uniform> mat_phong:vec4f;/);
    assert.ok(phong.includes('mat_phong.rgb*(mat_phong.w+2)/25.13274123*pow(max(dot(s.n,h),0.0001),mat_phong.w)'));
    assert.ok(phong.includes('fn surface(i:Out,front:bool)->Surface {\n  _=&mat_phong;'), 'G-buffer keeps the layout');
    // Shadows, clustered lights, an IBL ambient and fog compose at gltf-pro's hook points.
    const ibl = { declarations: '// ibl\n', ambient: 'iblShade(s.n,v,s.base.rgb,s.metal,s.roughness)*s.occlusion' },
      fog = { declarations: '// fog\n', output: (c) => `fog(${c})` },
      body = [new Shadows().pbr(2), new Clustered().pbr(2), ibl, fog].reduce(lightPBR, phong);
    assert.match(
      body,
      /let margoAmbient=margoAmbientLayers\(i,s,v\);var color=margoLocal0\(i,margoFront\(s\),v\)\+shadowLit\(direct,i\.position,s\.n\)\+ambient\(s\)\+s\.emissive\+margoAmbient;/,
    );
    assert.ok(body.includes('fn margoLocal0(i:Out,s:Surface,v:vec3f)->vec3f {return clusterLighting('));
    assert.ok(body.includes(`fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return ${ibl.ambient};}`));
    assert.ok(body.includes('color=fog(select(color,pbrNeutral(max(color,vec3f(0))),f.settings.w<0.5));'));
  }
});

test('exportModel writes lambert and phong as dielectrics with a roughness from the exponent', () =>
  headlessModels(async () => {
    const quad = {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      },
      engine = await headless(optionalGPU().engine.gpu),
      material = async (m) =>
        readGLB(await exportModel(createMesh(engine, quad, m), { binary: true })).json.materials[0],
      pbr = async (m) => (await material(m)).pbrMetallicRoughness;
    assert.deepEqual(await pbr(new Material({ shading: 'lambert', metalness: 1, roughness: 0.2 })), {
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 1,
    });
    // (2 / (30 + 2)) ** 0.25 = 0.5: Beckmann alpha 0.25 for exponent 30.
    assert.equal((await pbr(new Material({ shading: 'phong' }))).roughnessFactor, 0.5);
    assert.equal((await pbr(new Material({ shading: 'phong', shininess: 0 }))).roughnessFactor, 1);
    assert.deepEqual(await pbr(new Material({ roughness: 0.2, metalness: 1 })), {
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 1,
      roughnessFactor: 0.2,
    });
  }));
