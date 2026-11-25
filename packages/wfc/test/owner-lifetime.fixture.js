export const leafPerEntry = true;
import { PbrMaterial, box } from '../../core/dist/index.js';
import { ownedByEngine } from '../../../tests/support/owner-shell.js';

const tiles = [0, 1].map(() => ({ neighbors: Array.from({ length: 6 }, () => [0, 1]) }));
const fail = (message) => {
  throw new Error(`OWNER_LIFETIME: ${message}`);
};

// A worker the solve starts and a timer it sets, seen while the constructor runs: the worker must be terminated and
// the timeout cleared once the solve is disposed. The globals are swapped for that one call only.
function watched(make) {
  const workers = [],
    timers = new Set();
  class FakeWorker {
    terminated = 0;
    constructor() {
      workers.push(this);
    }
    postMessage() {}
    terminate() {
      this.terminated++;
    }
  }
  const swap = (values, fn) => {
    const saved = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.assign(globalThis, values);
    try {
      return fn();
    } finally {
      for (const [key, descriptor] of saved)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
    }
  };
  const { setTimeout: set, clearTimeout: clear } = globalThis;
  const timing = {
    setTimeout: (...args) => {
      const id = set(...args);
      timers.add(id);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
      return clear(id);
    },
  };
  // Assigning a browser's own `location` would navigate the page, so it is only filled in where there is none.
  const value = swap(
    { ...timing, Worker: FakeWorker, ...(globalThis.location ? {} : { location: { href: 'file:///' } }) },
    make,
  );
  return { value, workers, timers, disposing: (fn) => swap(timing, fn) };
}

export async function fixtures(load = (entry) => import(entry)) {
  const { assembleWFC } = await load('../dist/assemble.js');
  const { ChunkedWFC } = await load('../dist/chunks.js');
  const { WFCWorkerSolve } = await load('../dist/worker.js');
  return [
    {
      name: 'WFCWorkerSolve',
      create({ scene }) {
        // The app's signal outlives the solve: its abort listener goes with the solve.
        const controller = new AbortController();
        const {
          value: solve,
          workers,
          timers,
          disposing,
        } = watched(() => new WFCWorkerSolve([2, 2, 1], tiles, { signal: controller.signal }));
        solve.result.catch(() => {});
        return ownedByEngine(scene, 'WFCWorkerSolve', () => disposing(() => solve.dispose()), {
          cleanup() {
            if (workers.length !== 1 || workers[0].terminated < 1)
              fail('a disposed WFC worker solve leaves its worker running');
            if (timers.size) fail('a disposed WFC worker solve leaves its timeout armed');
          },
        });
      },
    },
    {
      name: 'ChunkedWFC',
      async create({ scene }) {
        const world = new ChunkedWFC([2, 2, 1], tiles, 7);
        await world.solveChunk([0, 0, 0]);
        await world.solveChunk([1, 0, 0]);
        if (world.size !== 2) fail('the chunked world keeps the chunks it solved');
        return ownedByEngine(scene, 'ChunkedWFC', () => world.dispose(), {
          check({ phase }) {
            if (phase === 'disposed' && world.size !== 0) fail('a disposed chunked world still holds its chunks');
          },
        });
      },
    },
    {
      name: 'TileAssembly',
      create({ engine, scene, dependency }) {
        const mesh = (parent) => engine.createMesh(parent);
        const [root, primitive] = dependency(() => {
          const r = mesh(),
            p = mesh(r);
          p.setGeometry(box(1, 1, 1)).setMaterial(new PbrMaterial());
          return [r, p];
        });
        const before = engine.meshes.size;
        // The placed meshes share the templates' geometry and are drawn by the engine's own pass, which the first mesh of
        // a scene registers: the call is the caller's, like the templates, and the mesh count below is what it owes.
        const assembly = dependency(() =>
          assembleWFC(
            engine,
            [2, 2, 1],
            [0, 0, 0, 0],
            [{ source: 0, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] }],
            [{ root, meshes: [primitive] }],
          ),
        );
        return ownedByEngine(
          scene,
          'TileAssembly',
          () => {
            assembly.dispose();
            if (engine.meshes.size > before) fail('a disposed tile assembly leaves its placed meshes in the engine');
          },
          {
            cleanup: () => {
              primitive.dispose();
              root.dispose();
            },
          },
        );
      },
    },
  ];
}
