// Material features on createMesh meshes, recorded on a mock device: the shader text each option adds (and that it adds
// none while unused), its bindings and live uniforms. browser-check.mjs checks the rendered values on a real adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { Clustered } from '../../clustered/dist/index.js';
import { LambertMaterial, PbrMaterial, PhongMaterial, Texture, createMesh } from '../dist/index.js';

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
/** The last feature uniform write (to a 144-byte buffer) in `log`; `history` holds the frames that made the buffers. */
const featureUniform = (log, history) => {
  const ids = new Set(history.filter((e) => e[0] === 'buffer' && e[2].size === 144).map((e) => e[1])),
    writes = log.filter((e) => e[0] === 'writeBuffer' && ids.has(e[1]));
  return writes.length ? [...floats(writes.at(-1)[3])] : undefined;
};
const solid = (r, g, b, a = 255) =>
  new Texture(
    { data: new Uint8Array([r, g, b, a, r, g, b, a, r, g, b, a, r, g, b, a]), width: 2, height: 2 },
    { mipmaps: false },
  );
/** GPU calls of one frame drawing `material` on a fresh mock device. */
async function oneFrame(material) {
  const s = await scene(),
    mesh = createMesh(s.engine, quad, material),
    log = s.frame();
  mesh.destroy();
  s.engine.dispose();
  return log;
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

test('a material with every feature at its default draws exactly the GPU calls of a plain one', async () => {
  const expected = await oneFrame(new PbrMaterial());
  assert.deepEqual(await oneFrame(new PbrMaterial({ alphaMap: null })), expected);
  const toggled = new PbrMaterial({ alphaMap: solid(0, 0, 0) });
  toggled.alphaMap = null;
  assert.deepEqual(await oneFrame(toggled), expected);
});
