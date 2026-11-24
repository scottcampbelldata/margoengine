// Physics in Node: @margoengine/physics (the own kernel) stepping a pile of falling boxes into core meshes.
import { headlessEngine, ms, nodeCase, timed } from '../lib/node.mjs';

export default {
  name: 'physics',
  title: 'Rigid bodies in Node',
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
            const [{ Physics }, { box }] = await Promise.all([
              import('../../packages/physics/dist/index.js'),
              import('../../packages/core/dist/extension.js'),
            ]);
            await (await import('../../packages/physics/dist/index.js')).Physics.load();
            const e = await headlessEngine(n + 4),
              physics = new Physics(e),
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
    return [pile(1000), pile(5000)];
  },
};
