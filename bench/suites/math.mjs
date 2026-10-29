// Kernel math in Node (the same Wasm as the browser): transform propagation, frustum culling, matrix maths, BVH
// raycasts on a mesh.
import { headlessEngine, ms, nodeCase, timed } from '../lib/node.mjs';

const dist = (p) => `../../packages/${p}/dist/index.js`;

/** n meshes, flat (depth 1) or in chains of `depth`; returns the engine after one render. */
async function scene(n, depth) {
  const e = await headlessEngine(n + 2);
  let parent = null;
  for (let i = 0; i < n; i++) {
    parent = e.createMesh(depth > 1 && i % depth ? parent : null).setPosition([((i * 7) % 101) * 0.1, 0, 0.01 * i]);
  }
  e.render();
  return e;
}

/** A height-field grid of 2 * side^2 triangles. */
function grid(side) {
  const positions = new Float32Array((side + 1) ** 2 * 3),
    indices = new Uint32Array(side * side * 6);
  for (let y = 0, k = 0; y <= side; y++)
    for (let x = 0; x <= side; x++, k += 3)
      positions.set([x / side - 0.5, Math.sin(x * 0.3) * Math.cos(y * 0.2) * 0.02, y / side - 0.5], k);
  for (let y = 0, k = 0; y < side; y++)
    for (let x = 0; x < side; x++, k += 6) {
      const a = y * (side + 1) + x;
      indices.set([a, a + side + 1, a + 1, a + 1, a + side + 1, a + side + 2], k);
    }
  return { positions, indices };
}

export default {
  name: 'math',
  title: 'Kernel transforms, culling, matrices, raycasts (Node)',
  uses: 'cpu',
  async cases() {
    const state = {};
    const tick = (key, culling) => () => ({
      tickMs: timed(() => state[key].store.tick(culling), { reps: 60, warm: 10 }),
    });
    const engineCase = (key, n, depth, culling, title) =>
      nodeCase(key, title, { tickMs: ms() }, tick(key, culling), {
        setup: async () => (state[key] ??= await scene(n, depth)),
        teardown: async () => {
          state[key]?.dispose();
          delete state[key];
        },
      });
    return [
      engineCase('transforms-100k', 100_000, 1, false, '100,000 root meshes: world matrices'),
      engineCase('transforms-chains-100k', 100_000, 10, false, '100,000 meshes in 10-deep chains: world matrices'),
      engineCase('culling-100k', 100_000, 1, true, '100,000 meshes: world matrices + frustum culling'),
      nodeCase(
        'matrix-compose-100k',
        '100,000 compose + multiply (@margoengine/math Matrix4)',
        { ms: ms() },
        async () => {
          const { Matrix4, Quaternion, Vector3, Euler } = await import(dist('math'));
          const m = new Matrix4(),
            parent = new Matrix4().makeTranslation(1, 2, 3),
            q = new Quaternion(),
            e = new Euler(),
            p = new Vector3(),
            s = new Vector3(1, 1, 1);
          return {
            ms: timed(
              () => {
                for (let i = 0; i < 100_000; i++)
                  m.compose(p.set(i, 0, 1), q.setFromEuler(e.set(0, i, 0)), s).premultiply(parent);
              },
              { reps: 15 },
            ),
          };
        },
      ),
      nodeCase(
        'raycast-bvh-500k',
        'BVH build and 10,000 rays on a 500,000-triangle mesh (@margoengine/bvh)',
        { buildMs: ms(), raysMs: ms() },
        async () => {
          const { MeshBVH } = await import(dist('bvh'));
          const mesh = (state.grid ??= grid(500));
          let bvh;
          const buildMs = timed(() => (bvh = MeshBVH.build(mesh)), { reps: 3, warm: 1 });
          const raysMs = timed(
            () => {
              for (let i = 0; i < 10_000; i++)
                bvh.raycastFirst({
                  origin: [((i % 100) / 100 - 0.5) * 0.9, 1, (Math.floor(i / 100) / 100 - 0.5) * 0.9],
                  direction: [0, -1, 0],
                });
            },
            { reps: 9 },
          );
          return { buildMs, raysMs };
        },
        { teardown: async () => delete state.grid },
      ),
    ];
  },
};
