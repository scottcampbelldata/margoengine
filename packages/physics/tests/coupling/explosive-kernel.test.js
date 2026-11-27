// The explosive kernel (Rust and Wasm, FIRE-05): fragment flight gives the same bits as the TypeScript twin, on flat ground
// and on a terrain bed; fragments land on the bed's surface as BedSurface samples it; and the kernel's solver is frame-rate
// independent and seekable.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface, TerrainBed } from '../../dist/earth.js';
import { ExplosionSolver, FRAGMENT_WORDS } from '../../dist/explosive.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const shape = { columns: 32, rows: 32, width: 400, depth: 400, centre: [0, 0] };
// A hillside: up 0.2 m a metre to the east, and a ridge across the north.
const hill = (x, z) => 0.2 * x + 6 * Math.exp(-(((z - 60) / 20) ** 2));
const charges = [
  { position: [0, 30, 0], time: 0.05, mass: 20, case: { mass: 40, fragments: 400, geometry: 'sphere' } },
  { position: [50, 25, -40], time: 0.3, mass: 5, case: { mass: 8, fragments: 100 } },
];

async function make({ kernel, terrain, rate = { num: 60, den: 1 } }) {
  const options = terrain ? { terrain: shape } : {};
  const solver = kernel ? await ExplosionSolver.load(options) : new ExplosionSolver('explosion', options);
  const world = new PhysicsWorld({ rate, gravity: [0, -9.81, 0] });
  let bed = null;
  if (terrain) {
    bed = new TerrainBed();
    world.add(bed, { ...shape, elevations: hill });
  }
  world.add(solver, { charges, seed: 7 });
  return { world, solver, bed };
}

const bits = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);

for (const terrain of [false, true]) {
  test(`the kernel flies the fragments to the same bits as TypeScript (${terrain ? 'terrain bed' : 'flat ground'})`, async () => {
    const native = await make({ kernel: true, terrain }),
      twin = await make({ kernel: false, terrain });
    assert.ok(native.solver.kernel && !twin.solver.kernel);
    for (const frame of [3, 20, 60, 240, 3600]) {
      native.world.advance(frame);
      twin.world.advance(frame);
      assert.ok(bits(native.solver.fragments()).equals(bits(twin.solver.fragments())), `frame ${frame}`);
      assert.deepEqual(native.solver.counts, twin.solver.counts, `work counts at frame ${frame}`);
    }
    assert.equal(native.solver.counts.flying, 0, 'everything has landed');
    assert.ok(native.solver.counts.fragmentSteps > 500 * 30, 'the fragments were stepped');
  });
}

test('on a terrain bed every fragment lands on the bed surface that BedSurface samples, not on the flat ground', async () => {
  const { world, solver, bed } = await make({ kernel: true, terrain: true });
  world.advance(3600);
  const surface = bedSurface(shape, Float32Array.from(bed.elevations()));
  const f = solver.fragments();
  let landed = 0;
  for (let i = 0; i < f.length; i += FRAGMENT_WORDS) {
    if (f[i + 7] !== 2) continue;
    landed++;
    assert.equal(f[i + 1], surface.sample(f[i], f[i + 2]).elevation, `fragment ${i / FRAGMENT_WORDS}`);
  }
  assert.equal(landed, 500);
});

test('the kernel steps the same at 24, 30 and 60 frames a second, and a snapshot re-runs it bit for bit', async () => {
  const loaded = async (rate) => {
    const world = new PhysicsWorld({ rate, gravity: [0, -9.81, 0] });
    world.add(new TerrainBed(), { ...shape, elevations: hill });
    world.add(await ExplosionSolver.load({ terrain: shape }), { charges, seed: 7 });
    return world;
  };
  const worlds = new Map();
  for (const rate of [24, 30, 60]) worlds.set(rate, await loaded({ num: rate, den: 1 }));
  frameRateIndependent((rate) => worlds.get(rate.num), { seconds: 1 });
  const fresh = [await loaded({ num: 24, den: 1 }), await loaded({ num: 24, den: 1 })];
  seekEqualsContinuous(() => fresh.shift());
});

test('a terrain solver with no bed in the world is refused with the fix', async () => {
  const solver = await ExplosionSolver.load({ terrain: shape });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(solver, { charges });
  assert.throws(() => world.advance(1), /No solver writes field "bed"/);
});
