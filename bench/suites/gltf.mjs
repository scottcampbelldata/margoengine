// glTF: load time (fetch, parse, GPU upload) and frame cost of three standard models, then the helmet with image-based
// lighting and shadows.
import { sceneCases } from '../lib/browser.mjs';

export default {
  name: 'gltf',
  title: 'glTF load and draw',
  uses: 'gpu',
  cases: sceneCases('gltf', {
    primary: ['buildMs', 'gpuMs'],
    keep: ['buildMs', 'firstFrameMs', 'cpuMs', 'gpuMs', 'fps', 'jsHeapMB', 'gpuMB', 'drawCalls'],
  }),
};
