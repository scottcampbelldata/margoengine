// A Lines plugin on the recording mock GPU, for tests of what it asks the GPU to do.
import { Camera } from '@margoengine/core';
import { Lines } from '../dist/index.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

export function rig({ samples = 1 } = {}) {
  const gpu = mockGPU(),
    lines = new Lines(),
    camera = new Camera({ position: [0, 1, 8], target: [0, 1, 0] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  camera.update(1, true);
  const setup = gpu.record(() => lines.setup({ backend: 'webgpu', gpu: gpu.device, canvas: { clientWidth: 64 } })),
    run = passes(lines);
  return {
    gpu,
    lines,
    camera,
    setup,
    frame: (delta = 0) =>
      gpu.record(() =>
        run({
          backend: 'webgpu',
          device: gpu.device,
          encoder: gpu.encoder,
          camera,
          width: 64,
          height: 64,
          delta,
          format: 'rgba8unorm',
          color: view,
          depth: view,
          descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: samples } },
        }),
      ),
  };
}
