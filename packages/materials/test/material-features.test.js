// Material features on createMesh meshes, recorded on a mock device: the shader text each option adds (and that it adds
// none while unused), its bindings and live uniforms. browser-check.mjs checks the rendered values on a real adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { Clustered } from '../../clustered/dist/index.js';
import { LambertMaterial, PbrMaterial, PhongMaterial, createMesh } from '../dist/index.js';

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
