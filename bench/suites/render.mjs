// Draw throughput, materials, lights, shadows and post-processing: CPU and GPU time per frame of the render scenes in
// bench/scenes/catalog.js (STANDARD.render).
import { sceneCases } from '../lib/browser.mjs';

export default {
  name: 'render',
  title: 'Draw throughput, materials, lights, shadows, post',
  uses: 'gpu',
  cases: sceneCases('render', { primary: ['cpuMs', 'gpuMs'] }),
};
