// The WebGL2 compatibility route's staged programs (src/compat-staged.ts), on the CPU: for the base tracer, every
// subclass and every composed feature, the programs the route compiles are valid WGSL, hold no one-pass loop (Direct3D's
// shader compiler gave up unrolling one in the vertex program and the context was lost at its first draw on ANGLE
// Direct3D 11, docs/known-bugs.md), the census and its read-back are wired, every vertex starts its light sum empty,
// and the loop's windows cover it with at most 24 censuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';
import { VoxelPathTracer } from '../dist/index.js';
import { ResampledVoxelPathTracer, resampledEmitters } from '../dist/restir.js';
import { GuidedVoxelPathTracer, causticGuiding } from '../dist/guiding.js';
import { MediaVoxelPathTracer, coloredMedia } from '../dist/media.js';
import { SpectralVoxelPathTracer, spectralTransport } from '../dist/spectral.js';
import { MeshPathTracer, triangleMeshes } from '../dist/mesh.js';
import { ComposedVoxelPathTracer } from '../dist/compose.js';
import { fakeDevice, fakeEngine, simpleScene } from './support.js';
import { loopLimit, loopWindows } from '../src/compat-staged.ts';

const STAGES = ['start', 'hit', 'vertex', 'surface', 'sample', 'shadow', 'gather', 'post', 'finish'];

// A fake device of the WebGL2 layer: the tracer takes its compatibility route there.
function harness() {
  const device = fakeDevice(),
    modules = [],
    pipelines = [],
    create = device.createShaderModule,
    render = device.createRenderPipelineAsync;
  device.adapterInfo = { vendor: 'margo-webgl2', architecture: 'webgl2', device: 'test', description: 'test' };
  device.createShaderModule = (d) => {
    modules.push(d.code);
    return create(d);
  };
  device.createRenderPipelineAsync = (d) => {
    pipelines.push(d);
    return render(d);
  };
  return { ...fakeEngine(device), modules, pipelines };
}

const meshScene = () => ({
  ...simpleScene(),
  meshes: [
    {
      id: 'panel',
      material: 1,
      positions: new Float32Array([-2, 0, -2, 2, 0, -2, 0, 0, 2]),
      indices: new Uint32Array([0, 2, 1]),
    },
  ],
});

const cases = [
  ['base', (e) => VoxelPathTracer.attach(e, { scene: simpleScene() })],
  ['restir', (e) => ResampledVoxelPathTracer.attach(e, { scene: simpleScene() })],
  ['guiding', (e) => GuidedVoxelPathTracer.attach(e, { scene: simpleScene() })],
  ['media', (e) => MediaVoxelPathTracer.attach(e, { scene: simpleScene() })],
  ['spectral', (e) => SpectralVoxelPathTracer.attach(e, { scene: simpleScene() })],
  ['mesh', (e) => MeshPathTracer.create(e, { scene: meshScene() })],
  [
    'compose (every feature)',
    (e) =>
      ComposedVoxelPathTracer.create(e, {
        scene: meshScene(),
        features: [resampledEmitters(), triangleMeshes(), coloredMedia(), causticGuiding(), spectralTransport()],
      }),
  ],
];

for (const [name, attach] of cases)
  test(`compatibility route programs of ${name} are valid WGSL with no one-pass loop`, async () => {
    const h = harness(),
      tracer = await attach(h.engine);
    try {
      await tracer.ready;
      const staged = h.modules.filter((code) => /@fragment fn (stage|census)\(/.test(code));
      assert.equal(staged.length, STAGES.length + 1, 'nine stage programs and the census');
      for (const code of staged) {
        assert.doesNotThrow(() => checkWGSL(code), `${name}: ${code.slice(code.lastIndexOf('@fragment'), code.lastIndexOf('@fragment') + 40)}`);
        assert.doesNotMatch(code, /z_once/, `${name}: a one-pass loop is left`);
      }
      const labels = h.pipelines.map((p) => p.label);
      for (const stage of [...STAGES, 'census']) assert.ok(labels.includes(`voxel-pathtracer ${stage}`), stage);
      // The census: one rgba32uint target, the only target it has, read back through a 16-byte MAP_READ buffer (no
      // indirect draws: a GPU-written argument the layer must check is a synchronous read, a stall, every time).
      const census = h.pipelines.find((p) => p.label === 'voxel-pathtracer census');
      assert.deepEqual(census.fragment.targets, [{ format: 'rgba32uint' }]);
      assert.ok(h.device.buffers.some((b) => b.size === 16 && b.usage & 0x1), 'a census read-back buffer');
      assert.ok(!h.device.buffers.some((b) => b.usage & 0x100), 'no indirect argument buffer');
      // direct() starts its light sum at zero on every call; a staged program empties the state's copy before the
      // light kinds add to it (carried from vertex to vertex, it added each vertex's light again at every later one:
      // the materials scene came out 10.5 per cent too bright on ANGLE Vulkan).
      assert.ok(staged.some((code) => code.includes('dL=vec3f(0.0);')), 'a program empties the light sum');
    } finally {
      tracer.dispose();
    }
  });

test('the path loop runs in windows of 4, 4, 8, 16, 32, then 64 iterations, each census on a multiple of 4', () => {
  for (const bounces of [1, 2, 8, 17, 63, 64]) {
    const limit = loopLimit(bounces),
      windows = loopWindows(limit);
    let left = limit,
      at = 0;
    for (const [i, w] of windows.entries()) {
      assert.equal(w, Math.min([4, 4, 8, 16, 32][i] ?? 64, left), `${bounces} bounces, window ${i}`);
      left -= w;
      if (i < windows.length - 1) assert.equal((at += w) % 4, 0, 'a census on a multiple of 4');
    }
    assert.equal(left, 0, `${bounces} bounces: the whole loop`);
  }
  // 64 bounces: 1,312 iterations in 25 windows, so at most 24 censuses are read back.
  assert.equal(loopLimit(64), 1312);
  assert.equal(loopWindows(1312).length, 25);
});
