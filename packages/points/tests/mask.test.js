import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { PointsPlugin, PointCloud } from '../dist/index.js';
import { pointShader } from '../src/shaders.ts';
import { maskColor } from '../../shared/selection-mask.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const positions = Array.from({ length: 70 * 3 }, (_, i) => (i % 3 === 2 ? 0 : (i % 7) * 0.1));

test('a selection mask packs one bit a point after its style header and updates in place', () => {
  const cloud = new PointCloud({ positions, sizes: Array(70).fill(2), material: { shape: 'square', edl: true } });
  assert.equal(cloud.mask, null);
  assert.equal(cloud.isSelected(3), true, 'no mask: every point is selected');
  const structure = cloud.structure;
  cloud.setMask(
    Array.from({ length: 70 }, (_, i) => i % 3 === 0),
    { mode: 'filter' },
  );
  assert.equal(cloud.structure, structure + 1, 'adding a mask reallocates');
  assert.equal(cloud.mask.length, 4 + 3);
  assert.deepEqual([cloud.mask[0], cloud.mask[3]], [2, 1], 'filter mode, present');
  assert.equal(cloud.maskStyle.mode, 'filter');
  assert.deepEqual(
    Array.from({ length: 70 }, (_, i) => cloud.isSelected(i)),
    Array.from({ length: 70 }, (_, i) => i % 3 === 0),
  );
  const version = cloud.maskVersion;
  cloud.updateMask(68, [1, 0]);
  assert.equal(cloud.structure, structure + 1, 'updates never reallocate');
  assert.equal(cloud.maskVersion, version + 1);
  assert.deepEqual([cloud.isSelected(68), cloud.isSelected(69)], [true, false]);
  cloud.setMaskStyle({ mode: 'highlight', fade: 0.5 });
  assert.equal(cloud.mask[0], 1);
  assert.equal(new Float32Array(cloud.mask.buffer, 4, 1)[0], 0.5);
  assert.equal(cloud.sizes.length, 70, 'per-point sizes and material stay as they were');
  assert.equal(cloud.material.edl, true);
  assert.throws(() => cloud.updateMask(69, [1, 1]), RangeError);
  assert.throws(() => cloud.setMask([1, 2]), RangeError);
  assert.throws(() => cloud.setMaskStyle({ mode: 'dim' }), RangeError);
  assert.throws(() => cloud.setMaskStyle({ fade: 2 }), RangeError);
  assert.throws(() => cloud.setMaskStyle({ highlight: '#ff0000' }), RangeError);
  cloud.setMask(null);
  assert.equal(cloud.mask, null);
  assert.equal(cloud.structure, structure + 2, 'removing a mask reallocates');
  assert.throws(() => cloud.updateMask(0, [1]), /setMask/);
});

test('the CPU mask colours match the shader maths', () => {
  const cloud = new PointCloud({ positions: [0, 0, 0, 1, 0, 0] });
  cloud.setMask([1, 0], { mode: 'highlight', highlight: [1, 0, 0], highlightAmount: 0.5, fade: 0.25 });
  assert.deepEqual(maskColor(cloud.mask, [0.8, 0.4, 0.2], 1), [0.2, 0.1, 0.05]);
  // The highlight colour and amount are stored as 8-bit sRGB, as the shader unpacks them.
  const a = 128 / 255;
  assert.deepEqual(maskColor(cloud.mask, [0, 0.4, 1], 0), [a, 0.4 + (0 - 0.4) * a, 1 - a]);
  assert.deepEqual(maskColor(cloud.mask, [0, 0.4, 1], 0, 1), [0, 0.1, 0.25], 'a pair is selected when both are');
  cloud.setMaskStyle({ mode: 'filter' });
  assert.equal(maskColor(cloud.mask, [1, 1, 1], 1), null);
  assert.deepEqual(maskColor(cloud.mask, [1, 1, 1], 0), [1, 1, 1]);
  assert.match(pointShader, /@group\(1\) @binding\(7\) var<storage,read> margoMask/);
  assert.match(pointShader, /margoMaskHidden\(on\)\)\{out\.clip=vec4f\(0\.0,0\.0,-1\.0,1\.0\);return out;\}/);
});

test('a mask change uploads only the mask, once, and keeps every draw and pipeline', () => {
  const gpu = mockGPU(),
    plugin = new PointsPlugin(),
    camera = new Camera({ position: [0, 0, 8], target: [0, 0, 0] });
  camera.update(1, true);
  gpu.record(() => plugin.setup({ backend: 'webgpu', gpu: gpu.device, sceneOf() {} }));
  const cloud = plugin.add(new PointCloud({ positions, material: { size: 4 } }));
  const view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
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
  const plain = frame();
  frame();
  cloud.setMask(Array(70).fill(1));
  frame();
  frame();
  cloud.updateMask(0, Array(70).fill(0));
  const changed = frame();
  const writes = changed.filter((e) => e[0] === 'writeBuffer');
  assert.deepEqual(
    writes.map((e) => e[3].length / 2),
    [28],
    'one write of the 28-byte mask (16-byte header and 70 bits)',
  );
  assert.equal(changed.filter((e) => e[0] === 'renderPipeline').length, 0, 'no pipeline is made');
  assert.equal(
    changed.filter((e) => e[0] === 'pass.draw').length,
    plain.filter((e) => e[0] === 'pass.draw').length,
    'the same draws',
  );
  assert.equal(frame().filter((e) => e[0] === 'writeBuffer').length, 0, 'a steady frame writes nothing');
});
