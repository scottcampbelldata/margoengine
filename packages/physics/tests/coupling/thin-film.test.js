import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { WakeSolver } from '../../dist/sea.js';
import {
  FILM_DROP_WORDS,
  FILM_IMPACT_WORDS,
  THIN_FILM_LAYOUT,
  THIN_FILM_WORDS,
  ThinFilmSolver,
} from '../../dist/thin-film.js';
import { BODY_FORCES_FIELD, PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const rainVelocity = [0, -7, 4];
const empty = { rate: 0, intercept: 0, slope: 0, fallSpeed: 0, impactRate: 0, energyFlux: 0, waterContent: 0 };
const storm = (velocity = rainVelocity) => ({
  cell: [0, 0, 0],
  sample(_x, _y, _z, _t, out) {
    out.rate = 36;
    Object.assign(out.rain, empty, { rate: 36, fallSpeed: 7 });
    out.velocity[0] = velocity[0];
    out.velocity[1] = velocity[1];
    out.velocity[2] = velocity[2];
    return out;
  },
});
const wind = {
  medium: 'air',
  cell: [0, 0, 0],
  sample(_x, _y, _z, _t, out) {
    out.velocity[0] = 0;
    out.velocity[1] = 0;
    out.velocity[2] = 0;
    out.density = 1.2;
    return out;
  },
};

function balance(film, steps) {
  const b = film.budget;
  const supplied = b.initial + b.rain + b.impacts;
  const found = b.evaporated + b.dripped + b.stored;
  assert.ok(Math.abs(found - supplied) <= 64 * Math.max(1, steps) * Number.EPSILON * supplied);
}

async function pane({ wind, precipitation, speed = 0, roll = 0, seeded = false }) {
  const film = await ThinFilmSolver.load({ rigid: true });
  const world = new PhysicsWorld({ rate, memory: worldMemory(false) });
  const rigid = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 60 });
  const glass = rigid.addBody(null, {
    position: [0, 0, 0],
    linearVelocity: [speed, 0, 0],
    angularVelocity: [roll, 0, 0],
    gravityScale: 0,
    colliders: { shape: 'box', halfExtents: [0.16, 0.16, 0.005], mass: 32 },
  });
  const depth = new Float64Array(64);
  if (seeded) depth[4 + 2 * 8] = 0.0003;
  world
    .add(film, {
      bodyRow: glass.row,
      cells: [8, 8],
      spacing: 0.04,
      origin: [-0.16, 0.16, 0],
      u: [1, 0, 0],
      v: [0, -1, 0],
      wind,
      precipitation,
      depth,
      surfaceTension: 0,
      drains: [false, false, false, true],
    })
    .add(new RigidSolver(), { physics: rigid });
  return { film, world, glass, rigid };
}

function centroid(film) {
  let u = 0;
  let v = 0;
  let water = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const c = film.sample(x, y);
      u += c.depth * c.u;
      v += c.depth * c.v;
      water += c.depth;
    }
  }
  return [u / water, v / water];
}

test('ThinFilmSolver: EF-4 window receives vertical rain as a real rigid hull rolls', async () => {
  await Physics.load();
  const weather = storm([0, -7, 0]);
  const stationary = await pane({ precipitation: weather });
  const rolling = await pane({ precipitation: weather, roll: 0.35 });
  stationary.world.advance(30);
  rolling.world.advance(30);
  assert.equal(stationary.film.budget.rain, 0);
  assert.ok(rolling.film.budget.rain > 0);
  assert.ok(rolling.film.depths().some((h) => h > 0));
  assert.ok(rolling.rigid.kernel.columns.rotationX[rolling.glass.row] > 0);
  balance(rolling.film, 30);
});

test('ThinFilmSolver: LAST-TRAM-8 moving pane drives a runnel across the pane and sends drips out', async () => {
  await Physics.load();
  const station = await pane({ wind, precipitation: storm(), seeded: true });
  const train = await pane({ wind, precipitation: storm(), seeded: true, speed: 30 });
  station.world.advance(30);
  train.world.advance(30);
  const still = centroid(station.film);
  const moving = centroid(train.film);
  assert.ok(moving[0] < still[0], 'relative air shear drives the runnel across the passing window');
  assert.ok(moving[1] > 0.1, 'gravity carries the wet film down the glass');
  assert.ok(train.film.budget.dripped > 0, 'liquid leaves the open window sill');
  assert.equal(
    train.film.budget.rain,
    station.film.budget.rain,
    'motion along the pane does not change its rain interception',
  );
  balance(station.film, 30);
  balance(train.film, 30);
});

const pumpField = {
  name: 'inclined-film-pump',
  kind: 'uniformGrid',
  quantity: 'rain',
  unit: 'm/s',
  centring: 'cell',
};

async function runPumpedFilm(reynolds, spacing) {
  // Wang, Jia and Duan (2020), §2 and Table 2. Discharge per width = Re × kinematic viscosity.
  const density = 1120;
  const viscosity = 0.008103;
  const discharge = (reynolds * viscosity) / density;
  const inclination = Math.PI / 9;
  const columns = Math.round(0.5 / spacing);
  let inlet;
  const pump = {
    describe: () => ({
      id: pumpField.name,
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: pumpField, access: 'write' }],
    }),
    init(host) {
      inlet = host.allocate('inlet', 8 * columns, 'f64', THIN_FILM_LAYOUT);
      regionWords(host.memory, inlet)[0] = discharge / spacing;
    },
    step() {},
    importPorts() {},
    exportPorts: (tick) => [{ field: pumpField.name, region: inlet, tick, cell: [0, 0, 0] }],
    stateRegions: () => [inlet],
    extraState: () => [],
  };
  const film = await ThinFilmSolver.load({ rainField: pumpField });
  const world = new PhysicsWorld({ rate })
    .add(film, {
      cells: [columns, 1],
      spacing,
      u: [Math.cos(inclination), -Math.sin(inclination), 0],
      v: [0, 0, -1],
      density,
      viscosity,
      surfaceTension: 0.0654,
      drains: [false, true, false, false],
    })
    .add(pump, {});
  const probe = Math.round(0.35 / spacing);
  const depth = () => (film.sample(probe - 1, 0).depth + film.sample(probe, 0).depth) * 0.5;
  world.advance(1200);
  const established = depth();
  world.advance(2400);
  balance(film, 2400);
  assert.ok(film.budget.dripped > 0);
  assert.ok(Math.abs(depth() - established) <= 256 * Number.EPSILON * depth());
  return depth();
}

test('ThinFilmSolver: film depth from a calibrated inlet matches three held-out PLIF bands', async () => {
  // Fig. 9(a–c) of https://doi.org/10.3390/coatings10060599, original 3305 × 1207 raster.
  // Re labels are independent pump inputs. The four Y pixels are the 0 and 1 mm ticks
  // and the lower and upper caps of the highest measured PIV/PLIF point. Do not read the blue theory curve.
  const observations = [
    { re: 1.6068, zero: 910, oneMillimetre: 58, lower: 557, upper: 514 },
    { re: 2.2221, zero: 907, oneMillimetre: 61, lower: 514, upper: 469 },
    { re: 2.7709, zero: 906, oneMillimetre: 58, lower: 515, upper: 468 },
  ];
  const digitizationPixels = 2;
  for (const { re, zero, oneMillimetre, lower, upper } of observations) {
    const metresPerPixel = 0.001 / (zero - oneMillimetre);
    const minimum = (zero - lower - digitizationPixels) * metresPerPixel;
    const maximum = (zero - upper + digitizationPixels) * metresPerPixel;
    for (const spacing of [0.01, 0.005]) {
      const depth = await runPumpedFilm(re, spacing);
      assert.ok(
        depth >= minimum && depth <= maximum,
        `Re ${re}, Δx ${spacing}: ${depth} m vs [${minimum}, ${maximum}]`,
      );
    }
  }
});

test('ThinFilmSolver: a circular sill converts film discharge into timed detached drops conservatively', async () => {
  // Independent experimental nozzle and pump from Zhang and Basaran (1996), Figure 1.
  const spacing = 0.03;
  const diameter = 0.0032;
  const density = 998.2;
  const surfaceTension = 0.07275;
  const flow = 1e-6 / 60;
  const film = await ThinFilmSolver.load({ drops: true });
  const world = new PhysicsWorld({ rate }).add(film, {
    cells: [1, 1],
    spacing,
    u: [1, 0, 0],
    v: [0, -1, 0],
    rainRate: flow / (spacing * spacing),
    density,
    surfaceTension,
    drains: [false, false, false, true],
    outlets: [{ edge: 'v1', index: 0, radius: diameter / 2 }],
  });
  const ideal = (Math.PI * diameter * surfaceTension) / (density * -world.gravity[1]);
  const corrected = ideal * (0.6 + 0.4 * (1 - diameter / (1.4 * Math.cbrt(ideal))) ** 2.2);
  const dt = 1 / rate.num;
  // The dry film first fills about one drop's worth of water before its discharge settles.
  const frames = 1080;
  const events = [];
  let released = 0;
  let checkpoint;
  for (let frame = 1; frame <= frames; frame++) {
    world.advance(frame);
    if (frame === 400) {
      assert.ok(film.heldDripVolume > 0);
      checkpoint = world.takeSnapshot();
    }
    const { region, cell } = world.fields.port(film.dropsField.name);
    assert.equal(region.layout, THIN_FILM_LAYOUT);
    assert.equal(region.byteLength, FILM_DROP_WORDS * 8);
    const row = regionWords(world.memory, region);
    const count = row[9];
    if (!count) continue;
    assert.equal(count, 1);
    assert.deepEqual(cell, [0, 0, 0]);
    assert.deepEqual(Array.from(row.subarray(0, 6)), [spacing / 2, -spacing, 0, 0, 0, 0]);
    assert.ok(Math.abs(row[6] - corrected) <= 64 * Number.EPSILON * corrected);
    assert.ok(row[7] >= 0 && row[7] <= dt);
    events.push((frame - 1) * dt + row[7]);
    released += row[6] * count;
  }
  assert.ok(events.length >= 4, `only ${events.length} discharged drops after ${frames * dt} s`);
  const period = corrected / flow;
  assert.ok(Math.abs(events.at(-1) - events.at(-2) - period) <= dt);
  assert.equal(film.sample(0, 0).dripRate, 0, 'outlet water has one published route');
  assert.ok(Math.abs(released + film.heldDripVolume - film.budget.dripped) <= 64 * frames * Number.EPSILON * released);
  balance(film, frames);
  const final = world.hash();
  world.restoreSnapshot(checkpoint.bytes);
  world.advance(frames);
  assert.equal(world.hash(), final);
});

test('ThinFilmSolver: detached LAST-TRAM drops inherit the moving sill pose', async () => {
  await Physics.load();
  const spacing = 0.03;
  const speed = 0.15;
  const world = new PhysicsWorld({ rate, memory: worldMemory(false) });
  const rigid = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 60 });
  const body = rigid.addBody(null, {
    position: [0.25, 0.5, -0.125],
    linearVelocity: [speed, 0, 0],
    gravityScale: 0,
    colliders: { shape: 'box', halfExtents: [0.16, 0.16, 0.005], mass: 32 },
  });
  const film = await ThinFilmSolver.load({ rigid: true, drops: true });
  world
    .add(film, {
      bodyRow: body.row,
      cells: [1, 1],
      spacing,
      v: [0, -1, 0],
      rainRate: 1e-6 / 60 / (spacing * spacing),
      drains: [false, false, false, true],
      outlets: [{ edge: 'v1', index: 0, radius: 0.0016 }],
    })
    .add(new RigidSolver(), { physics: rigid });
  for (let frame = 1; frame <= 480; frame++) {
    world.advance(frame);
    const { region } = world.fields.port(film.dropsField.name);
    const row = regionWords(world.memory, region);
    if (row[9] === 0) continue;
    const [x, y, z] = body.position;
    for (const [i, value] of [x + spacing / 2, y - spacing, z, ...body.linearVelocity].entries())
      assert.ok(Math.abs(row[i] - value) <= 64 * Number.EPSILON * Math.max(1, Math.abs(value)));
    balance(film, frame);
    return;
  }
  assert.fail('Expected the moving sill to detach a drop within eight seconds.');
});

test('ThinFilmSolver: a mounted film transmits its normal weight and moment to the rigid body', async () => {
  await Physics.load();
  const spacing = 0.1;
  const depth = 0.0002;
  const density = 998;
  const mass = 10;
  const dt = 1 / rate.num;
  for (const offset of [0, 0.1]) {
    const suspended = offset !== 0;
    const axis = suspended ? 1 : -1;
    const world = new PhysicsWorld({ rate, memory: worldMemory(false) });
    const rigid = new Physics(null, { arena: world.arena, fixedTimestep: dt });
    const body = rigid.addBody(null, {
      gravityScale: 0,
      colliders: { shape: 'box', halfExtents: [0.3, 0.04, 0.3], mass },
    });
    const film = await ThinFilmSolver.load({ rigid: true, hydrostaticLoad: true });
    world.add(new RigidSolver(), { physics: rigid }).add(film, {
      bodyRow: body.row,
      cells: [4, 3],
      spacing,
      depth,
      density,
      suspended,
      origin: [offset - 0.2, 0, -0.15 * axis],
      v: [0, 0, axis],
    });
    world.couple(['rigid', 'thin-film'], 'staggered');
    const weight = 12 * spacing * spacing * depth * density * world.gravity[1];
    world.advance(1);
    const force = film.exportPorts(1).find((port) => port.field === BODY_FORCES_FIELD.name);
    const values = regionWords(world.memory, force.region);
    const at = body.row * 6;
    for (const [i, expected] of [0, weight, 0, 0, 0, offset * weight].entries())
      assert.ok(Math.abs(values[at + i] - expected) <= 64 * Number.EPSILON * Math.abs(weight));
    if (offset === 0) {
      world.advance(4);
      const before = body.linearVelocity[1];
      world.advance(5);
      const after = body.linearVelocity[1];
      const change = after - before;
      const expected = (weight * dt) / mass;
      // The rigid integrator rounds the force factors and stores both velocities in f32 columns.
      const rounding = 2 ** -24 * (Math.abs(before) + Math.abs(after) + 4 * Math.abs(expected));
      assert.ok(Math.abs(change - expected) <= rounding, `${change} vs ${expected}`);
    }
  }
});

const input = {
  name: 'platform-impacts',
  kind: 'surfaceSampleSet',
  quantity: 'rainImpact',
  unit: 'm, m³, m/s',
  centring: 'particle',
};
const hit = { u: 0.14, v: 0.14, radius: 0.03, volume: 8e-8, speed: 6 };

class Impacts {
  describe() {
    return { id: 'atmo04-impact', rate: 0, stableRate: () => 0, fields: [{ field: input, access: 'write' }] };
  }
  init(host) {
    this.memory = host.memory;
    this.region = host.allocate('impact', 8 * FILM_IMPACT_WORDS, 'f64', THIN_FILM_LAYOUT);
  }
  importPorts() {}
  step({ tick }) {
    const out = regionWords(this.memory, this.region);
    if (tick === 2) out.set([hit.u, hit.v, hit.radius, hit.volume, hit.speed]);
    else out.fill(0);
  }
  exportPorts(tick) {
    return [{ field: input.name, region: this.region, tick, cell: [0, 0, 0] }];
  }
  stateRegions() {
    return [this.region];
  }
  extraState() {
    return [];
  }
}

async function platforms(count) {
  const loaded = await Promise.all(
    Array.from({ length: count }, () => ThinFilmSolver.load({ impacts: input, waveSources: true })),
  );
  return (rateValue = rate, memory) => {
    const film = loaded.shift();
    const wake = new WakeSolver('platform-ring', film.waveField);
    const world = new PhysicsWorld({ rate: rateValue, memory })
      .add(wake, { cells: [24, 24], cellSize: 0.025, centre: [0.16, -0.16], depth: 0.03, sponge: 0 })
      .add(film, { cells: [8, 8], spacing: 0.04, depth: 0.0004 })
      .add(new Impacts(), {});
    return Object.assign(world, { film, wake });
  };
}

test('ThinFilmSolver: LAST-TRAM-8 impact fills a wet platform and sends a physical ring to the existing WakeSolver', async () => {
  const make = await platforms(2);
  const world = make();
  const clean = make();
  clean.advance(2);
  assert.ok(clean.wake.heights().every((h) => h === 0));
  world.advance(6);
  assert.equal(world.film.budget.impacts, hit.volume);
  assert.ok(world.film.sample(3, 3).depth > 0.0004);
  balance(world.film, 6);
  const waves = world.wake.heights();
  assert.ok(waves.some((h) => h > 0));
  assert.ok(waves.some((h) => h < 0));
  const sum = waves.reduce((total, h) => total + h, 0);
  const signed = waves.reduce((total, h) => total + Math.abs(h), 0);
  assert.ok(Math.abs(sum) <= 128 * Number.EPSILON * signed);
  const [out] = world.film.exportPorts(6);
  assert.equal(out.region.byteLength, 8 * THIN_FILM_WORDS * 64);
  assert.equal(out.region.layout, THIN_FILM_LAYOUT);
});

test('ThinFilmSolver: impact coupling replays across frame rates, snapshot and plain/shared memories', async () => {
  const make = await platforms(7);
  frameRateIndependent(make);
  seekEqualsContinuous(make);
  const plainMemory = worldMemory(false);
  const sharedMemory = worldMemory(true);
  assert.ok(plainMemory.buffer instanceof ArrayBuffer);
  assert.ok(sharedMemory.buffer instanceof SharedArrayBuffer);
  const plain = make(rate, plainMemory);
  const shared = make(rate, sharedMemory);
  plain.advance(18);
  shared.advance(18);
  assert.equal(plain.hash(), shared.hash());
});
