// Toon shading (ToonMaterial, shading: 'toon', toonModel): options, the WGSL rewrite, lighting-hook composition, the
// ramp's bindings and live uniform, recorded on a mock device. scripts/mat-more-gpu-check.js checks the rendered bands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { Clustered } from '../../clustered/dist/index.js';
import { Shadows } from '../../shadows/dist/index.js';
import { lightPBR } from '../../shared/pbr-hooks.js';
import { pbrShader, extendedPBRShader } from '../../gltf-pro/src/shader.ts';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import {
  CubeTexture,
  LambertMaterial,
  Material,
  ToonMaterial,
  Texture,
  createMesh,
  materialShader,
  toonModel,
} from '../dist/index.js';

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
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
const codes = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);
const floats = (hex) => [...new Float32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer)];
const ramp = 'result+=base/3.14159265*margoToonRamp(dot(n,l))*';

test('toon options validate and stay live; other shadings refuse them', () => {
  const m = new ToonMaterial();
  assert.equal(m.shading, 'toon');
  assert.equal(m.steps, 3);
  assert.equal(m.gradientMap, null);
  m.steps = 5;
  assert.equal(m.steps, 5);
  for (const steps of [1, 257, 2.5]) assert.throws(() => new ToonMaterial({ steps }), RangeError);
  assert.throws(() => new ToonMaterial({ steps: '3' }), TypeError);
  assert.throws(() => new ToonMaterial({ gradientMap: {} }), TypeError);
  assert.throws(() => new Material({ steps: 4 }), /need toon shading/);
  assert.throws(
    () => new LambertMaterial({ gradientMap: new Texture({ data: new Uint8Array(4), width: 1, height: 1 }) }),
  );
  const cube = new CubeTexture(Array.from({ length: 6 }, () => ({ data: new Uint8Array(4), width: 1, height: 1 })));
  assert.throws(
    () => new Material({ shading: 'toon', envMap: cube }),
    /envMap needs standard, basic, lambert or phong/,
  );
  const copy = new ToonMaterial({ steps: 4 }).clone();
  assert.equal(copy.steps, 4, 'clone keeps the bands');
});

test('toon rewrites the direct and hemisphere terms through the ramp and keeps every lighting hook point', () => {
  for (const source of [pbrShader, extendedPBRShader]) {
    const code = materialShader(source, 2, 'toon');
    assert.ok(code.includes('@group(2) @binding(191) var<uniform> margoToon:vec4f;'));
    assert.ok(code.includes('fn margoToonRamp(nl:f32)->vec3f {'));
    assert.ok(code.includes('return s.base.rgb/3.14159265*margoToonRamp(dot(s.n,l))*f.radiance.rgb*f.light.w;'));
    assert.match(code, /fn hemisphere_ambient\(s:Surface\)->vec3f \{return s\.base\.rgb\*mix\(/, 'Lambert hemisphere');
    assert.ok(code.includes('fn margoFront(s:Surface)->Surface {var o=s; o.metal=0; o.roughness=1.0; return o;}'));
    assert.ok(
      code.includes('fn surface(i:Out,front:bool)->Surface {\n  _=margoToon;_=margoToonMap;_=margoToonSampler;'),
    );
    assert.ok(code.includes('var color=direct+ambient(s)+s.emissive;'));
    assert.ok(!/fn direct_light[^}]*fresnel/.test(code), 'no GGX highlight');
    const body = [new Shadows().pbr(2), new Clustered().pbr(2)].reduce(lightPBR, code);
    assert.ok(body.includes('shadowLit(direct,i.position,s.n)'), 'shadows wrap the ramped sun');
  }
  // The steps ramp equals a nearest-filtered gradient of n texels k / (n - 1) at u = n.l * 0.5 + 0.5.
  const band = (nl, n) => Math.min(Math.floor(Math.min(Math.max(nl * 0.5 + 0.5, 0), 1) * n), n - 1) / (n - 1);
  assert.deepEqual(
    [-1, -0.4, 0, 0.3, 0.34, 1].map((nl) => band(nl, 3)),
    [0, 0, 0.5, 0.5, 1, 1],
  );
});

test('toon meshes bind the ramp, compose clustered lights through it and update the uniform live', async () => {
  const s = await scene(),
    lights = Clustered.attach(s.engine);
  lights.setLights([{ position: [0, 0, 1], range: 5, intensity: 3 }]);
  const material = new ToonMaterial({ color: [1, 0.5, 0.25] }),
    mesh = createMesh(s.engine, quad, material);
  lights.add(mesh);
  const log = s.frame(),
    code = codes(log).find((c) => c.includes('fn clusterLighting(') && c.includes('margoToonRamp'));
  assert.ok(code, 'the toon mesh shader composes clustered lights');
  assert.ok(code.includes(ramp) && !code.includes('*d*g*fresnel/'), 'clustered BRDF replaced by the ramp');
  const groups = log.filter((e) => e[0] === 'group').map((e) => e[2].entries.map((x) => x.binding));
  assert.ok(
    groups.some((b) => b.includes(191) && b.includes(192) && b.includes(193)),
    'ramp bindings',
  );
  const uniform = (l) =>
    l
      .filter((e) => e[0] === 'writeBuffer' && e[3].length === 32)
      .map((e) => floats(e[3]))
      .find((v) => v[1] >= 2 && v[2] === 0 && v[3] === 0 && (v[0] === 0 || v[0] === 1));
  assert.deepEqual(uniform(log), [0, 3, 0, 0], 'steps 3, no gradient');
  material.steps = 7;
  material.gradientMap = new Texture(
    { data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]), width: 2, height: 1 },
    { magFilter: 'nearest', mipmaps: false },
  );
  assert.deepEqual(uniform(s.frame()), [1, 7, 0, 0], 'live: the gradient on, steps 7');
  mesh.destroy();
  lights.dispose();
  s.engine.dispose();
});

test('toonModel switches loaded glTF primitives to toon copies of their materials and restores them', async () => {
  const s = await scene(),
    doc = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 72 }],
      bufferViews: [{ buffer: 0, byteLength: 72 }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', byteOffset: 36 },
      ],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.4, 0.2, 1], metallicFactor: 1 } }],
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0, NORMAL: 1 }, material: 0 },
            { attributes: { POSITION: 0, NORMAL: 1 }, material: 0 },
          ],
        },
      ],
      nodes: [{ mesh: 0 }],
    },
    model = parseGLTF(s.engine, doc, [new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1])]);
  const original = model.primitives[0].material;
  original.physical = [1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0];
  assert.throws(() => toonModel(model, { primitives: [5] }), RangeError);
  const toon = toonModel(model, { primitives: [0], steps: 4 }),
    copy = model.primitives[0].material;
  assert.notEqual(copy, original);
  assert.equal(model.primitives[1].material, original, 'other primitives keep their material');
  assert.equal(copy.base, original.base, 'colours stay shared and live');
  assert.equal(copy.physical, undefined, 'physical layers left out');
  assert.equal(typeof copy.shading.lit, 'function');
  const log = s.frame(),
    toonCode = codes(log).filter((c) => c.includes('margoToonRamp'));
  assert.ok(toonCode.length > 0 && toonCode.every((c) => c.includes('margoToonRamp(dot(s.n,l))')));
  assert.ok(
    codes(log).some((c) => !c.includes('margoToonRamp')),
    'the other primitive keeps its own shader',
  );
  toon.steps = 6;
  assert.throws(() => {
    toon.steps = 1;
  }, RangeError);
  toon.dispose();
  assert.equal(model.primitives[0].material, original, 'dispose restores the material');
  assert.throws(() => toonModel(createMesh(s.engine, quad, new Material())), /ToonMaterial/);
  model.dispose();
  s.engine.dispose();
});
