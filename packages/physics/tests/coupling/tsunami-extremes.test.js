import assert from 'node:assert/strict';
import test from 'node:test';
import { TsunamiSolver } from '../../dist/tsunami.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const rate = { num: 60, den: 1 };
const cell = { cells: [1, 1], spacing: 1, bathymetry: -1 };

async function basin(options = cell, gravity, memory) {
  const tsunami = await TsunamiSolver.load();
  const world = new PhysicsWorld({ rate, gravity, memory }).add(tsunami, options);
  return { world, tsunami };
}

test('TsunamiSolver: a finite extreme Coriolis rate takes the Cayley half-turn limit', async () => {
  for (const shared of [false, true]) {
    const moving = { ...cell, dischargeX: 0.15, dischargeZ: -0.08 };
    const still = await basin(moving, undefined, worldMemory(shared));
    const rotating = await basin({ ...moving, coriolis: Number.MAX_VALUE }, undefined, worldMemory(shared));
    still.world.advance(1);
    rotating.world.advance(1);
    const control = still.tsunami.sample(0, 0);
    const result = rotating.tsunami.sample(0, 0);
    assert.equal(rotating.tsunami.budget.substeps, 1);
    assert.notEqual(control.discharge[0], 0);
    assert.notEqual(control.discharge[1], 0);
    assert.equal(result.depth, control.depth);
    assert.deepEqual(
      result.discharge,
      control.discharge.map((component) => -component),
    );
  }
});

const sourceField = {
  name: 'large-tsunami-source',
  kind: 'bodySet',
  quantity: 'seaSource',
  unit: 'SI',
  centring: 'particle',
};

class LargeSource {
  describe() {
    return {
      id: 'large-tsunami-source-publisher',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: sourceField, access: 'write' }],
    };
  }
  init(host) {
    this.region = host.allocate('sources', 5 * Float64Array.BYTES_PER_ELEMENT, 'f64', 1);
    this.memory = host.memory;
  }
  importPorts() {}
  step() {
    regionWords(this.memory, this.region).set([5e149, 5e149, 1e150, 0, 1e308]);
  }
  exportPorts(tick) {
    return [{ field: sourceField.name, region: this.region, tick, cell: [0, 0, 0] }];
  }
  stateRegions() {
    return [this.region];
  }
  extraState() {
    return [];
  }
}

test('TsunamiSolver: overflowing final water volume aborts before changing the accepted state', async () => {
  const tsunami = await TsunamiSolver.load({ sources: [sourceField] });
  const world = new PhysicsWorld({ rate })
    .add(tsunami, { ...cell, spacing: 1e150, bathymetry: -1e8 })
    .add(new LargeSource(), {});
  const sample = tsunami.sample(0, 0);
  const budget = tsunami.budget;
  assert.equal(budget.initialVolume, 1e308);
  assert.throws(() => world.advance(1), {
    name: 'MargoError',
    code: 'state',
    message: /numeric.*Use compatible/,
  });
  assert.equal(world.tick, 0);
  assert.deepEqual(tsunami.sample(0, 0), sample);
  assert.deepEqual(tsunami.budget, budget);
});

test('TsunamiSolver: a requested tick over the CFL work budget is refused without advancing it', async () => {
  const regular = await basin(cell, [0, -625, 0]);
  regular.world.advance(1);
  assert.equal(regular.tsunami.budget.substeps, 4);

  const excessive = await basin(cell, [0, -1e10, 0]);
  const sample = excessive.tsunami.sample(0, 0);
  const budget = excessive.tsunami.budget;
  assert.throws(() => excessive.world.advance(1), {
    name: 'MargoError',
    code: 'state',
    message: /CFL.*Use/,
  });
  assert.equal(excessive.world.tick, 0);
  assert.deepEqual(excessive.tsunami.sample(0, 0), sample);
  assert.deepEqual(excessive.tsunami.budget, budget);
});

test('TsunamiSolver: extreme eikonal scales retain finite one- and two-neighbour arrivals', async () => {
  for (const { gravity, spacing, depth, speed } of [
    { gravity: 1e-308, spacing: 1, depth: 1, speed: 1e-154 },
    { gravity: 1e308, spacing: 1e-20, depth: 1, speed: 1e154 },
    { gravity: 1e308, spacing: 1, depth: 4, speed: 2e154 },
  ]) {
    const { tsunami } = await basin({ cells: [2, 2], spacing, bathymetry: -depth }, [0, -gravity, 0]);
    const axis = spacing / speed;
    const diagonal = axis * (1 + Math.SQRT1_2);
    // The positive root of Zhao (2005), §2: two equal upwind arrivals.
    const times = tsunami.travelTimes([0, 0]);
    assert.equal(times[0], 0);
    assert.ok(Math.abs(times[1] - axis) <= 4 * Number.EPSILON * axis);
    assert.equal(times[2], times[1]);
    assert.ok(Math.abs(times[3] - diagonal) <= 4 * Number.EPSILON * diagonal);
  }
});

test('TsunamiSolver: unrepresentable connected travel time fails without overwriting caller output', async () => {
  const { tsunami } = await basin({ cells: [2, 1], spacing: 1e154, bathymetry: -0.5 }, [0, -Number.MIN_VALUE, 0]);
  const out = Float64Array.of(31, 47);
  assert.throws(() => tsunami.travelTimes([0, 0], out), {
    name: 'MargoError',
    code: 'state',
    message: /travel.*Use/,
  });
  assert.deepEqual(out, Float64Array.of(31, 47));

  const isolated = await basin({ cells: [3, 1], spacing: 1, bathymetry: [-0.5, 1, -0.5] });
  assert.deepEqual(isolated.tsunami.travelTimes([0, 0]), Float64Array.of(0, Infinity, Infinity));
});

test('TsunamiSolver: twelve seconds of two-dimensional wetting and drying keeps finite state, mass and exact replay', async () => {
  const nx = 26;
  const nz = 18;
  const spacing = 0.2;
  // Retain water mass in films below the 0.1 mm velocity cutoff.
  const dryDepth = 1e-4;
  const bathymetry = Array.from({ length: nx * nz }, (_, i) => {
    const x = ((i % nx) + 0.5) * spacing - 2.6;
    const z = (Math.floor(i / nx) + 0.5) * spacing - 1.8;
    return -0.45 + 0.18 * x * x + 0.25 * z * z;
  });
  const surface = bathymetry.map((_, i) => {
    const x = ((i % nx) + 0.5) * spacing - 1.55;
    const z = (Math.floor(i / nx) + 0.5) * spacing - 1.7;
    return 0.22 * Math.max(0, 1 - x * x - z * z) ** 2;
  });
  const { world, tsunami } = await basin({ cells: [nx, nz], spacing, bathymetry, surface, dryDepth, manning: 0.018 });
  const priorWet = bathymetry.map((bed, i) => surface[i] - bed > dryDepth);
  const initialVolume = tsunami.budget.initialVolume;
  const g = -world.gravity[1];
  const mechanicalEnergy = (bed, h, qx, qz) =>
    0.5 * g * (h - Math.max(0, -bed)) ** 2 + g * Math.max(0, bed) * h + (h > 0 ? (0.5 * (qx * qx + qz * qz)) / h : 0);
  const initialEnergy = bathymetry.reduce(
    (sum, bed, i) => sum + mechanicalEnergy(bed, Math.max(0, surface[i] - bed), 0, 0),
    0,
  );
  // The uniform area and density multiply both energies and cancel.
  // Allow roundoff in the per-cell arithmetic and both n-term reductions.
  const energyRoundoff = 16 * nx * nz * Number.EPSILON * initialEnergy;
  const start = world.takeSnapshot();
  let wettings = 0;
  let dryings = 0;
  let steps = 0;
  for (let frame = 1; frame <= 720; frame++) {
    world.advance(frame);
    const { storedVolume, substeps } = tsunami.budget;
    steps += substeps;
    assert.ok(Math.abs(storedVolume - initialVolume) <= (nx * nz + 16 * steps) * Number.EPSILON * initialVolume);
    let energy = 0;
    for (let i = 0; i < bathymetry.length; i++) {
      const { depth, discharge } = tsunami.sample(i % nx, Math.floor(i / nx));
      assert.ok(Number.isFinite(depth) && depth >= 0 && discharge.every(Number.isFinite));
      energy += mechanicalEnergy(bathymetry[i], depth, discharge[0], discharge[1]);
      const wet = depth > dryDepth;
      if (bathymetry[i] >= 0) {
        if (wet && !priorWet[i]) wettings++;
        if (!wet && priorWet[i]) dryings++;
      }
      priorWet[i] = wet;
    }
    assert.ok(energy <= initialEnergy + energyRoundoff);
  }
  assert.ok(wettings > 0 && dryings > 0, `${wettings} wettings, ${dryings} dryings`);
  const hash = world.hash();
  world.restoreSnapshot(start.bytes);
  world.advance(720);
  assert.equal(world.hash(), hash);
});
