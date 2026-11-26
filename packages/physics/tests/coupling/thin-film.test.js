import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { hostMath } from '../../../../scripts/check-pinned-math.mjs';
import { Physics } from '../../dist/index.js';
import { WAKE_SOURCE_WORDS, WakeSolver } from '../../dist/sea.js';
import {
  FILM_DROP_WORDS,
  FILM_IMPACT_WORDS,
  THIN_FILM_LAYOUT,
  THIN_FILM_WORDS,
  ThinFilmDropFlight,
  ThinFilmSolver,
} from '../../dist/thin-film.js';
import { BODY_FORCES_FIELD, PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };

test('Thin-film state helpers use pinned arithmetic', () => {
  const directory = new URL('../../src/thin-film/', import.meta.url);
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.ts'))) {
    const source = readFileSync(new URL(name, directory), 'utf8');
    assert.deepEqual(hostMath(source), [], name);
  }
});

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
  const flight = new ThinFilmDropFlight(film.dropsField);
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
    .add(new RigidSolver(), { physics: rigid })
    .add(flight, { airDensity: 0, flightTime: 0.35 });
  for (let frame = 1; frame <= 480; frame++) {
    world.advance(frame);
    const { region } = world.fields.port(film.dropsField.name);
    const row = regionWords(world.memory, region);
    if (row[9] === 0) continue;
    const [x, y, z] = body.position;
    for (const [i, value] of [x + spacing / 2, y - spacing, z, ...body.linearVelocity].entries())
      assert.ok(Math.abs(row[i] - value) <= 64 * Number.EPSILON * Math.max(1, Math.abs(value)));
    const drop = flight.readDrops()[0];
    const dt = 1 / rate.num;
    const age = dt - row[7];
    const g = world.gravity[1];
    assert.equal(flight.readDrops().length, 1);
    assert.equal(drop.age, age);
    assert.equal(drop.volume, row[6]);
    assert.equal(flight.budget.received, row[6]);
    for (const [i, value] of [row[0], row[1] + 0.5 * g * age * age, row[2]].entries())
      assert.ok(Math.abs(drop.position[i] - value) < 64 * Number.EPSILON);
    assert.ok(Math.abs(drop.velocity[1] - g * age) < 64 * Number.EPSILON);
    const checkpoint = world.takeSnapshot();
    world.advance(frame + 30);
    assert.equal(flight.readDrops().length, 0);
    assert.deepEqual(flight.budget, { received: drop.volume, airborne: 0, outflow: drop.volume });
    const final = world.hash();
    world.restoreSnapshot(checkpoint.bytes);
    world.advance(frame + 30);
    assert.equal(world.hash(), final);
    balance(film, frame);
    return;
  }
  assert.fail('Expected the moving sill to detach a drop within eight seconds.');
});

function dropEvents(count, makeRecords) {
  const field = {
    name: 'test-drops',
    kind: 'surfaceSampleSet',
    quantity: 'detachedWaterDrop',
    unit: 'SI',
    centring: 'particle',
  };
  let region;
  let memory;
  const producer = {
    describe: () => ({ id: 'drop-source', rate: 0, stableRate: () => 0, fields: [{ field, access: 'write' }] }),
    init(host) {
      region = host.allocate('test-drops', 8 * FILM_DROP_WORDS * count, 'f64', THIN_FILM_LAYOUT);
      memory = host.memory;
    },
    step(context, dt) {
      const rows = regionWords(memory, region);
      rows.fill(0);
      if (context.tick === 0) rows.set(makeRecords(dt).flat());
    },
    importPorts() {},
    exportPorts: (tick) => [{ field: field.name, region, tick, cell: [0, 0, 0] }],
    stateRegions: () => [region],
    extraState: () => [],
  };
  return { field, producer };
}

test('ThinFilmDropFlight: the transient fall matches independent drop-tower measurements', () => {
  // Hinkle et al. (1987), Tables 1 and 2. Neither measurement column sets the force law.
  const observations = [
    { diameter: 0.00267, optical: [4.04, 6.22, 7.24], rings: [4.11, 6.26, 7.25] },
    { diameter: 0.00383, optical: [4.17, 6.64, 7.98], rings: [4.21, 6.67, 7.88] },
    { diameter: 0.00452, optical: [4.22, 6.85, 8.13], rings: [4.23, 6.82, 8.14] },
    { diameter: 0.00564, optical: [4.28, 6.91, 8.43], rings: [4.24, 6.91, 8.41] },
  ];
  const { field, producer } = dropEvents(observations.length, (dt) =>
    observations.map(({ diameter }, i) => [i, 0, 0, 0, 0, 0, (Math.PI / 6) * diameter ** 3, 0, dt, 1]),
  );
  const temperature = 293.15;
  const flight = new ThinFilmDropFlight(field);
  const world = new PhysicsWorld({ rate }).add(producer, {}).add(flight, {
    airTemperature: temperature,
    airDensity: 84100 / (287.05 * temperature),
  });
  const heights = [1, 3, 5];
  const hits = new Array(observations.length).fill(0);
  let previous = observations.map(() => ({ position: [0, 0, 0], velocity: [0, 0, 0] }));
  for (let frame = 1; frame <= 120; frame++) {
    world.advance(frame);
    const current = flight.readDrops();
    assert.equal(current.length, observations.length);
    for (const [i, drop] of current.entries()) {
      const index = hits[i];
      const height = heights[index];
      if (-drop.position[1] < height || index === heights.length) continue;
      const { optical, rings } = observations[i];
      const before = previous[i];
      const fraction = (height + before.position[1]) / (before.position[1] - drop.position[1]);
      const speed = -(before.velocity[1] + fraction * (drop.velocity[1] - before.velocity[1]));
      // Include both instruments and the paper's stated two-percent transient uncertainty.
      const minimum = 0.98 * (Math.min(optical[index], rings[index]) - 0.005);
      const maximum = 1.02 * (Math.max(optical[index], rings[index]) + 0.005);
      assert.ok(
        speed >= minimum && speed <= maximum,
        `drop ${i + 1} at ${height} m: ${speed} vs [${minimum}, ${maximum}]`,
      );
      hits[i]++;
    }
    previous = current;
    if (hits.every((count) => count === heights.length)) break;
  }
  assert.deepEqual(
    hits,
    observations.map(() => heights.length),
  );
  assert.equal(flight.budget.received, flight.budget.airborne);
});

test('ThinFilmDropFlight: a turning drop can hit a bounded plane between positive endpoint distances', () => {
  const radius = 0.001;
  const gap = 0.00001;
  const initial = -0.1;
  const upward = 100;
  const volume = (4 * Math.PI * radius ** 3) / 3;
  const { field, producer } = dropEvents(2, (dt) =>
    [0.04, 0.2].map((x) => [x, radius + gap + initial * dt, -0.04, 0, initial, 0, volume, 0, dt, 1]),
  );
  const flight = new ThinFilmDropFlight(field);
  const world = new PhysicsWorld({ rate, gravity: [0, upward, 0] })
    .add(producer, {})
    .add(flight, { airDensity: 0, receiver: { origin: [0, 0, 0], size: [0.1, 0.1] } });
  world.advance(1);
  assert.equal(flight.depositedVolume, volume);
  assert.equal(flight.budget.airborne, volume);
  const [outside] = flight.readDrops();
  assert.ok(outside.position[1] > radius + gap);
  assert.equal(outside.id, 2);
  const hit = regionWords(world.memory, world.fields.port(flight.impactField.name).region);
  const inward = Math.sqrt(initial * initial - 2 * upward * gap);
  assert.ok(Math.abs(hit[4] - inward) <= 128 * Number.EPSILON);
});

test('ThinFilmDropFlight: a sill drop transfers volume and normal impulse to a receiving film and wake', async () => {
  const spacing = 0.03;
  const lipHeight = 0.04;
  const wetDepth = 0.0002;
  const corner = [-0.04, 0, 0.05];
  const sill = await ThinFilmSolver.load({ id: 'dripping-sill', drops: true });
  const flight = new ThinFilmDropFlight(sill.dropsField);
  const receiver = await ThinFilmSolver.load({ id: 'receiving-tray', impacts: flight.impactField, waveSources: true });
  const wake = new WakeSolver('receiver-wake', receiver.waveField);
  const world = new PhysicsWorld({ rate });
  world
    .add(sill, {
      cells: [1, 1],
      spacing,
      origin: [0, lipHeight + spacing, 0],
      v: [0, -1, 0],
      rainRate: 1e-6 / 60 / (spacing * spacing),
      drains: [false, false, false, true],
      outlets: [{ edge: 'v1', index: 0, radius: 0.0016 }],
    })
    .add(flight, { airDensity: 0, receiver: { origin: [corner[0], wetDepth, corner[2]], size: [0.12, 0.12] } })
    .add(receiver, { cells: [6, 6], spacing: 0.02, origin: corner, depth: wetDepth })
    .add(wake, { cells: [16, 16], cellSize: 0.01, centre: [0.02, -0.01], depth: 0.025, sponge: 0 });
  const dt = 1 / rate.num;
  let checkpoint;
  for (let frame = 1; frame <= 480; frame++) {
    world.advance(frame);
    if (!checkpoint && flight.readDrops().length > 0) checkpoint = world.takeSnapshot();
    if (flight.depositedVolume === 0) continue;
    const volume = flight.depositedVolume;
    assert.equal(flight.budget.received, volume);
    assert.equal(flight.budget.outflow, volume);
    assert.equal(flight.budget.airborne, 0);
    assert.equal(receiver.budget.impacts, volume);
    const row = regionWords(world.memory, world.fields.port(flight.impactField.name).region);
    const radius = Math.cbrt((3 * volume) / (4 * Math.PI));
    const velocity = Math.sqrt(2 * -world.gravity[1] * (lipHeight - wetDepth - radius));
    const expected = [spacing / 2 - corner[0], corner[2], radius, volume, velocity];
    for (const [i, value] of expected.entries())
      assert.ok(Math.abs(row[i] - value) <= 128 * Number.EPSILON * Math.max(1, value), `${row[i]} vs ${value}`);
    const waves = regionWords(world.memory, world.fields.port(receiver.waveField.name).region);
    const cosineArea = Math.PI * (0.5 - 2 / Math.PI ** 2);
    let impulse = 0;
    for (let i = 0; i < waves.length; i += WAKE_SOURCE_WORDS)
      impulse += waves[i + 2] ** 2 * waves[i + 3] * cosineArea * dt;
    assert.ok(Math.abs(impulse - 998 * volume * velocity) <= 256 * Number.EPSILON * 998 * volume);
    balance(receiver, frame);
    world.advance(frame + 8);
    assert.equal(receiver.budget.impacts, volume);
    assert.ok(wake.heights().some((height) => height > 0));
    const hash = world.hash();
    world.restoreSnapshot(checkpoint.bytes);
    world.advance(frame + 8);
    assert.equal(world.hash(), hash);
    return;
  }
  assert.fail('Expected a drop to reach the wet tray within eight seconds.');
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

test('ThinFilmSolver: an absorbed off-centre impact delivers one rigid impulse and torque', async () => {
  await Physics.load();
  const dt = 1 / rate.num;
  const gravity = [0, 0, 0];
  const mass = 10;
  const density = 998;
  const halfExtents = [0.3, 0.04, 0.3];
  const angle = Math.PI / 6;
  const sine = Math.sin(angle);
  const cosine = Math.cos(angle);
  const world = new PhysicsWorld({ rate, gravity, memory: worldMemory(false) });
  const rigid = new Physics(null, { arena: world.arena, fixedTimestep: dt, gravity });
  const body = rigid.addBody(null, { colliders: { shape: 'box', halfExtents, mass } });
  const film = await ThinFilmSolver.load({ rigid: true, impactRecoil: true, impacts: input });
  world
    .add(new RigidSolver(), { physics: rigid })
    .add(film, { bodyRow: body.row, cells: [6, 6], spacing: 0.04, u: [cosine, sine, 0], density })
    .add(new Impacts(), {});
  world.couple(['rigid', 'thin-film'], 'staggered');
  world.advance(2);
  const checkpoint = world.takeSnapshot();
  world.advance(3);
  assert.equal(film.budget.impacts, hit.volume);
  const impulse = density * hit.volume * hit.speed;
  const fx = (impulse * sine) / dt;
  const fy = (-impulse * cosine) / dt;
  const tz = (-hit.u * impulse) / dt;
  const expectedForce = [fx, fy, 0, hit.v * fy, -hit.v * fx, tz];
  const { region } = film.exportPorts(2).find((port) => port.field === BODY_FORCES_FIELD.name);
  const row = regionWords(world.memory, region).subarray(6 * body.row, 6 * (body.row + 1));
  for (const [i, expected] of expectedForce.entries())
    assert.ok(Math.abs(row[i] - expected) <= 128 * Number.EPSILON * (impulse / dt));

  world.advance(4);
  const inertia = (mass * (halfExtents[0] ** 2 + halfExtents[1] ** 2)) / 3;
  for (const [actual, expected] of [
    [body.linearVelocity[0], (fx * dt) / mass],
    [body.linearVelocity[1], (fy * dt) / mass],
    [body.angularVelocity[2], (tz * dt) / inertia],
  ]) {
    // Rigid mass, inverse inertia, force and velocity pass through f32 fields.
    assert.ok(Math.abs(actual - expected) <= 16 * 2 ** -24 * Math.abs(expected), `${actual} vs ${expected}`);
  }
  const velocity = [...body.linearVelocity];
  world.advance(8);
  assert.deepEqual(body.linearVelocity, velocity);
  assert.equal(film.budget.impacts, hit.volume);
  const hash = world.hash();
  world.restoreSnapshot(checkpoint.bytes);
  world.advance(8);
  assert.equal(world.hash(), hash);
});

test('ThinFilmSolver: one impact pulse has one momentum receiver', async () => {
  await assert.rejects(
    () => ThinFilmSolver.load({ rigid: true, impactRecoil: true, impacts: input, waveSources: true }),
    {
      code: 'PHYSICS_INPUT_RANGE',
      message: /omit waveSources/,
    },
  );
});

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
