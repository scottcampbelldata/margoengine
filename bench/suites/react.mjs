// React: mount n declared boxes (buildMs), then re-render all of them every frame (cpuMs is reconcile + commit + draw).
import { sceneCases } from '../lib/browser.mjs';

export default {
  name: 'react',
  title: 'React: mount, re-render, frame time',
  uses: 'gpu',
  cases: sceneCases('react', {
    primary: ['buildMs', 'cpuMs'],
    keep: ['buildMs', 'createMs', 'cpuMs', 'gpuMs', 'fps', 'jsHeapMB', 'drawCalls'],
  }),
};
