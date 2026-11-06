import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { PointCloud, PointsPlugin } from '../dist/index.js';
import { buildOctree, OctreeCloud } from '../dist/octree.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];

test("'float' keeps values above 1; 'rgba8' clamps as before", () => {
  const colors = new Float32Array([4, 0.5, 0, 1, 2, 3, 0, 0, 12]),
    hdr = new PointCloud({ positions, colors, colorFormat: 'float' }),
    plain = new PointCloud({ positions, colors });
  assert.deepEqual([...hdr.floatColors.slice(0, 4)], [4, 0.5, 0, 1]);
  assert.equal(hdr.floatColors[10], 12);
  assert.equal(hdr.colorStride, 4);
  assert.equal(hdr.colors.length, 12);
  assert.equal(plain.floatColors, null);
  assert.equal(plain.colorStride, 1);
  assert.equal(plain.colors[0] & 255, 255, 'rgba8 clamps');
});

test('float colours default to linear, and may say otherwise; bytes are 0..255', () => {
  assert.equal(new PointCloud({ positions, colorFormat: 'float' }).colorSpace, 'linear');
  assert.equal(new PointCloud({ positions, colorFormat: 'float', colorSpace: 'srgb' }).colorSpace, 'srgb');
  assert.equal(new PointCloud({ positions }).colorSpace, 'srgb');
  const bytes = new PointCloud({ positions, colors: new Uint8Array(9).fill(255), colorFormat: 'float' });
  assert.deepEqual([...bytes.floatColors.slice(0, 4)], [1, 1, 1, 1]);
  const four = new PointCloud({ positions, colors: new Float32Array(12).fill(2), colorComponents: 4, colorFormat: 'float' });
  assert.equal(four.floatColors[3], 2);
});

test('bad input is refused', () => {
  assert.throws(() => new PointCloud({ positions, colorFormat: 'half' }), RangeError);
  for (const bad of [-1, Number.NaN, Infinity])
    assert.throws(
      () => new PointCloud({ positions, colors: [bad, 0, 0, 0, 0, 0, 0, 0, 0], colorFormat: 'float' }),
      RangeError,
    );
});

test('updates and setColors work in floats, as whole points', () => {
  const cloud = new PointCloud({ positions, colors: new Float32Array(9), colorFormat: 'float' });
  cloud.updateColors(1, [7, 8, 9]);
  assert.deepEqual([...cloud.floatColors.slice(4, 8)], [7, 8, 9, 1]);
  assert.deepEqual(cloud.dirty.colors, [[1, 2]]);
  assert.throws(() => cloud.updateColors(2, [1, 2, 3, 4, 5, 6]), RangeError);
  cloud.setColors(new Float32Array(9).fill(5));
  assert.equal(cloud.floatColors[8], 5);
  cloud.setColors(null);
  assert.equal(cloud.floatColors, null);
});

test('reorder moves all four floats of a colour with its point', () => {
  const n = 1000,
    xyz = new Float32Array(n * 3),
    colors = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    xyz.set([i, (i * 7) % 13, (i * 3) % 11], i * 3);
    colors.set([i, i + 0.25, i + 0.5, i + 0.75], i * 4);
  }
  const cloud = new PointCloud({ positions: xyz, colors, colorComponents: 4, colorFormat: 'float', reorder: true, blockSize: 64 }),
    floats = cloud.floatColors;
  for (let i = 0; i < n; i++) {
    assert.equal(floats[i * 4], cloud.positions[i * 3], `colour of point ${i}`);
    assert.equal(floats[i * 4 + 3], cloud.positions[i * 3] + 0.75);
  }
});

function rig() {
  const gpu = mockGPU(),
    plugin = new PointsPlugin(),
    camera = new Camera({ position: [0, 0, 8], target: [0, 0, 0] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  camera.update(1, true);
  gpu.record(() => plugin.setup({ backend: 'webgpu', gpu: gpu.device }));
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
          descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 1 } },
        }),
      );
  return { plugin, frame };
}

test('the GPU buffer holds 16 bytes a point, uploads and updates whole floats, and the shader is told', () => {
  const { plugin, frame } = rig(),
    cloud = plugin.add(new PointCloud({ positions, colors: new Float32Array(9).fill(3), colorFormat: 'float' }));
  frame();
  assert.equal(plugin.stats.uploadBytes, 3 * (12 + 16 + 4));
  const r = plugin['cloudGpu'].get(cloud);
  assert.equal(r.colors.size, 48);
  assert.notEqual(r.uints[24] & 256, 0);
  cloud.updateColors(1, [1, 2, 3]);
  frame();
  assert.equal(plugin.stats.uploadBytes, 16);
});

test('an octree passes float colours and the format through to its nodes', async () => {
  const n = 3000,
    xyz = new Float32Array(n * 3).map((_, i) => (i * 37) % 101),
    colors = new Float32Array(n * 3).fill(6),
    tree = buildOctree({ positions: xyz, colors, colorComponents: 3 }, { maxPointsPerNode: 500 }),
    clouds = new Set(),
    octree = new OctreeCloud({ add: (c) => (clouds.add(c), c), remove: (c) => clouds.delete(c) }, tree, {
      cloud: { colorFormat: 'float' },
    });
  octree.select({ position: [50, 50, 300], screenHeight: 400 });
  await new Promise((r) => setTimeout(r, 0));
  octree.select({ position: [50, 50, 300], screenHeight: 400 });
  const [first] = clouds;
  assert.equal(first.colorFormat, 'float');
  assert.equal(first.floatColors[0], 6);
});
