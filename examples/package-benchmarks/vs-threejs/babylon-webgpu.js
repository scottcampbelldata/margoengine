// Babylon.js WebGPUEngine entry (antialias: true = 4x MSAA). Its shaders are WGSL, so the page never downloads
// Babylon's GLSL-to-WGSL compilers (glslang/twgsl), which it would only fetch for a GLSL shader.
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import { run, webgpuDevice } from './harness.js';
import { babylonScene } from './babylon-scenes.js';

run(async (canvas, params, marks) => {
  const s = performance.now(),
    antialias = !params.diag.includes('msaa1'),
    engine = new WebGPUEngine(canvas, { antialias, powerPreference: 'high-performance' });
  await engine.initAsync();
  marks.createMs = +(performance.now() - s).toFixed(1);
  const device = webgpuDevice(),
    idle = () => device.queue.onSubmittedWorkDone();
  const scene = await babylonScene(canvas, params, marks, engine, idle);
  return { ...scene, samples: antialias ? 4 : 1, idle };
});
