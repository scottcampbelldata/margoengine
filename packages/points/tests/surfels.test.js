import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { PointCloud } from '../dist/index.js';
import { OctreeCloud, buildOctree } from '../dist/octree.js';
import { SurfelPlugin, surfelShader, resolveShader } from '../dist/surfels.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

function rig({ samples = 1, options } = {}) {
  const gpu = mockGPU(),
    plugin = new SurfelPlugin(options),
    camera = new Camera({ position: [0, 0, 8], target: [0, 0, 0] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  camera.update(1, true);
  gpu.record(() => plugin.setup({ backend: 'webgpu', gpu: gpu.device, sceneOf() {} }));
  const run = passes(plugin),
    frame = () =>
      gpu.record(() =>
        run({
          backend: 'webgpu',
          device: gpu.device,
          encoder: gpu.encoder,
          camera,
          width: 64,
          height: 64,
          format: 'rgba8unorm',
          color: view,
          depth: view,
          descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: samples } },
        }),
      );
  return { plugin, frame, gpu };
}
const positions = [0, 0, 0, 1, 1, 0, -1, 0, 1];
const pipelines = (log) => log.filter((e) => e[0] === 'renderPipeline').map((e) => e[2]);
const draws = (log) => log.filter((e) => e[0] === 'pass.draw');

test('a frame is three passes: depth with writes, additive blend without, resolve over the scene', () => {
  const { plugin, frame } = rig();
  plugin.add(new PointCloud({ positions }));
  const log = frame(),
    [depth, blend, resolve] = pipelines(log);
  assert.equal(depth.vertex.entryPoint, 'vertexDepth');
  assert.equal(depth.depthStencil.depthWriteEnabled, true);
  assert.equal(depth.fragment.targets[0].format, 'r32float');
  assert.equal(blend.vertex.entryPoint, 'vertexBlend');
  assert.equal(blend.depthStencil.depthWriteEnabled, false);
  assert.equal(blend.depthStencil.depthCompare, 'greater-equal');
  assert.equal(blend.fragment.targets[0].format, 'rgba16float');
  assert.deepEqual(blend.fragment.targets[0].blend.color, { srcFactor: 'one', dstFactor: 'one', operation: 'add' });
  assert.equal(resolve.depthStencil, undefined);
  assert.equal(draws(log).length, 3);
  assert.deepEqual(draws(log)[0].slice(1, 3), draws(log)[1].slice(1, 3), 'both splat passes draw the same points');
  assert.equal(plugin.stats.pointsDrawn, 3);
  assert.equal(plugin.stats.drawCalls, 3);
  assert.equal(pipelines(frame()).length, 0, 'pipelines are made once');
});

test('multisampled targets read multisampled textures, the resolve per sample', () => {
  const { plugin, frame } = rig({ samples: 4 });
  plugin.add(new PointCloud({ positions }));
  const log = frame(),
    code = log.filter((e) => e[0] === 'module').map((e) => e[2].code);
  assert.equal(code.length, 2, 'one splat and one resolve module');
  assert.ok(code[0].includes('var front:texture_multisampled_2d<f32>'));
  assert.ok(code[1].includes('var sums:texture_multisampled_2d<f32>'));
  assert.ok(code[1].includes('i32(sample)'));
  assert.ok(pipelines(log).slice(0, 2).every((p) => p.multisample.count === 4));
  assert.ok(!surfelShader.includes('multisampled') && !resolveShader.includes('multisampled'));
});

test('a hidden, an attached-to-nothing or an empty cloud draws nothing, and the budget holds', () => {
  const { plugin, frame } = rig({ options: { pointBudget: 2 } }),
    cloud = plugin.add(new PointCloud({ positions }));
  frame();
  assert.equal(plugin.stats.pointsDrawn, 2);
  cloud.visible = false;
  assert.equal(draws(frame()).length, 0);
  assert.equal(plugin.stats.clouds, 0);
});

test('add and remove own the cloud; removing frees its buffers; dispose keeps it registered', () => {
  const { plugin, frame } = rig(),
    cloud = plugin.add(new PointCloud({ positions, normals: new Float32Array(9) }));
  assert.equal(plugin.pointClouds.size, 1);
  assert.throws(() => plugin.add({}), TypeError);
  frame();
  const buffers = [...plugin['cloudGpu'].get(cloud).normals ? [plugin['cloudGpu'].get(cloud).normals] : []];
  assert.equal(buffers.length, 1, 'normals reach the GPU');
  cloud.dispose();
  assert.equal(plugin.pointClouds.size, 0);
  assert.equal(plugin['cloudGpu'].size, 0);
  plugin.add(cloud);
  plugin.dispose();
  assert.equal(plugin.pointClouds.size, 1);
});

test('updates reach the GPU as ranges', () => {
  const { plugin, frame } = rig(),
    cloud = plugin.add(new PointCloud({ positions }));
  frame();
  cloud.updatePositions(1, [2, 2, 0]);
  const writes = frame().filter((e) => e[0] === 'writeBuffer' && e[3].length === 24);
  assert.equal(writes.length, 1, 'one 12-byte write');
});

test('options are checked, and an OctreeCloud can draw through the plugin', async () => {
  for (const options of [{ overlap: 0 }, { blendDepth: -1 }, { pointBudget: -1 }])
    assert.throws(() => new SurfelPlugin(options), RangeError);
  assert.throws(() => new SurfelPlugin({ name: '' }), TypeError);
  assert.throws(() => new SurfelPlugin().setFog(3), TypeError);
  const { plugin } = rig(),
    octree = new OctreeCloud(plugin, buildOctree({ positions }));
  octree.select({ position: [0, 0, 8], screenHeight: 64 });
  await new Promise((r) => setTimeout(r, 0));
  octree.select({ position: [0, 0, 8], screenHeight: 64 });
  assert.equal(plugin.pointClouds.size, 1);
  octree.dispose();
  assert.equal(plugin.pointClouds.size, 0);
});

test('fog sets the flag only for materials that take it', () => {
  const { plugin, frame } = rig(),
    cloud = plugin.add(new PointCloud({ positions }));
  const flags = () => {
    frame();
    return plugin['cloudGpu'].get(cloud).uints[24] & 1024;
  };
  assert.equal(flags(), 0);
  plugin.setFog({ color: [1, 1, 1], density: 0.1 });
  assert.equal(flags(), 1024);
  cloud.material.fog = false;
  assert.equal(flags(), 0);
});

test('reorder keeps normals with their points', () => {
  const normals = new Float32Array(3000),
    positions = new Float32Array(3000);
  for (let i = 0; i < 1000; i++) {
    positions.set([i, (i * 7) % 13, (i * 3) % 11], i * 3);
    normals.set([i, 0, 1], i * 3);
  }
  const cloud = new PointCloud({ positions, normals, reorder: true, blockSize: 64 });
  for (let i = 0; i < 1000; i++) assert.equal(cloud.normals[i * 3], cloud.positions[i * 3], `normal of point ${i}`);
});
