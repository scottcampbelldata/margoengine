// Moist convection and clouds (ATMO-03): air at rest stays at rest; condensation keeps the water and gives the latent heat;
// a warm bubble rises no faster than its buoyancy allows; a moist bubble makes its cloud where a lifted parcel saturates;
// cloud rains out and the rain reaches the ground at the Marshall-Palmer speed; clouds drift with the wind and change shape.
import assert from 'node:assert/strict';
import test from 'node:test';
import { standardAtmosphere } from '@margoengine/math/atmosphere';
import { AIR_HEAT_CAPACITY, CloudSolver, condense, LATENT_HEAT, rainSpeed, saturation } from '../dist/clouds.js';
import { PhysicsWorld } from '../dist/world.js';

/** A world with one cloud solver; each world step of 1/60 s is `interval` seconds of cloud time. */
function clouds(params, id = 'clouds') {
  const solver = new CloudSolver(id),
    interval = params.interval ?? 2,
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(solver, { timeScale: 60 * interval, ...params });
  return { solver, world, run: (steps) => world.advance(world.tick / 128 + steps) };
}

/** Sum and centroid of the cloud water. */
function cloudMass(solver) {
  const q = solver.cloudWater(),
    { cells, cellSize, origin } = solver.grid,
    [nx, ny] = cells;
  let total = 0,
    x = 0,
    y = 0,
    z = 0,
    base = Infinity;
  for (let c = 0; c < q.length; c++) {
    const i = c % nx,
      j = Math.floor(c / nx) % ny,
      k = Math.floor(c / (nx * ny));
    total += q[c];
    x += q[c] * (origin[0] + (i + 0.5) * cellSize);
    y += q[c] * (j + 0.5) * cellSize;
    z += q[c] * (origin[2] + (k + 0.5) * cellSize);
    if (q[c] > 1e-5) base = Math.min(base, j);
  }
  return { total, centre: [x / total, y / total, z / total], base };
}

test('still, unheated air stays exactly at rest', () => {
  const { solver, run } = clouds({ cells: [6, 5, 6], surfaceHeat: 0, surfaceLatent: 0 });
  run(20);
  for (const y of [100, 500, 900])
    for (const x of [-300, 0, 300]) {
      const s = solver.sample(x, y, 100);
      assert.deepEqual(s.velocity, [0, 0, 0]);
      assert.equal(s.cloudWater, 0);
    }
  assert.equal(solver.time, 40);
});

test('condensation keeps the water, gives its latent heat and leaves the air just saturated', () => {
  const p = 85000,
    t = 285,
    qv = 1.3 * saturation(t, p),
    after = condense(t, p, qv, 0);
  assert.ok(Math.abs(after.vapour + after.cloud - qv) <= 1e-15 * qv, 'the water is kept');
  assert.ok(after.cloud > 0);
  assert.ok(Math.abs(after.temperature - t - (LATENT_HEAT / AIR_HEAT_CAPACITY) * after.cloud) < 1e-9);
  assert.ok(Math.abs(after.vapour / saturation(after.temperature, p) - 1) < 1e-6, 'just saturated');
  // Cloud in dry air evaporates, all of it when there is little.
  const dry = condense(t, p, 0.5 * saturation(t, p), 1e-4);
  assert.equal(dry.cloud, 0);
  assert.ok(dry.temperature < t);
});

test('a warm bubble rises, no faster than its buoyancy could push it', () => {
  const warming = 2,
    { solver, run } = clouds({
      cells: [12, 12, 12],
      cellSize: 100,
      surfaceHeat: 0,
      surfaceLatent: 0,
      humidity: 0.2,
      humidityTop: 0.2,
      vorticity: 0,
      bubbles: [{ centre: [0, 400, 0], radius: 300, warming }],
    });
  run(10);
  const centre = solver.sample(0, 400, 0),
    side = solver.sample(500, 400, 0),
    [t0] = standardAtmosphere(400, 298.15),
    // Free acceleration g theta'/theta over 20 s bounds the speed.
    bound = ((9.81 * warming) / t0) * 20;
  assert.ok(
    centre.velocity[1] > 0.1 && centre.velocity[1] < bound,
    `rising at ${centre.velocity[1]} m/s, bound ${bound}`,
  );
  assert.ok(side.velocity[1] < 0, 'and air sinks around it');
});

test("a moist bubble makes its cloud between its own condensation level and the air's (RITS-8's condensing ascent)", () => {
  // Air lifted with its theta and vapour kept saturates at its lifting condensation level. The bubble mixes with the
  // drier air around it on the way up, so its cloud forms between the bubble's level and the environment's, and from mostly
  // bubble air: in the lower third of that range.
  const { solver, run } = clouds({
      cells: [24, 24, 24],
      cellSize: 100,
      surfaceHeat: 0,
      surfaceLatent: 0,
      humidity: 0.7,
      humidityTop: 0.3,
      vorticity: 0,
      bubbles: [{ centre: [0, 600, 0], radius: 600, warming: 3, humidity: 1 }],
    }),
    lcl = (air, y0) => {
      const [, p0] = standardAtmosphere(y0, 298.15),
        theta = air.temperature / (p0 / 100000) ** 0.286;
      for (let y = y0; y < 4000; y++) {
        const [, p] = standardAtmosphere(y, 298.15);
        if (air.vapour >= saturation(theta * (p / 100000) ** 0.286, p)) return y;
      }
      return Infinity;
    },
    bubble = lcl(solver.sample(50, 650, 50), 650),
    environment = lcl(solver.sample(2350, 650, 2350), 650);
  let base;
  for (let s = 0; s < 200 && base === undefined; s++) {
    run(1);
    const q = solver.cloudWater();
    for (let c = 0; c < q.length; c++)
      if (q[c] > 0) base = Math.min(base ?? Infinity, ((Math.floor(c / 24) % 24) + 0.5) * 100);
  }
  assert.ok(base !== undefined, 'a cloud formed');
  assert.ok(
    base >= bubble - 100 && base <= bubble + (environment - bubble) / 3 + 100,
    `cloud base ${base} m; bubble ${bubble} m, air ${environment} m`,
  );
});

test('rain falls at the mass-weighted speed of a Marshall-Palmer rain', () => {
  // Numerically: N0 = 8e6 per m^4, the slope from the rain water, v = 130 D^(1/2).
  for (const rho of [1e-4, 1e-3, 5e-3]) {
    const slope = ((Math.PI * 1000 * 8e6) / rho) ** 0.25;
    let mass = 0,
      flux = 0;
    for (let i = 0; i < 200000; i++) {
      const d = ((i + 0.5) * 40) / slope / 200000,
        m = (1000 * Math.PI * d ** 3) / 6,
        n = 8e6 * Math.exp(-slope * d);
      mass += m * n;
      flux += m * n * 130 * Math.sqrt(d);
    }
    assert.ok(Math.abs(rainSpeed(rho) / (flux / mass) - 1) < 1e-6, `${rainSpeed(rho)} against ${flux / mass}`);
  }
});

test('a deep moist cloud rains, and the rain reaches the ground under it (CF-1, RITS-9)', () => {
  const { solver, run } = clouds({
    cells: [12, 24, 12],
    cellSize: 150,
    surfaceHeat: 0,
    surfaceLatent: 0,
    humidity: 0.85,
    humidityTop: 0.6,
    bubbles: [{ centre: [0, 600, 0], radius: 700, warming: 4, humidity: 1.05 }],
  });
  let rained = 0;
  for (let s = 0; s < 80 && rained === 0; s++) {
    run(10);
    rained = solver.rainRate(0, 0);
  }
  assert.ok(rained > 0, 'rain reached the ground');
  // As a source for the precipitation field.
  const source = solver.rainSource();
  assert.ok(source.peak >= rained && source.rate(0, 0, 0) === rained);
});

test('clouds drift with the wind and change shape as they go (OO-4, TREE-4)', () => {
  const wind = {
      medium: 'air',
      cell: [0, 0, 0],
      sample(_x, _y, _z, _t, out = { velocity: [0, 0, 0], density: 1.2, temperature: 290 }) {
        out.velocity[0] = 8;
        out.velocity[1] = 0;
        out.velocity[2] = 0;
        return out;
      },
    },
    { solver, run } = clouds({
      cells: [24, 16, 12],
      cellSize: 100,
      surfaceHeat: 0,
      surfaceLatent: 0,
      // Air near saturation, so the cloud lives long enough to be followed.
      humidity: 0.95,
      humidityTop: 0.9,
      wind,
      bubbles: [{ centre: [-600, 400, 0], radius: 350, warming: 3, humidity: 1.15 }],
    });
  run(10);
  const first = cloudMass(solver),
    shape = solver.cloudWater();
  run(30);
  const later = cloudMass(solver),
    // 30 steps of 2 s at 8 m/s.
    drift = later.centre[0] - first.centre[0];
  assert.ok(drift > 0.7 * 480 && drift < 1.3 * 480, `drifted ${drift} m against 480`);
  const now = solver.cloudWater();
  let same = 0;
  for (let c = 0; c < now.length; c++) same += Math.abs(now[c] - shape[c]);
  assert.ok(same > 0.1 * first.total, 'its shape changed');
});

test("the clouds' own flow can be added to a wind", () => {
  const { solver, run } = clouds({
      cells: [10, 10, 10],
      cellSize: 100,
      surfaceHeat: 0,
      surfaceLatent: 0,
      bubbles: [{ centre: [0, 300, 0], radius: 300, warming: 3 }],
    }),
    still = {
      medium: 'air',
      cell: [0, 0, 0],
      sample: (_x, _y, _z, _t, out = { velocity: [0, 0, 0], density: 1.2, temperature: 290 }) => out,
    };
  run(5);
  const gust = solver.windWith(still).sample(0, 300, 0, 0);
  assert.ok(gust.velocity[1] > 0 && gust.velocity[1] === solver.sample(0, 300, 0).velocity[1]);
  assert.deepEqual(
    solver.windWith(still).sample(5000, 300, 0, 0).velocity,
    [0, 0, 0],
    'outside the box the base wind alone',
  );
});

test('the same clouds from the same start, bit for bit', () => {
  const make = () =>
      clouds({
        cells: [8, 8, 8],
        cellSize: 120,
        bubbles: [{ centre: [0, 300, 0], radius: 300, warming: 2, humidity: 1 }],
      }),
    a = make(),
    b = make();
  a.run(15);
  b.run(15);
  assert.equal(a.world.hash(), b.world.hash());
  assert.deepEqual(a.solver.cloudWater(), b.solver.cloudWater());
});

test('settings out of range are refused with what to pass', () => {
  const world = () => new PhysicsWorld({ rate: { num: 60, den: 1 } });
  assert.throws(() => world().add(new CloudSolver(), { cells: [1, 4, 4] }), /2 to 512/);
  assert.throws(() => world().add(new CloudSolver(), { humidity: 2 }), /\[0, 1\]/);
  assert.throws(
    () => world().add(new CloudSolver(), { bubbles: [{ centre: [0, 0], radius: 1, warming: 1 }] }),
    /finite centre/,
  );
});
