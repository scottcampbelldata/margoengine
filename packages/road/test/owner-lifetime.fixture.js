import { createCompute } from '../../compute/dist/index.js';
import { shortestPaths } from '../../compute/dist/graph.js';
import { Spline } from '../../splines/dist/index.js';
import { ownedByEngine, lifetimeFault } from '../../../tests/support/owner-shell.js';

// road's one GPU object is the CsrMatrix `roadGraph` returns: caller-owned buffers on the compute context's device. The
// fixture is the caller. Its compute context is the caller's own dependency (shared with the device, ended at cleanup,
// as a render target is in the tilemap fixture), so what the owner must release by itself is the matrix and the
// routing results made on it: skipping `matrix.dispose()` or a result's `dispose()` leaves buffers alive and fails.
const curve = (length) =>
  new Spline([
    [0, 0, 0],
    [length, 0, 0],
  ]);
const roads = [
  { from: 0, to: 1, curve: curve(100), speed: 10, direction: 'forward' },
  { from: 0, to: 2, curve: curve(60), speed: 10 },
  { from: 2, to: 1, curve: curve(60), speed: 10 },
];

export async function fixtures(load = (entry) => import(entry)) {
  const { roadGraph } = await load('../dist/graph.js');
  return [
    {
      name: 'roadGraph',
      async create({ engine, scene, dependency }) {
        const context = await dependency(() => createCompute({ engine }));
        const matrix = roadGraph(context, { vertices: 4, roads });
        if (matrix.disposed || matrix.nnz !== 5)
          lifetimeFault('roadGraph returns a live matrix of its five directed edges');
        const routed = await shortestPaths(matrix, 0);
        const release = () => {
          routed.distances.dispose();
          routed.predecessors.dispose();
          matrix.dispose();
        };
        return ownedByEngine(scene, 'roadGraph', release, {
          cleanup() {
            if (!matrix.disposed) lifetimeFault('the matrix a caller disposes reports itself disposed');
            context.dispose();
          },
        });
      },
    },
  ];
}
