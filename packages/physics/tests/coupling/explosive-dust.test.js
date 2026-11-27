// The explosive source's crater dust into the airborne particles (FIRE-05 into ATMO-06): a share of each linked charge's
// crater mass, emitted into an airborne source over the ejecta's flight time, arrives in the airborne solver's budget whole,
// at any frame rate.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AirborneParticles } from '../../dist/airborne.js';
import { bedSurface } from '../../dist/earth.js';
import { ExplosionSolver } from '../../dist/explosive.js';
import { PhysicsWorld } from '../../dist/world.js';

const shape = { columns: 3, rows: 3, width: 3, depth: 3, centre: [0, 0] };
const wind = {
  medium: 'air',
  cell: [0, 0, 0],
  sample(_x, _y, _z, _time, out) {
    out.velocity[0] = 3;
    out.velocity[1] = 0;
    out.velocity[2] = 0;
    return out;
  },
};
const source = { kind: 'mineral-dust', diameter: 20e-6, mass: 0.05, position: [0, 2, 0], rate: 0 };

async function make(rate) {
  const airborne = await AirborneParticles.load({ emissions: true });
  const blast = new ExplosionSolver('blast', { dust: airborne.emissionField });
  const world = new PhysicsWorld({ rate, gravity: [0, -9.81, 0] })
    .add(blast, {
      charges: [{ position: [0, -0.5, 0], time: 0.1, mass: 2, depth: 0.5 }],
      dust: { sources: 1, links: [{ charge: 0, source: 0 }], fraction: 0.01 },
    })
    .add(airborne, { capacity: 4096, wind, terrain: bedSurface(shape, new Float64Array(16)), sources: [source] });
  return { world, blast, airborne };
}

test("a charge's crater dust reaches the airborne particles whole, over the ejecta's flight time, at any frame rate", async () => {
  for (const fps of [24, 60]) {
    const { world, blast, airborne } = await make({ num: fps, den: 1 });
    world.advance(Math.round(0.08 * fps));
    assert.equal(airborne.budget.supplied, 0, 'nothing before the charge goes off');
    world.advance(fps * 3);
    const crater = blast.charge(0);
    assert.ok(crater.craterRadius > 0);
    const expected = (0.01 * (Math.PI * 1800 * crater.craterRadius ** 2 * 0.24 * crater.craterRadius)) / 2;
    const supplied = airborne.budget.supplied;
    assert.ok(
      Math.abs(supplied - expected) < 1e-9 * expected + 1e-12,
      `${fps} fps: ${supplied} kg against ${expected} kg`,
    );
  }
});

test('dust needs the airborne field and sensible links, and says so', async () => {
  const airborne = await AirborneParticles.load({ emissions: true });
  const world = () => new PhysicsWorld({ rate: { num: 60, den: 1 } });
  const charges = [{ position: [0, -0.5, 0], mass: 2, depth: 0.5 }];
  assert.throws(
    () => world().add(new ExplosionSolver('a'), { charges, dust: { sources: 1, links: [], fraction: 0.1 } }),
    /emissionField/,
  );
  assert.throws(
    () =>
      world().add(new ExplosionSolver('b', { dust: airborne.emissionField }), {
        charges,
        dust: { sources: 1, links: [{ charge: 0, source: 3 }], fraction: 0.1 },
      }),
    /source must be/,
  );
  assert.throws(
    () =>
      world().add(new ExplosionSolver('c', { dust: airborne.emissionField }), {
        charges,
        dust: { sources: 1, links: [], fraction: 2 },
      }),
    /fraction/,
  );
});
