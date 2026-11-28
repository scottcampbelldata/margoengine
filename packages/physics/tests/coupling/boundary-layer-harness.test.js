// The boundary layer's coupling checks (ATMO-01): `BoundaryLayerSolver` held to the harness, the same wind field at 24, 30
// and 60 frames a second and a seek equal to a continuous run, with gusts on over a rough ground in stable air.
import test from 'node:test';
import { BoundaryLayerWind } from '@margoengine/weather/boundary-layer';
import { BoundaryLayerSolver } from '../../dist/boundary-layer.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

// The harness builds its worlds synchronously, and a solver loads its Wasm with a promise: each world takes one loaded first.
async function makers(count, profile) {
  const solvers = await Promise.all(Array.from({ length: count }, () => BoundaryLayerSolver.load()));
  return {
    make: (rate = { num: 24, den: 1 }) =>
      new PhysicsWorld({ rate, gravity: [0, 0, 0], memory: worldMemory(false) }).add(solvers.pop(), {
        profile,
        grid: { cells: [3, 3, 2], origin: [0, 0, 0], spacing: [2, 10, 3] },
      }),
    dispose: () => solvers.splice(0).forEach((solver) => solver[Symbol.dispose]()),
  };
}

for (const turbulence of [false, true]) {
  const profile = new BoundaryLayerWind({ speed: 12, roughness: 0.03, turbulence, obukhovLength: 60 }).profile;
  const label = turbulence ? 'with gusts' : 'mean wind';
  test(`BoundaryLayerSolver, ${label}: the same wind at 24, 30 and 60 frames a second`, async () => {
    const { make, dispose } = await makers(3, profile);
    try {
      frameRateIndependent(make);
    } finally {
      dispose();
    }
  });
  test(`BoundaryLayerSolver, ${label}: a seek equals a continuous run`, async () => {
    const { make, dispose } = await makers(2, profile);
    try {
      seekEqualsContinuous(() => make());
    } finally {
      dispose();
    }
  });
}
