// How frame cost grows with the object count: 1 to 100,000 meshes, then 100,000 and 250,000 instances.
import { sceneCases } from '../lib/browser.mjs';

export default {
  name: 'scaling',
  title: 'Scaling: 1 to 100,000 meshes, 250,000 instances',
  uses: 'gpu',
  cases: sceneCases('scaling', {
    primary: ['cpuMs', 'gpuMs'],
    keep: ['cpuMs', 'gpuMs', 'fps', 'serialFrameMs', 'buildMs', 'jsHeapMB', 'gpuMB', 'drawCalls'],
  }),
};
