// Owner/lifetime fixture for @margoengine/robot-planning. Its objects are not engine plugins: an app hangs a
// GPUClearance (GPU buffers on the engine's device and a compute pipeline) off its engine, and runs plans and URDF
// loads with its own signal, which outlives them (owner-shell.js ties each to a registration). GPUClearance must free
// every buffer on dispose, after an evaluation too (where the device can run compute: the browser leaves); planPath
// and planToPose must leave no timer armed when they settle; loadURDF fetches with the app's signal and must leave no
// listener on it. Not entries: Robot, JointLimitSolver, Roadmap, sweepRobot, parseURDF and planPathSync compute on
// numbers in one call and hold nothing.
import { ownedByEngine, lifetimeFault, watchTimers } from '../../../tests/support/owner-shell.js';

const along = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const urdf = `<robot name="arm"><link name="base"><collision><geometry><box size="0.2 0.2 0.2"/></geometry></collision></link>
<link name="tip"><collision><geometry><sphere radius="0.05"/></geometry></collision></link>
<joint name="j" type="revolute"><parent link="base"/><child link="tip"/><origin xyz="1 0 0"/><axis xyz="0 0 1"/>
<limit lower="-1" upper="1"/></joint></robot>`;
const served = (text) => async (_input, init) => {
  init?.signal?.throwIfAborted();
  return new Response(text);
};

export async function fixtures(load = (entry) => import(entry)) {
  const { Robot } = await load('../dist/index.js');
  const { planPath, planToPose } = await load('../dist/plan.js');
  const { GPUClearance } = await load('../dist/gpu.js');
  const { loadURDF } = await load('../dist/urdf.js');
  const { SphereVolume, ConvexHullVolume } = await load('../../kinematics-constraints/dist/index.js');
  const arm = () =>
    new Robot({
      joints: [
        { lower: -3, upper: 3 },
        { lower: -3, upper: 3, origin: along(1, 0, 0) },
      ],
      shapes: [{ joint: 1, end: [1, 0, 0], radius: 0.05 }],
    });
  const wall = () => new ConvexHullVolume({ points: [1.5, -0.2, -1, 1.5, -0.2, 1, 3, -0.2, -1, 3, -0.2, 1] });
  // One call the app starts with its own signal; the entry's check runs once the call has settled.
  const call = (name, run) => ({
    name,
    async create({ scene }) {
      const timers = watchTimers(),
        app = new AbortController();
      const result = await timers.scope(() => run(app.signal));
      if (!result) lifetimeFault(`${name} returned nothing`);
      return ownedByEngine(scene, name, () => {}, {
        check: ({ phase }) => phase === 'disposed' && timers.expectNone(name),
      });
    },
  });
  return [
    {
      name: 'GPUClearance',
      async create({ engine, scene }) {
        const clearance = new GPUClearance(engine.gpu, arm(), [
          new SphereVolume({ center: [3, 0, 0], radius: 0.5 }),
          wall(),
        ]);
        let evaluated = false;
        return ownedByEngine(scene, 'GPUClearance', () => clearance.dispose(), {
          async check({ phase }) {
            // The compute pipeline needs a device that compiles WGSL and maps buffers; the CPU model's inert one (node, no
            // document) has neither, though its adapter now fills in createComputePipelineAsync, so the browser is the test.
            if (phase === 'render' && !evaluated && typeof document !== 'undefined') {
              evaluated = true;
              const gaps = await clearance.evaluate([0, 0, 0.5, -0.5]);
              if (gaps.length !== 2 || !gaps.every((g) => Number.isFinite(g) || g === Infinity))
                lifetimeFault(`GPUClearance answered ${Array.from(gaps)}`);
            }
          },
        });
      },
    },
    call('planPath', (signal) => planPath(arm(), [0.3, 0], [-0.3, 0], { colliders: [wall()], seed: 7, signal })),
    call('planToPose', (signal) => planToPose(arm(), [0, 0], { position: [0, 2, 0] }, { tip: 1, seed: 3, signal })),
    call('loadURDF', (signal) => loadURDF('https://robots.example/arm.urdf', { fetch: served(urdf), signal })),
  ];
}
