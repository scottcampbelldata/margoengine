// three.js WebGPURenderer entry ('three' is aliased to 'three/webgpu' in this build; antialias: true = 4x MSAA).
import {WebGPURenderer} from 'three/webgpu';
import {run} from './harness.js';
import {threeScene} from './three-scenes.js';

run(async (canvas, params, marks) => {
  const s = performance.now(), renderer = new WebGPURenderer({canvas, antialias: true, powerPreference: 'high-performance'});
  await renderer.init();
  if (!renderer.backend.isWebGPUBackend) throw new Error('three.js fell back to its WebGL2 backend');
  marks.createMs = +(performance.now() - s).toFixed(1);
  return threeScene(canvas, params, marks, renderer, 'webgpu');
});
