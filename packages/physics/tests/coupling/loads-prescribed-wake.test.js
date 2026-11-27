import assert from 'node:assert/strict';
import test from 'node:test';
import { RealFft2 } from '@margoengine/math/fft';
import { loadKernel, Physics } from '@margoengine/physics';
import { PrescribedWakeWork, QuayWakeBoundary } from '@margoengine/physics/loads';
import { SpectralSea, WakeSolver } from '@margoengine/physics/sea';
import { HullSolver } from '@margoengine/physics/seakeeping';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '@margoengine/physics/world';

const gravity = 9.81;
const dt = 1 / 60;
const density = 1024;
const mass = 1024;
const depth = 3;
const cellSize = 0.25;
const cells = [48, 32];
const centre = [0, 0];
const [nx, nz] = cells;
const half = nx / 2 + 1;

const mesh = {
  vertices: Float64Array.of(
    -1,
    -0.5,
    -0.5,
    1,
    -0.5,
    -0.5,
    1,
    0.5,
    -0.5,
    -1,
    0.5,
    -0.5,
    -1,
    -0.5,
    0.5,
    1,
    -0.5,
    0.5,
    1,
    0.5,
    0.5,
    -1,
    0.5,
    0.5,
  ),
  indices: Uint32Array.of(
    0,
    2,
    1,
    0,
    3,
    2,
    4,
    5,
    6,
    4,
    6,
    7,
    0,
    1,
    5,
    0,
    5,
    4,
    3,
    7,
    6,
    3,
    6,
    2,
    0,
    4,
    7,
    0,
    7,
    3,
    1,
    2,
    6,
    1,
    6,
    5,
  ),
};

// Integrate the actual modal energy of the receiving wake, independently of the source kick.
function waveEnergy(world, wake, measure) {
  const fft = new RealFft2(nx, nz);
  const [height, potential] = wake.stateRegions();
  const eta = regionWords(world.memory, height);
  const phi = fft.forward(regionWords(world.memory, potential));
  let pe = 0;
  let ke = 0;
  for (const h of eta) pe += h * h;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < half; i++) {
      const k = ((2 * Math.PI) / cellSize) * Math.hypot(i / nx, (j < nz / 2 ? j : j - nz) / nz);
      const index = 2 * (i + j * half);
      const weight = i === 0 || i === nx / 2 ? 1 : 2;
      ke += weight * k * Math.tanh(depth * k) * (phi[index] ** 2 + phi[index + 1] ** 2);
    }
  }
  return measure * 0.5 * density * cellSize * cellSize * (gravity * pe + ke / (nx * nz));
}

for (const mirrored of [false, true]) {
  test(
    'powered hull wave work closes against the live energy in the ' + (mirrored ? 'wet half of the quay' : 'open tank'),
    async (t) => {
      await loadKernel({ threads: mirrored });
      const world = new PhysicsWorld({ memory: worldMemory(mirrored), gravity: [0, -gravity, 0] });
      const physics = new Physics(null, { arena: world.arena, fixedTimestep: dt, gravity: [0, -gravity, 0] });
      try {
        const body = physics.addBody(null, {
          position: [-2, 0, mirrored ? 1.7 : 0],
          linearVelocity: [1.25, 0, 0],
          enabledTranslations: [true, false, false],
          enabledRotations: [false, false, false],
          colliders: { shape: 'box', halfExtents: [1, 0.5, 0.5], mass },
        });
        const hull = new HullSolver('hull', { minimumRadius: 0.35, submergedAdvance: [0, 0.25, 0.5] });
        const quay = mirrored ? new QuayWakeBoundary({ wallZ: 0, submerged: hull.submergedWakeSource }) : null;
        const source = quay?.submergedSource ?? hull.submergedWakeSource;
        const meter = new PrescribedWakeWork({ grid: { cells, cellSize, depth, density, centre }, source, mirrored });
        const wake = new WakeSolver('wake', undefined, source);
        const sea = new SpectralSea({
          waves: {
            frequencies: Float64Array.of(0.5),
            directions: Float64Array.of(0),
            energy: Float64Array.of(0),
            depth,
            density,
          },
        });
        world.add(new RigidSolver(), { physics }).add(hull, {
          sea,
          hulls: [{ row: body.row, mesh }],
          addedMass: false,
          drag: false,
          radiation: false,
          rollDamping: false,
          diffraction: false,
          drift: false,
          greenWater: false,
          slamming: false,
        });
        if (quay) world.add(quay, undefined);
        const initial = (x, z) => [
          0.021 * Math.sin((2 * Math.PI * x) / (nx * cellSize)) * Math.cos((2 * Math.PI * z) / (nz * cellSize)),
          0.005 * Math.cos((2 * Math.PI * x) / (nx * cellSize)),
        ];
        world.add(meter, undefined);
        world.add(wake, meter.wakeParams({ sponge: 0, initial }));
        world.couple(['hull', ...(quay ? ['quayWake'] : []), 'prescribedWakeWork', 'wake', 'rigid'], 'staggered');
        const snapshot = world.takeSnapshot();
        const measure = mirrored ? 0.5 : 1;
        const start = waveEnergy(world, wake, measure);
        let maximumError = 0;
        let cumulativeScale = start;
        for (let tick = 1; tick <= 60; tick++) {
          world.advance(tick);
          const energy = waveEnergy(world, wake, measure);
          cumulativeScale += energy;
          maximumError = Math.max(maximumError, Math.abs(energy - start - meter.work().total));
        }
        // The limit covers f64 arithmetic in the energy, transforms, and retained sum at each tick.
        const roundoff = 256 * Number.EPSILON * cumulativeScale;
        assert.ok(meter.work().total > 100);
        assert.ok(maximumError <= roundoff, JSON.stringify({ maximumError, roundoff }));
        assert.equal(body.linearVelocity[0], 1.25);
        if (mirrored) assert.ok(Math.abs(wake.sample(-0.5, 0).velocity[2]) < 1e-12);
        const last = meter.work();
        const rowPort = (quay ?? hull).exportPorts(60).find((port) => port.field === source.field.name);
        const staleHeight = wake.exportPorts(60)[0];
        assert.throws(
          () =>
            meter.step({
              level: 0,
              seed: 0,
              tick: 60,
              cell: [0, 0, 0],
              inputs: new Map([
                [rowPort.field, rowPort],
                [staleHeight.field, staleHeight],
              ]),
            }),
          { code: 'unsupported', message: /in that order.+#hydrodynamic-loads/ },
        );
        assert.deepEqual(meter.work(), last);
        const hash = world.hash();
        t.diagnostic(JSON.stringify({ mirrored, joules: last.total, maximumError, roundoff, hash }));
        world.restoreSnapshot(snapshot.bytes);
        assert.deepEqual(meter.work(), { step: 0, total: 0 });
        world.advance(60);
        assert.deepEqual(meter.work(), last);
        assert.equal(world.hash(), hash);
      } finally {
        physics[Symbol.dispose]();
      }
    },
  );
}

test('prescribed wake work rejects a grid without supported transform dimensions', () => {
  const hull = new HullSolver('hull', { minimumRadius: 0.35, submergedAdvance: [0, 0.5] });
  assert.throws(
    () =>
      new PrescribedWakeWork({
        grid: { cells: [14, 14], cellSize, centre, depth, density },
        source: hull.submergedWakeSource,
      }),
    { code: 'unsupported', message: /bounded even-X wake grid.+#hydrodynamic-loads/ },
  );
});
