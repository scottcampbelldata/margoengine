import assert from 'node:assert/strict';
import test from 'node:test';
import { CrushSolver, crushInertiaChannel } from '../../dist/crush.js';
import { Physics } from '../../dist/index.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';

const zero = [0, 0, 0];
const strikingMass = 28.5;
const struckMass = 30.5;
const strikingSurge = 1.05 * strikingMass;
const struckSway = 1.21 * struckMass;

function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}, tolerance ${tolerance}`);
}

// Tabri, Määttänen and Ranta (2008), Figure 13b, test 103 only.
// Read the loading branch of the original model scale graph, in metres and newtons.
const loadingSamples = [
  [0.002, 3],
  [0.005, 27],
  [0.01, 65],
  [0.015, 105],
  [0.02, 145],
  [0.025, 187],
  [0.03, 228],
  [0.035, 261],
  [0.04, 290],
  [0.044, 298],
  [0.0458, 295],
];
const stiffness = 298 / (0.0458 - 0.0427); // Peak load over the reported immediate recovery.
const foamEnvelope = {
  stiffness,
  loading: [{ stroke: 1 / stiffness, force: 1 }, ...loadingSamples.map(([stroke, force]) => ({ stroke, force }))],
};

// Tabri Table 2 supplies the author-calculated water inertia, instead of fitting a hull mesh to the impact results.
function publishedInertia(channel, rate, rows) {
  const id = 'tabri-published-inertia';
  let region;
  return {
    id,
    describe: () => ({ id, rate, stableRate: () => rate, fields: [{ field: channel.mobility, access: 'write' }] }),
    init(host) {
      const rowWords = 73;
      region = host.allocate('published-mobility', rowWords * host.bodyRows() * 8, 'f64', 1);
      const words = regionWords(host.memory, region);
      for (const { row, dry, added } of rows) {
        const at = rowWords * row;
        words[at] = 1;
        for (let axis = 0; axis < 6; axis++) {
          const inverse = 1 / (dry[axis] + added[axis]);
          words[at + 1 + 7 * axis] = inverse;
          words[at + 37 + 7 * axis] = dry[axis] * inverse;
        }
      }
    },
    step() {},
    importPorts() {},
    exportPorts: (tick) => [{ field: channel.mobility.name, region, tick, cell: zero }],
    stateRegions: () => [region],
    extraState: () => [],
  };
}

async function runTabriTest(rate, { speed, height, offset }, replay) {
  await Physics.load();
  const hz = 60 << rate;
  const world = new PhysicsWorld({ rate: { num: hz, den: 1 }, gravity: zero, memory: worldMemory(false) });
  using physics = new Physics(null, { arena: world.arena, gravity: zero, fixedTimestep: 1 / hz });
  const strikingInertia = [strikingMass * 0.15 ** 2, strikingMass * 0.72 ** 2, strikingMass * 0.72 ** 2];
  const struckInertia = [struckMass * 0.83 ** 2, struckMass * 0.83 ** 2, struckMass * 0.17 ** 2];
  const striker = physics.addBody(null, {
    position: [-1.145, 0.064, 0],
    linearVelocity: [speed, 0, 0],
    colliders: {
      shape: 'box',
      halfExtents: [1.145, 0.06, 0.117],
      sensor: true,
      massProperties: { mass: strikingMass, centerOfMass: zero, principalInertia: strikingInertia },
    },
  });
  const receiver = physics.addBody(null, {
    position: [0.1355, 0.073, -offset],
    colliders: {
      shape: 'box',
      halfExtents: [0.1355, 0.06, 1.145],
      sensor: true,
      massProperties: { mass: struckMass, centerOfMass: zero, principalInertia: struckInertia },
    },
  });
  const channel = crushInertiaChannel('tabri-inertia');
  const supplied = publishedInertia(channel, rate, [
    {
      row: striker.row,
      dry: [strikingMass, strikingMass, strikingMass, ...strikingInertia],
      added: [
        0.05 * strikingMass,
        2.1 * strikingMass,
        0.23 * strikingMass,
        8.78 * strikingInertia[0],
        0,
        1.47 * strikingInertia[2],
      ],
    },
    {
      row: receiver.row,
      dry: [struckMass, struckMass, struckMass, ...struckInertia],
      added: [
        0.21 * struckMass,
        2.38 * struckMass,
        0.05 * struckMass,
        1.28 * struckInertia[0],
        0,
        7.08 * struckInertia[2],
      ],
    },
  ]);
  const solver = CrushSolver.withContactInertia(channel, { rate });
  const capacity = physics.kernel.capacity;
  world.add(new RigidSolver(), { physics, capacity });
  world.add(supplied, {});
  world.add(solver, {
    bodyCapacity: capacity,
    patches: [],
    envelopePatches: [
      {
        body: striker.row,
        anchor: [1.145, height - 0.064, 0],
        normal: [1, 0, 0],
        radius: 0.4,
        support: { body: receiver.row, point: [-0.1355, height - 0.073, offset] },
        material: foamEnvelope,
        friction: 0.2,
        response: 'continuous',
      },
    ],
  });
  world.couple([supplied.id, solver.id, 'rigid'], 'staggered');
  world.advance(1);
  const before = replay && world.takeSnapshot();
  const measure = () => {
    let work = 0;
    for (let frame = 2; frame <= Math.floor(hz * 0.18); frame++) {
      world.advance(frame);
      const data = solver.read(0);
      work = Math.max(work, data.absorbedEnergy + data.elasticEnergy);
    }
    const { peakForce, peakStroke } = solver.read(0);
    const momentum = strikingSurge * striker.linearVelocity[0] + struckSway * receiver.linearVelocity[0];
    near(momentum, strikingSurge * speed, 5e-5);
    assert.ok(striker.linearVelocity[0] > 0 && receiver.linearVelocity[0] > striker.linearVelocity[0]);
    return { work, force: peakForce, stroke: peakStroke, hash: world.hash() };
  };
  const result = measure();
  if (before) {
    world.restoreSnapshot(before.bytes);
    assert.deepEqual(measure(), result);
  }
  return result;
}

test('wet-contact compression predicts two separate measured model-ship trials', async (t) => {
  // Same bulb and masses as material trial 103. Only Table 3 geometry and Table 5 entry speeds are inputs.
  const withheld = [
    { id: 104, speed: 0.46, height: 0.072, offset: 0.064, stroke: 0.0213, work: 1.7, force: 147 },
    { id: 105, speed: 0.65, height: 0.07, offset: 0.023, stroke: 0.0332, work: 3.6, force: 221 },
  ];
  for (const trial of withheld) {
    const a = await runTabriTest(4, trial, false);
    const b = await runTabriTest(5, trial, true);
    for (const run of [a, b]) {
      near(run.work, trial.work, 0.1 * trial.work);
      // Half a 125 Hz movement sample at contact speed bounds the displacement localization.
      near(run.stroke, trial.stroke, (0.5 * trial.speed) / 125);
    }
    t.diagnostic(
      `Test ${trial.id}: ${a.work.toFixed(3)}/${b.work.toFixed(3)} J vs ${trial.work} J measured, ${(1000 * a.stroke).toFixed(2)}/${(1000 * b.stroke).toFixed(2)} mm vs ${(1000 * trial.stroke).toFixed(1)} mm, ${a.force.toFixed(1)}/${b.force.toFixed(1)} N vs ${trial.force} N.`,
    );
  }
});
