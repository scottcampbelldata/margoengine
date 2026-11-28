// The surge's coupling checks (SEA-07): `SurgeSolver` forcing a `ShallowWaterSolver` with a moving low and the world's tide,
// held to the harness: the same surge at 24, 30 and 60 frames a second, and a seek equal to a continuous run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { ShallowWaterSolver } from '../../dist/hydro.js';
import { CelestialSolver, TIDAL_POTENTIAL_FIELD } from '../../dist/celestial.js';
import { SurgeSolver } from '../../dist/surge.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const nx = 12,
  nz = 4,
  shape = { columns: nx, rows: nz, width: 12000, depth: 4000, centre: [6000, 2000] },
  elevations = new Float64Array((nx + 1) * (nz + 1)).fill(-30);
const bed = bedSurface(shape, elevations);

const make = (rate = { num: 24, den: 1 }) => {
  const water = new ShallowWaterSolver();
  return (
    new PhysicsWorld({ rate })
      .add(new CelestialSolver(), { timeScale: 3600 })
      // The water and the sky on one clock, an hour a world second (the world refuses them apart).
      .add(water, { bed, level: 0, coriolis: { latitude: 0.8 }, timeScale: 3600 })
      .add(new SurgeSolver('surge', { tide: true }), {
        water,
        site: { latitude: 0.8, longitude: -1.5 },
        // A low crossing at 20 m/s of the water's time.
        pressure: (x, z, t) => 101325 - 2000 * Math.exp(-((x - 20 * t) ** 2 + (z - 2000) ** 2) / 1e7),
      })
      .couple(['surge', 'water'], 'staggered')
  );
};

test('SurgeSolver: the same surge at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('SurgeSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));

test('a late bad pressure preserves accepted parts, potential and water until a corrected exact replay', () => {
  const water = new ShallowWaterSolver(),
    surge = new SurgeSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  let fail = false,
    calls = 0;
  world
    .add(water, { bed, level: 0 })
    .add(surge, {
      water,
      pressure(x, z, time) {
        calls++;
        return fail && x > 10_000 ? NaN : 101325 - 2000 * Math.exp(-((x - 1500 * time) ** 2 + z * z) / 1e7);
      },
    })
    .setCell('surge', [-3, 1, 2])
    .setCell('water', [-3, 1, 2])
    .couple(['surge', 'water'], 'staggered');
  world.advance(3);
  const baseline = world.takeSnapshot();
  const accepted = () =>
    [...surge.extraState(), ...water.stateRegions()].map((r) =>
      new Uint8Array(world.memory.buffer, r.byteOffset, r.byteLength).slice(),
    );
  const before = accepted(),
    at = surge.potentialAt(500, 500);
  assert.notEqual(at, 0);
  calls = 0;
  fail = true;
  assert.throws(
    () => world.advance(4),
    (error) =>
      error.code === 'unsupported' && /return Pa/.test(error.message) && error.message.includes('errors#storm-surge'),
  );
  assert.ok(calls > 1);
  assert.deepEqual(accepted(), before);
  assert.equal(surge.potentialAt(500, 500), at);
  fail = false;
  world.advance(4);
  const reached = world.takeSnapshot();
  assert.notDeepEqual(accepted(), before);
  world.restoreSnapshot(baseline.bytes);
  world.advance(4);
  assert.deepEqual(world.takeSnapshot(), reached);
});

test('a malformed celestial port cannot overwrite an accepted Earth-fixed surge', () => {
  const water = new ShallowWaterSolver(),
    surge = new SurgeSolver('surge', { tide: true }),
    world = new PhysicsWorld();
  world
    .add(new CelestialSolver())
    .add(water, { bed, level: 0 })
    .add(surge, { water, site: { latitude: 0.9, longitude: -1.3 } })
    .couple(['surge', 'water'], 'staggered');
  world.advance(2);
  const before = world.takeSnapshot();
  const field = TIDAL_POTENTIAL_FIELD.name,
    port = world.fields.port(field);
  const broken = { ...port, region: { ...port.region, byteLength: 40 } };
  assert.throws(
    () => surge.step({ tick: 3, level: 0, seed: 0, cell: [0, 0, 0], inputs: new Map([[field, broken]]) }, 1 / 60),
    (error) => error.code === 'version' && error.message.includes('matching CelestialSolver'),
  );
  assert.deepEqual(world.takeSnapshot(), before);
  assert.throws(
    () => surge.potentialAt(NaN, 0),
    (error) => error.code === 'unsupported' && error.message.includes('errors#storm-surge'),
  );
});
