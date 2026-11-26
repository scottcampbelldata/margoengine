import assert from 'node:assert/strict';
import test from 'node:test';
import { criticalRaftingThickness, PackIceSolver } from '../dist/pack-ice.js';
import { PhysicsWorld } from '../dist/world.js';

const density = 917;
const still = { airSkinDrag: 0, airEdgeDrag: 0, waterSkinDrag: 0, waterEdgeDrag: 0 };
const radius = 1;
const rate = { num: 60, den: 1 };
const frozen = (x, z, vx, vz, thickness = 0.1) => ({ position: [x, z], velocity: [vx, vz], radius, thickness });

async function make(floes, opts = {}, config = {}, memory) {
  const pack = await PackIceSolver.load(config);
  const world = new PhysicsWorld({ rate, memory }).add(pack, { ...still, ...opts, floes });
  return { world, pack };
}

function near(actual, target, ulps = 64) {
  const error = ulps * Number.EPSILON * Math.max(1, Math.abs(target));
  assert.ok(Math.abs(actual - target) <= error, `${actual} instead of ${target}, beyond ${error}`);
}

const mass = (sample) => density * sample.volume;
const kinetic = (sample) => (mass(sample) * (sample.velocity[0] ** 2 + sample.velocity[1] ** 2)) / 2;

test('PackIceSolver: closed-form unequal-mass restitution and equal/opposite momentum', async () => {
  const a = frozen(-1.01, 0, 3, 0, 0.1);
  const b = frozen(1.01, 0, -1, 0, 0.2);
  const e = 0.4;
  const { world, pack } = await make([a, b], { restitution: e, icebreaking: false });
  world.advance(1);
  const [first, second] = [pack.sample(0), pack.sample(1)];
  const ma = mass(first);
  const mb = mass(second);
  const initialMomentum = ma * 3 - mb;
  const relative = 4 * e;
  near(first.velocity[0], (initialMomentum - mb * relative) / (ma + mb));
  near(second.velocity[0], first.velocity[0] + relative);
  near(ma * first.velocity[0] + mb * second.velocity[0], initialMomentum);
  near(second.position[0] - first.position[0], 2 * radius);
  near((ma * 9 + mb) / 2 - kinetic(first) - kinetic(second), (((ma * mb) / (ma + mb)) * 16 * (1 - e * e)) / 2);
});

test('PackIceSolver: Coulomb friction turns sliding into spin without gaining angular momentum or energy', async () => {
  const { world, pack } = await make([frozen(-1, 0, 4, 1), frozen(1, 0, -4, -1)], {
    friction: 0.1,
    restitution: 1,
    icebreaking: false,
  });
  const initial = [pack.sample(0), pack.sample(1)];
  const initialMomentum = initial.reduce(
    (sum, f) => sum + mass(f) * (f.position[1] * f.velocity[0] - f.position[0] * f.velocity[1]),
    0,
  );
  world.advance(1);
  const final = [pack.sample(0), pack.sample(1)];
  assert.ok(final[0].spin > 0 && final[1].spin > 0);
  const energy = final.reduce((sum, f) => sum + kinetic(f) + (mass(f) * f.radius * f.radius * f.spin ** 2) / 4, 0);
  assert.ok(energy < initial.reduce((sum, f) => sum + kinetic(f), 0));
  const angular = final.reduce(
    (sum, f) =>
      sum +
      mass(f) * (f.position[1] * f.velocity[0] - f.position[0] * f.velocity[1] + (f.spin * f.radius * f.radius) / 2),
    0,
  );
  // The positional correction moves each centre at most half the penetration.
  const penetration = 2 - Math.hypot(2 - 8 / 60, 2 / 60);
  const correctionBound = final.reduce((sum, f) => sum + 0.5 * penetration * mass(f) * Math.hypot(...f.velocity), 0);
  assert.ok(Math.abs(angular - initialMomentum) <= correctionBound);
});

test('PackIceSolver: Vella equation 12 and conserved thin rafting and thick pressure-ridge material', async () => {
  const hc = criticalRaftingThickness({ youngModulus: 1e9, tensileStrength: 400_000, poissonRatio: 0.29 });
  near(hc, ((8 / 3) * Math.exp(Math.PI / 2) * (1 - 0.29 ** 2) * 400_000 ** 2) / (1025 * 9.81 * 1e9));
  assert.ok(hc >= 0.12 && hc <= 0.21, 'Vella and Wettlaufer, section 2.2 sea-ice interval');
  for (const [thickness, mode] of [
    [0.06, 'raftedVolume'],
    [0.4, 'ridgedVolume'],
  ]) {
    const { world, pack } = await make([frozen(-1.01, 0, 20, 0, thickness), frozen(1.01, 0, -20, 0, thickness)], {
      restitution: 0,
    });
    const start = pack.sample(0);
    world.advance(1);
    const after = pack.sample(0);
    assert.ok(after[mode] > 0, `${mode} has contact work`);
    assert.equal(after[mode === 'raftedVolume' ? 'ridgedVolume' : 'raftedVolume'], 0);
    assert.equal(after.volume, start.volume);
    near(Math.PI * after.radius ** 2 * after.thickness + after.raftedVolume + after.ridgedVolume, after.volume);
    assert.ok(after.equivalentThickness > after.thickness);
    const uplift = mode === 'raftedVolume' ? density : 1025 / 2;
    assert.ok(after[mode] * thickness * 9.81 * uplift <= kinetic(start) - kinetic(after));
  }
});

test('PackIceSolver: wind uses the shared origin and world clock and ocean drag follows the exact discrete recurrence', async () => {
  const wind = {
    medium: 'air',
    cell: [1, 0, -2],
    sample(x, _y, z, t, out) {
      out.velocity[0] = x + z > -3 ? 10 + t : -10;
      out.velocity[2] = 0;
      out.density = 1.23;
      return out;
    },
  };
  const current = {
    medium: 'water',
    cell: [0, 0, 0],
    sample(_x, _y, _z, _t, out) {
      out.velocity[0] = 0.6;
      out.velocity[2] = 0;
      out.density = 1025;
      return out;
    },
  };
  const h = 0.1;
  const { world, pack } = await make([frozen(1, 0, 0, 0, h)], {
    wind,
    current,
    cellSize: 16,
    airSkinDrag: 0.0017,
    waterSkinDrag: 0.0013,
  });
  world.setCell('pack-ice', [1, 0, -2]);
  let predicted = 0;
  const waterStep = (1025 * 0.0013) / (density * h * 60);
  for (let i = 0; i < 30; i++) {
    world.advance(i + 1);
    const slip = 10 + i / 60 - predicted;
    predicted = (predicted + (1.23 * 0.0017 * slip * slip) / (density * h * 60) + 0.6 * waterStep) / (1 + waterStep);
  }
  near(pack.sample(0).velocity[0], predicted, 256);
  assert.equal(pack.sample(0).velocity[1], 0);
});

test('PackIceSolver: sparse pack evaluates local neighbours and fast floes do not cross head-on', async () => {
  const remote = Array.from({ length: 96 }, (_, i) => frozen(10 * i + 30, i % 2 ? 10 : -10, 0, 0));
  const { world, pack } = await make([frozen(-4, 0, 600, 0), frozen(4, 0, -600, 0), ...remote], {
    restitution: 1,
    icebreaking: false,
  });
  world.advance(1);
  const first = pack.sample(0);
  const second = pack.sample(1);
  assert.ok(first.position[0] < second.position[0]);
  near(first.velocity[0], -600);
  near(second.velocity[0], 600);
  assert.ok(pack.work.substeps > 1);
  assert.ok(pack.work.pairs <= pack.work.substeps, 'the 96 separated disks never become pair candidates');
});
