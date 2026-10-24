// Memory: JS heap per 100,000 core meshes in Node, then, in the browser, JS heap (after two forced GCs) and live GPU
// memory (buffers and textures the page created and has not destroyed, counted by the harness's WebGPU wrappers)
// after the throughput phase.
import { sceneCases } from '../lib/browser.mjs';
import { headlessEngine, memoryMB, nodeCase } from '../lib/node.mjs';

const mb = (primary = true) => ({ unit: 'MB', better: 'lower', primary });

export default {
  name: 'memory',
  title: 'JS heap and GPU memory',
  uses: 'gpu',
  async cases(ctx) {
    return [
      nodeCase(
        'heap-100k-meshes',
        'JS heap and buffers (kernel memory) of 100,000 core meshes sharing one geometry and material (Node)',
        { heapMB: mb(), buffersMB: mb(), bytesPerMesh: { unit: 'B', better: 'lower' } },
        async () => {
          const { box } = await import('../../packages/core/dist/extension.js');
          const before = memoryMB(),
            e = await headlessEngine(100_002),
            geometry = box();
          for (let i = 0; i < 100_000; i++)
            e.createMesh()
              .setGeometry(geometry)
              .setPosition([i * 0.01, 0, 0]);
          e.render();
          const after = memoryMB(),
            heap = after.heap - before.heap,
            buffers = after.buffers - before.buffers;
          e.dispose();
          return { heapMB: heap, buffersMB: buffers, bytesPerMesh: ((heap + buffers) * 2 ** 20) / 100_000 };
        },
      ),
      ...sceneCases('memory', {
        primary: ['jsHeapMB', 'gpuMB'],
        keep: ['jsHeapMB', 'gpuMB', 'gpuPeakMB', 'buildMs'],
      })(ctx),
    ];
  },
};
