// The surf's coupling checks (SEA-05): `SurfSolver` driving a `ShallowWaterSolver`, held to the harness: the same surf beat,
// set-up and run-up at 24, 30 and 60 frames a second, and a seek equal to a continuous run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { ShallowWaterSolver } from '../../dist/hydro.js';
import { SurfSolver } from '../../dist/surf.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const nx = 30,
  nz = 2,
  shape = { columns: nx, rows: nz, width: 60, depth: 8, centre: [30, 4] },
  elevations = new Float64Array((nx + 1) * (nz + 1));
for (let c = 0; c <= nx; c++) for (let r = 0; r <= nz; r++) elevations[r + (nz + 1) * c] = -1.2 + 0.03 * 2 * c;
const bed = bedSurface(shape, elevations);

const make = (rate = { num: 24, den: 1 }) => {
  const water = new ShallowWaterSolver();
  return new PhysicsWorld({ rate })
    .add(water, { bed, level: 0, sides: { minX: { sea: 0 }, minZ: 'periodic', maxZ: 'periodic' } })
    .add(new SurfSolver(), {
      water,
      incident: { height: 0.4, period: 6, direction: 0.3 },
      alongshore: 'periodic',
      directions: 12,
    })
    .couple(['surf', 'water'], 'staggered');
};

test('SurfSolver: the same surf at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('SurfSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));

test('surf rejection preserves the last accepted energy, forcing and shore marks and permits exact replay', () => {
  const water = new ShallowWaterSolver(),
    surf = new SurfSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, seed: 17 });
  world
    .add(water, { bed, level: 0, sides: { minX: { sea: 0 }, minZ: 'periodic', maxZ: 'periodic' } })
    .add(surf, { water, incident: { height: 0.4, period: 6 }, alongshore: 'periodic', directions: 9 })
    .couple(['surf', 'water'], 'staggered');

  world.setCell('water', [-3, 1, -2]);
  world.setCell('surf', [-3, 1, -2]);
  world.advance(12);
  const at = [1, 4];
  assert.ok(surf.waveHeight(...at) > 0);
  const baseline = world.takeSnapshot();
  const acceptedHeight = surf.waveHeight(...at);
  const readWords = () =>
    [...surf.stateRegions(), ...surf.exportPorts(0).map((p) => p.region)].map((r) =>
      new Uint8Array(world.memory.buffer, r.byteOffset, r.byteLength).slice(),
    );
  const before = readWords(),
    old = water.sample.bind(water);
  let flooded = 0;
  water.sample = (x, z, out) => {
    const waterAt = old(x, z, out);
    if (x > 55 && waterAt.depth === 0) {
      flooded++;
      return { ...waterAt, depth: Number.NaN };
    }
    return waterAt;
  };
  assert.throws(
    () => world.advance(13),
    (e) => e.code === 'unsupported' && e.message.includes('errors#nearshore-surf'),
  );
  assert.ok(flooded > 0);
  assert.deepEqual(readWords(), before);
  water.sample = old;

  world.restoreSnapshot(baseline.bytes);
  world.advance(21);
  const reached = world.takeSnapshot();
  assert.notEqual(surf.waveHeight(...at), acceptedHeight);
  world.restoreSnapshot(baseline.bytes);
  assert.equal(surf.waveHeight(...at), acceptedHeight);
  world.advance(21);
  assert.deepEqual(world.takeSnapshot(), reached);
});

test('surf samples a signed-origin incident spectrum and rejects invalid bins with a fix', () => {
  const world = new PhysicsWorld(),
    water = new ShallowWaterSolver();
  world.add(water, { bed, level: 0 });
  let sampleAt;
  const waveField = {
    cell: [-2, 0, 3],
    sample(x, z) {
      sampleAt = [x, z];
      return {
        frequencies: Float64Array.of(0.1, 0.2),
        directions: Float64Array.of(0, Math.PI),
        energy: Float64Array.of(0.1, 0, 0.2, 0),
        depth: 1,
        density: 1025,
      };
    },
  };
  world.add(new SurfSolver(), { water, incident: { waves: waveField }, originCellSize: 64 });
  assert.deepEqual(sampleAt, [128, -188]);
  const invalid = { ...waveField, sample: () => ({ ...waveField.sample(0, 0), energy: Float64Array.of(-1) }) };
  assert.throws(
    () => {
      const badWater = new ShallowWaterSolver();
      new PhysicsWorld().add(badWater, { bed, level: 0 }).add(new SurfSolver(), {
        water: badWater,
        incident: { waves: invalid },
      });
    },
    (e) => e.code === 'unsupported' && e.message.includes('errors#nearshore-surf'),
  );
});
