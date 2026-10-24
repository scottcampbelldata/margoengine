// Physics in Node: @margoengine/physics (Rapier) stepping a pile of falling boxes into core meshes, and the machinery
// package's Wasm conveyor solver (SurfacePhysics) moving 500 queued parts.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { headlessEngine, ms, nodeCase, timed } from '../lib/node.mjs';
import { root } from '../lib/env.mjs';

async function rapier() {
  const entry = resolve(
    process.env.MARGOENGINE_RAPIER ?? resolve(root, 'node_modules/@dimforge/rapier3d-compat'),
    'dist/rapier.mjs',
  );
  const RAPIER = (await import(pathToFileURL(entry).href)).default,
    warn = console.warn;
  console.warn = () => {}; // wasm-bindgen's notice about init() arguments
  await RAPIER.init();
  console.warn = warn;
  return RAPIER;
}

export default {
  name: 'physics',
  title: 'Rigid bodies (Rapier) and the conveyor solver (Node)',
  uses: 'cpu',
  async cases() {
    const state = {};
    const pile = (n) =>
      nodeCase(
        `rigid-boxes-${n}`,
        `${n} boxes falling onto a floor, one 1/60 s step (@margoengine/physics)`,
        { stepMs: ms() },
        () => ({ stepMs: timed(() => state[n].physics.step(), { reps: 120, warm: 0 }) }),
        {
          async setup() {
            const [{ Physics }, { box }, RAPIER] = await Promise.all([
              import('../../packages/physics/dist/index.js'),
              import('../../packages/core/dist/extension.js'),
              rapier(),
            ]);
            const e = await headlessEngine(n + 4),
              physics = new Physics(e, { rapier: RAPIER }),
              side = Math.ceil(Math.cbrt(n));
            physics.addBody(
              e
                .createMesh()
                .setGeometry(box(60, 1, 60))
                .setPosition([0, -0.5, 0]),
              { type: 'fixed' },
            );
            const cube = box(0.5, 0.5, 0.5);
            for (let i = 0; i < n; i++)
              physics.addBody(
                e
                  .createMesh()
                  .setGeometry(cube)
                  .setPosition([
                    ((i % side) - side / 2) * 0.6,
                    1 + Math.floor(i / side / side) * 0.6,
                    (Math.floor(i / side) % side) * 0.6 - side * 0.3,
                  ]),
                { colliders: { shape: 'box' } },
              );
            for (let i = 0; i < 30; i++) physics.step(); // bodies in contact before timing
            state[n] = { e, physics };
          },
          async teardown() {
            state[n]?.physics.dispose();
            state[n]?.e.dispose();
            delete state[n];
          },
        },
      );
    return [
      pile(1000),
      pile(5000),
      nodeCase(
        'conveyor-500',
        '500 queued parts on a conveyor, one solver tick (@margoengine/machinery SurfacePhysics)',
        { solverMs: ms(), updateMs: ms(false) },
        () => {
          const s = state.conveyor;
          return {
            solverMs: timed(() => s.memory.api.surface_tick(s.memory.ptr, 500, 1 / 60, 10), { reps: 2000, warm: 100 }),
            updateMs: timed(() => s.onPreUpdate(1 / 60), { reps: 2000, warm: 100 }),
          };
        },
        {
          async setup() {
            const [{ SurfacePhysics }, { box }] = await Promise.all([
              import('../../packages/machinery/dist/index.js'),
              import('../../packages/core/dist/extension.js'),
            ]);
            const e = await headlessEngine(504),
              motor = e.createMesh(),
              gate = e.createMesh(),
              nodes = Array.from({ length: 500 }, (_, i) => e.createMesh().setGeometry(box()).setPosition([i, 0, 0]));
            const s = await SurfacePhysics.create(
              nodes.map((node, i) => ({
                node,
                carrier: i === 499 ? 1 : 0,
                lane: 0,
                axis: [1, 0, 0],
                halfLength: 0.49,
                friction: 1,
              })),
              [{ node: motor, velocity: [1, 0, 0] }, { node: gate }],
              { gravity: 10 },
            );
            e.use(s);
            for (let i = 0; i < 1000; i++) s.onPreUpdate(1 / 60);
            state.conveyor = s;
            state.conveyorEngine = e;
          },
          async teardown() {
            state.conveyorEngine?.dispose();
            delete state.conveyor;
          },
        },
      ),
    ];
  },
};
