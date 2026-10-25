// Instanced boxes, static at 1,000 / 10,000 / 50,000 and moving at 10,000, through each instancing path an engine has
// (Margo: createInstancedMesh and CulledInstances). The instanced <-> instanced comparison of
// docs/whitepaper/boxes-vs-threejs.md; run it with --engines=margo,<other engines>.
import { sceneCases } from '../lib/browser.mjs';

export default {
  name: 'instanced',
  title: 'Instanced boxes: static and moving',
  uses: 'gpu',
  cases: sceneCases('instanced', { primary: ['cpuMs', 'gpuMs'] }),
};
