import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { InfiniteGrid, gridCoverage } from '../dist/infinite-grid.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

// Infinite shader grid: the lines come from the fragment shader (one draw), a disc of fade follows the camera.

const rig = (options, position = [3, 4, 8]) => {
  const gpu = mockGPU(),
    grid = new InfiniteGrid(options),
    camera = new Camera({ position, target: [position[0], 0, position[2] - 1] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  camera.update(1, true);
  const setup = gpu.record(() => grid.setup({ backend: 'webgpu', gpu: gpu.device, canvas: { clientWidth: 64 } }));
  const run = passes(grid);
  return {
    gpu,
    setup,
    grid,
    frame: () =>
      gpu.record(() =>
        run({
          backend: 'webgpu',
          device: gpu.device,
          encoder: gpu.encoder,
          camera,
          width: 64,
          height: 64,
          delta: 0,
          format: 'rgba8unorm',
          color: view,
          depth: view,
          descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 1 } },
        }),
      ),
  };
};
const floats = (log) => {
  const hex = log.find((e) => e[0] === 'writeBuffer')[3];
  return Array.from(new Float32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer));
};

test('gridCoverage: full on a line, one pixel ramp, none beyond, fading out when cells shrink under two pixels', () => {
  assert.equal(gridCoverage(5, 1, 1, 0.01), 1);
  assert.equal(gridCoverage(5.5, 1, 1, 0.01), 0);
  assert.ok(Math.abs(gridCoverage(0.05, 1, 1, 0.1) - 0.5) < 1e-9);
  assert.ok(Math.abs(gridCoverage(0, 1, 1, 0.6) - 0.8) < 1e-9);
  assert.equal(gridCoverage(0, 1, 1, 1), 0);
  assert.ok(gridCoverage(0, 1, 4, 0.1) === 1 && gridCoverage(0.3, 1, 4, 0.1) === 0);
});

test('one draw of two triangles, alpha blended, depth tested and never written', () => {
  const { frame, setup } = rig(),
    log = frame(),
    pipeline = log.find((e) => e[0] === 'renderPipeline')[2];
  assert.equal(log.filter((e) => e[0] === 'pass.draw').length, 1);
  assert.equal(log.find((e) => e[0] === 'pass.draw')[1], 6);
  assert.equal(pipeline.depthStencil.depthWriteEnabled, false);
  assert.equal(pipeline.depthStencil.depthCompare, 'greater-equal', 'the engine depth buffer is reversed-Z');
  assert.equal(pipeline.fragment.targets[0].blend.color.srcFactor, 'src-alpha');
  assert.match(setup.find((e) => e[0] === 'module')[2].code, /fwidth/);
});

test('the fade disc follows the camera, or stays on the origin without followCamera', () => {
  const follow = floats(rig({ cellSize: 0.5, sectionSize: 5, fadeDistance: 60, y: 0.25 }).frame());
  assert.deepEqual(follow.slice(16, 20), [3, 0.25, 8, 60]);
  assert.deepEqual(follow.slice(20, 24), [0.5, 5, 1, 1.5]);
  assert.deepEqual(follow.slice(24, 28), [60, 3, 8, 1]);
  const fixed = floats(rig({ followCamera: false }).frame());
  assert.deepEqual(fixed.slice(16, 20), [0, 0, 0, 100]);
  assert.deepEqual(fixed.slice(25, 27), [0, 0]);
});

test('live edits are validated every frame and bad options throw with their fix', () => {
  assert.throws(() => new InfiniteGrid({ cellSize: 0 }), /cellSize/);
  assert.throws(() => new InfiniteGrid({ cellSize: 2, sectionSize: 1 }), /at least cellSize/);
  assert.throws(() => new InfiniteGrid({ opacity: 2 }), /opacity from 0 to 1/);
  assert.doesNotThrow(() => new InfiniteGrid({ sectionSize: 0 }));
  const { grid, frame } = rig();
  grid.fadeDistance = -1;
  assert.throws(frame, /fadeDistance/);
});

test('needs WebGPU, and dispose frees the buffer', () => {
  assert.throws(() => new InfiniteGrid().setup({ backend: 'webgl2' }), /needs WebGPU/);
  const { grid, gpu } = rig(),
    log = gpu.record(() => grid.dispose());
  assert.ok(log.some((e) => e[0] === 'destroy'));
  assert.doesNotThrow(() => grid.dispose());
});
