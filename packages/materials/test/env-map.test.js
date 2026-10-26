// Per-material envMap: options, sources, the WGSL it adds (standard image-based light, Lambert/Phong/basic combine), how
// it composes with a scene IBL, its bindings and uniform; and that a material without one keeps its shader and
// bindings. scripts/mat-more-gpu-check.js checks the reflected pixels on a real adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { lightPBR } from '../../shared/pbr-hooks.js';
import {
  CubeTexture,
  LambertMaterial,
  Material,
  NormalMaterial,
  PbrMaterial,
  Texture,
  UnlitMaterial,
  createMesh,
} from '../dist/index.js';
import { pbrShader } from '../../gltf-pro/src/shader.ts';

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
  const frame = () =>
    gpu.record(() => {
      store.tick(false);
      view.begin(n++);
      engine.frameGraph.execute(view.c);
    });
  return { gpu, engine, frame };
}
const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
const codes = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);
const groups = (log) => log.filter((e) => e[0] === 'group').map((e) => e[2].entries.map((x) => x.binding));
const floats = (hex) => [...new Float32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer)];
const envUniform = (log) =>
  log.filter((e) => e[0] === 'writeBuffer' && e[3].length === 384).map((e) => floats(e[3]))[0];

test('envMap takes cube sources on standard, basic, Lambert and Phong shading, with checked options', () => {
  const faces = Array.from({ length: 6 }, () => ({ data: new Uint8Array(4), width: 1, height: 1 })),
    cube = new CubeTexture(faces),
    environment = {
      specularView: {},
      specularMips: 5,
      sampler: {},
      sh: { irradiance: new Float32Array(27) },
      rotation: 0,
      intensity: 1,
    },
    gpuCube = { createView() {}, depthOrArrayLayers: 6, dimension: '2d', mipLevelCount: 1 };
  for (const envMap of [cube, environment, { texture: gpuCube, view: {} }, gpuCube])
    for (const m of [new PbrMaterial({ envMap }), new UnlitMaterial({ envMap }), new LambertMaterial({ envMap })])
      assert.equal(m.envMap, envMap);
  assert.throws(() => new Material({ envMap: new Texture({ data: new Uint8Array(4), width: 1, height: 1 }) }), /cube/);
  assert.throws(() => new Material({ envMap: {} }), TypeError);
  assert.throws(() => new NormalMaterial({ envMap: cube }), /envMap needs standard/);
  assert.throws(() => new Material({ envMapIntensity: -1 }), RangeError);
  assert.throws(() => new Material({ refractionRatio: 0 }), RangeError);
  assert.throws(() => new Material({ reflectivity: 2 }), RangeError);
  assert.throws(() => new Material({ combine: 'screen' }), TypeError);
  assert.throws(() => new Material({ envMapMode: 'mirror' }), TypeError);
  const m = new Material({ envMap: cube, envMapIntensity: 2, combine: 'mix' });
  assert.deepEqual(
    [m.envMapIntensity, m.envMapRotation, m.envMapMode, m.refractionRatio, m.combine, m.reflectivity],
    [2, 0, 'reflection', 1 / 1.5, 'mix', 1],
  );
  const copy = m.clone();
  copy.envMapIntensity = 3;
  assert.equal(m.envMapIntensity, 2, 'clones keep their own settings');
  assert.equal(copy.envMap, cube, 'and share the map');
});

test('standard envMap replaces the ambient light, also over a scene IBL, and binds the cube and uniform', async () => {
  const s = await scene(),
    own = s.gpu.device.createTexture({ size: [8, 8, 6], format: 'rgba16float', mipLevelCount: 4 }),
    material = new PbrMaterial({ envMap: own, envMapIntensity: 0.5, envMapRotation: Math.PI / 2 }),
    plain = createMesh(s.engine, quad, new PbrMaterial()),
    mesh = createMesh(s.engine, quad, material);
  const log = s.frame(),
    all = codes(log),
    code = all.find((c) => c.includes('margoEnvAmbient'));
  assert.ok(code.includes('fn ambient(s:Surface)->vec3f {return margoEnvAmbient(s,margoEnvEye);}'));
  assert.ok(code.includes('@group(2) @binding(188) var margoEnvMap:texture_cube<f32>;'));
  assert.ok(
    code.includes('margoEnvEye=normalize(margoView.eye.xyz-i.position);_=margoEnvMap;_=margoEnvSampler;_=&margoEnv;'),
  );
  assert.ok(
    all.some((c) => !c.includes('margoEnv')),
    'a material without envMap keeps its shader',
  );
  assert.ok(
    groups(log).some((b) => b.slice(-3).join() === '188,189,190'),
    'cube, sampler and uniform, after the maps',
  );
  assert.ok(groups(log).every((b) => !b.includes(188) || b.slice(-3).join() === '188,189,190'));
  const u = envUniform(log);
  assert.ok(Math.abs(u[0]) < 1e-7 && u[1] === 1, 'rotation');
  assert.deepEqual(u.slice(2, 9), [3, 0.5, 0, 1, 0, 1, 0], 'highest mip 3, intensity, irradiance mip 1, reflection');
  // A scene IBL's ambient hook composes, then the material's own map overrides it (its bindings stay referenced).
  const shading = mesh.primitives[0].material.shading,
    ibl = { declarations: '// ibl\n', ambient: 'iblShade(s.n,v)' },
    lit = shading.lit(lightPBR(shading.shader(pbrShader, 2), ibl));
  assert.ok(lit.includes('let margoSceneAmbient=iblShade(s.n,v);let margoAmbient=margoEnvAmbient(s,v);'));
  // Refraction and the Environment shape: harmonics on, its rotation and intensity combined with the material's.
  material.envMapMode = 'refraction';
  material.envMap = {
    specularView: own.createView({ dimension: 'cube' }),
    specularMips: 6,
    sampler: {},
    sh: { irradiance: Float32Array.from({ length: 27 }, (_, i) => i) },
    rotation: Math.PI / 2,
    intensity: 4,
  };
  const v = envUniform(s.frame());
  assert.ok(Math.abs(v[0] + 1) < 1e-6, 'rotations add');
  assert.deepEqual(v.slice(2, 8), [5, 2, 1, 3, Math.fround(1 / 1.5), 1], 'mips, intensity, SH on, ratio');
  assert.deepEqual(v.slice(12, 15), [0, 1, 2]);
  assert.deepEqual(v.slice(44, 47), [24, 25, 26]);
  material.envMap = null;
  const off = s.frame();
  assert.ok(
    groups(off).every((b) => !b.includes(188)),
    'envMap null drops the bindings',
  );
  mesh.destroy();
  plain.destroy();
  s.engine.dispose();
});

test('Lambert, Phong and basic envMap combine the reflection with their colour', async () => {
  const s = await scene(),
    own = s.gpu.device.createTexture({ size: [4, 4, 6], format: 'rgba8unorm' }),
    lambert = createMesh(s.engine, quad, new LambertMaterial({ envMap: own, combine: 'add', reflectivity: 0.25 })),
    basic = createMesh(s.engine, quad, new UnlitMaterial({ envMap: own })),
    log = s.frame(),
    all = codes(log);
  const lit = lambert.primitives[0].material.shading.lit(lambert.primitives[0].material.shading.shader(pbrShader, 2));
  assert.ok(lit.includes('var color=direct+ambient(s)+s.emissive;\n  color=margoEnvCombine(color,s.n,v);'));
  assert.ok(
    all.some((c) => c.includes('mat_out(margoEnvCombine(s.base.rgb+s.emissive,s.n,margoEnvEye))')),
    'basic',
  );
  const u = envUniform(log);
  assert.deepEqual(u.slice(7, 9), [0.25, 2], 'reflectivity, add');
  lambert.destroy();
  basic.destroy();
  s.engine.dispose();
});
