// KB5663a: on the WebGL2 compatibility layer every VolumetricFog compute entry point runs on the GPU. The column
// integration stores at each slice of a loop, which the layer can only run as JavaScript (its CPU tier: about 1 s a
// frame at the default 160 x 90 x 64 grid, measured by the quality features check). On a layer device the fog
// integrates each froxel by itself (fragment tier); on native WebGPU it keeps the column kernel byte for byte
// (tests/fog-volumes.test.js pins that shader's hash). Real-GPU check of the values on both backends:
// tests/volumetric-route-browser.js (npm run test:fog-route:browser, with --compat for the layer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Camera } from '../../core/dist/extension.js';
import { SceneTarget } from '../../shared/msaa.js';
import { COMPAT_VENDOR } from '../../shared/compat.js';
import { planCompute } from '../../webgl2-compat/dist/compute.js';
import { VolumetricFog } from '../dist/volumetric.js';
import { FogVolumes } from '../dist/fog-volumes.js';

const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;

function frames(vendor, options, count = 2) {
  const gpu = mockGPU();
  gpu.device.adapterInfo = { vendor };
  const view = context(gpu, { samples: 1, format: 'rgba16float', shader: 'lit shader' }),
    size = [view.state.width, view.state.height],
    engine = {
      gpu: gpu.device,
      plugins: new Map(),
      lighting: { direction: new Float32Array([0, 0.6, -0.8, 3]), radiance: new Float32Array([1, 0.9, 0.8, 0.1]) },
      sceneOf() {
        return this;
      },
      removePlugin() {},
    },
    target = new SceneTarget(
      gpu.device,
      gpu.device.createTexture({ size, format: 'rgba16float', usage }),
      gpu.device.createTexture({ size, format: 'depth24plus-stencil8', usage }),
      1,
    ),
    fog = new VolumetricFog(options);
  engine.plugins.set(fog.name, fog);
  fog.setup(engine);
  const run = passes(fog);
  return gpu.record(() => {
    for (let i = 0; i < count; i++) {
      view.begin(i);
      target.begin(view.c);
      const camera = new Camera({ position: [0, 2, 0], target: [0, 2, -10], near: 0.1, far: 500 });
      camera.update(16 / 9, true);
      view.c.camera = camera;
      run(view.c);
    }
  });
}
// The compute entry points a recorded run built, with the tier the layer gives each, and its dispatches.
function compute(log) {
  const modules = new Map(log.filter((e) => e[0] === 'module').map((e) => [e[1], e[2].code]));
  const pipelines = log
    .filter((e) => e[0] === 'computePipeline')
    .map((e) => {
      const { module, entryPoint } = e[2].compute;
      return { entryPoint, plan: planCompute({ source: modules.get(module), entryPoint }) };
    });
  const dispatches = log.filter((e) => e[0] === 'pass.dispatchWorkgroups').map((e) => e.slice(1, 4));
  return { pipelines, dispatches };
}

const { Clustered } = await import('../../clustered/dist/index.js'),
  { Shadows } = await import('../../shadows/dist/index.js');
const clustered = new Clustered({ grid: [4, 3, 2] });
clustered.setup({ gpu: mockGPU().device, sceneOf() {}, removePlugin() {} });
const cascades = new Shadows().pbr(2).declarations;
const stacks = {
  defaults: {},
  'multiple scattering and noise': { multipleScattering: 0.5, noise: 0.6 },
  'clustered lights, cascaded shadows, fog volumes': {
    lights: { pbr: (g) => clustered.pbr(g), bindings: () => [] },
    shadows: { pbr: () => ({ declarations: cascades }), bindings: () => [] },
    volumes: new FogVolumes([{ shape: 'box', min: [-1, 0, -2], max: [1, 2, 2] }]),
  },
};

for (const [name, options] of Object.entries(stacks))
  test(`layer device, ${name}: no fog compute entry point runs on the CPU tier`, () => {
    const { pipelines, dispatches } = compute(frames(COMPAT_VENDOR, options));
    assert.deepEqual(
      pipelines.map((p) => p.entryPoint),
      ['inject', 'integrate'],
    );
    for (const { entryPoint, plan } of pipelines)
      assert.equal(plan.tier, 'fragment', `${entryPoint} runs on the ${plan.tier} tier: ${plan.reason}`);
    // Default grid 160 x 90 x 64: both kernels one invocation per froxel, 4 x 4 x 4 workgroups.
    assert.deepEqual(dispatches, [
      [40, 23, 16],
      [40, 23, 16],
      [40, 23, 16],
      [40, 23, 16],
    ]);
  });

test('native device: the column integration, one invocation per froxel column', () => {
  const log = frames('nvidia', {}),
    { pipelines, dispatches } = compute(log),
    code = log.find((e) => e[0] === 'module' && /fn integrate/.test(e[2].code))[2].code;
  assert.match(code, /@workgroup_size\(8,8\) fn integrate/);
  assert.match(code, /textureStore\(integrated,vec3u\(id\.xy,z\),vec4f\(light,optical\)\);/);
  // The column kernel is what the layer cannot run on the GPU; native WebGPU never sees the layer.
  assert.equal(pipelines.find((p) => p.entryPoint === 'integrate').plan.tier, 'cpu');
  assert.deepEqual(dispatches, [
    [40, 23, 16],
    [20, 12, undefined],
    [40, 23, 16],
    [20, 12, undefined],
  ]);
});

test('the per-froxel integration replays the column steps 0 to z in order and stores once, at its own froxel', () => {
  const log = frames(COMPAT_VENDOR, {}),
    code = log.find((e) => e[0] === 'module' && /fn integrate/.test(e[2].code))[2].code,
    native = frames('nvidia', {}).find((e) => e[0] === 'module' && /fn integrate/.test(e[2].code))[2].code;
  const body = (source) => source.slice(source.indexOf('// 3x3 tent'), source.indexOf('optical+=s.a*step;'));
  assert.equal(body(code), body(native), 'the same step arithmetic, character for character');
  assert.match(code, /for\(var z=0u;z<=id\.z;z\+\+\)\{/);
  assert.match(code, /optical\+=s\.a\*step;\n {2}\}\n {2}textureStore\(integrated,id,vec4f\(light,optical\)\);\n\}/);
});
