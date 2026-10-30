// Moving boxes at 10,000, 100,000 and 250,000: @margoengine/culling DynamicInstances (GPU matrices, culling and indirect
// draws), core meshes and CPU instancing, each box's matrix set every frame (item 53.2).
import { sceneCases } from '../lib/browser.mjs';

export default {
  name: 'dynamic',
  title: 'Dynamic: 10,000 to 250,000 moving boxes',
  uses: 'gpu',
  cases: sceneCases('dynamic', {
    primary: ['cpuMs', 'gpuMs'],
    keep: ['cpuMs', 'gpuMs', 'fps', 'serialFrameMs', 'buildMs', 'jsHeapMB', 'gpuMB', 'drawCalls'],
  }),
};
