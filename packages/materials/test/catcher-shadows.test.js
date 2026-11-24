// ShadowCatcherMaterial with clustered directional and area light shadows (LocalShadows castShadow): its unshadowed
// copy of the light loop drops the directional factor and calls an unshadowed copy of clusterAreaLighting, and the
// catcher text is unchanged while those lights cast no shadow. scripts/mat-more-gpu-check.js measures the alpha.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { Clustered } from '../../clustered/dist/index.js';
import { LocalShadows } from '../../clustered/dist/shadows.js';
import { DirectionalLights } from '../../clustered/dist/directional.js';
import { AreaLights } from '../../clustered/dist/area.js';
import { ShadowCatcherMaterial, createMesh } from '../dist/index.js';

async function scene() {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  gpu.device.createCommandEncoder = () => ({ ...gpu.encoder, finish: () => ({}) });
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
  return { engine, frame };
}
const quad = {
  positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
const catcherCode = (log) =>
  log
    .filter((e) => e[0] === 'module')
    .map((e) => e[2].code)
    .find((c) => c.includes('fn margoCatcher(i:Out,s:Surface)->f32 {\n'));

async function catcherWith(castShadow) {
  const s = await scene(),
    lights = Clustered.attach(s.engine),
    local = LocalShadows.attach(s.engine, { lights, resolution: 64 }),
    suns = DirectionalLights.attach(s.engine, { lights }),
    panels = AreaLights.attach(s.engine, { lights });
  suns.setLights([
    { direction: [0, 0, -1], intensity: 2, castShadow, shadow: { bounds: { min: [-2, -2, -2], max: [2, 2, 2] } } },
  ]);
  panels.setLights([{ position: [0, 0, 2], direction: [0, 0, -1], width: 1, height: 1, intensity: 3, castShadow }]);
  const mesh = createMesh(s.engine, quad, new ShadowCatcherMaterial());
  lights.add(mesh);
  local.add(mesh);
  const code = catcherCode(s.frame());
  for (const plugin of [panels, suns, local, lights]) plugin.dispose();
  mesh.destroy();
  s.engine.dispose();
  return code;
}

test('the shadow catcher counts castShadow directional and area lights against unshadowed copies', async () => {
  const code = await catcherWith(true);
  assert.ok(code, 'a catcher shader was drawn');
  const lights = /fn margoCatcherLights\([\s\S]*?\n\}/.exec(code)?.[0],
    area = /fn margoCatcherArea\([\s\S]*?\n\}/.exec(code)?.[0];
  assert.ok(code.includes('*clusterDirectionalShadow(j,position,n,l)'), 'the lit loop keeps the directional shadow');
  assert.ok(code.includes('*clusterAreaShadow(j,position,n,c,r,u)'), 'the lit area lights keep theirs');
  assert.ok(lights && !lights.includes('clusterDirectionalShadow'), 'the unshadowed loop drops the directional factor');
  assert.ok(lights.includes('margoCatcherArea(position,n,v,nv,base,roughness,metal,dielectricF0,dielectricF90)'), 'and calls the open area copy');
  assert.ok(area && !area.includes('clusterAreaShadow'), 'the area copy has no shadow factor');
  assert.ok(code.includes('lit+=dot(clusterLighting(') && code.includes('all+=dot(margoCatcherLights('));
});

test('without castShadow on directional and area lights the catcher text has no copies of them', async () => {
  const code = await catcherWith(false);
  assert.ok(code);
  assert.ok(!code.includes('fn margoCatcherArea(') && !code.includes('clusterDirectionalShadow'));
});
