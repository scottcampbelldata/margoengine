import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed } from '../../dist/earth.js';
import { IceSolver } from '../../dist/ice.js';
import { LavaSolver } from '../../dist/lava.js';
import { TsunamiSolver } from '../../dist/tsunami.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const twentyFour = { num: 24, den: 1 };
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}; bound ${tol}`);
const area = 1;
const sheet = 0.000002;
const icePoint = 273.15;
const offered = sheet * 917 * area * (333500 + 4180 * 100 + 2257000 / 2);
const contactSkin = (4 * (1443 - icePoint) * area) / (60 * offered);

async function iceWorld(fps = rate, memory, exchange = true) {
  const lava = await LavaSolver.load({ exchangeIce: exchange });
  const ice = new IceSolver({ readHeat: exchange });
  const world = new PhysicsWorld({ rate: fps, memory })
    .add(lava, {
      cells: [1, 1],
      spacing: 1,
      bed: 0,
      depth: 0.4,
      conductivity: 4,
      skinDepth: contactSkin,
      ice: exchange ? [{ cell: [0, 0], area }] : [],
    })
    .add(ice, { sites: [{ kind: 'sheet', thickness: sheet, area, temperature: icePoint }] });
  if (exchange) world.couple(['lava', 'ice-thermodynamics'], 'staggered');
  return { world, lava, ice };
}

test('LavaSolver: the ICE-05 field exchange returns absorbed heat, meltwater and steam', async () => {
  const hot = await iceWorld();
  const control = await iceWorld(rate, undefined, false);
  hot.world.advance(12);
  control.world.advance(12);
  const result = hot.lava.budget;
  assert.ok(result.iceHeat > 0);
  assert.ok(result.meltwater > 0);
  assert.ok(result.steam > 0);
  assert.ok(hot.ice.sample(0).thickness < control.ice.sample(0).thickness);
  assert.ok(hot.lava.sample(0, 0).temperature < control.lava.sample(0, 0).temperature);
  const water = sheet * 917 * area;
  near(result.meltwater + result.steam, water, 128 * Number.EPSILON * water);
  near(
    result.storedEnthalpy + result.iceHeat + result.environmentalHeat,
    result.initialEnthalpy,
    128 * Number.EPSILON * result.initialEnthalpy,
  );
});

const terrain = { columns: 16, rows: 2, width: 16, depth: 2, centre: [8, 1] };
const bed = (x) => (x < 6 ? 0.2 : -0.75);

async function shore(fps = twentyFour, memory, wet = true) {
  const lava = await LavaSolver.load({ terrain });
  const tsunami = await TsunamiSolver.load({ sources: [lava.seaSourceField] });
  const world = new PhysicsWorld({ rate: fps, memory })
    .add(new TerrainBed(), { ...terrain, elevations: bed })
    .add(lava, {
      cells: [16, 2],
      spacing: 1,
      bed: 0.2,
      seaLevel: wet ? 0 : undefined,
      vents: [{ cell: [5, 0], flow: 2.5, end: 1 }],
      viscosity: 150,
      yieldStrength: 0,
    })
    .add(tsunami, {
      cells: [16, 2],
      spacing: 1,
      bathymetry: Array.from({ length: 32 }, (_, i) => (i % 16 < 6 ? 0.2 : -0.75)),
    });
  return { world, lava, tsunami };
}

test('LavaSolver: real TerrainBed shoreline feeds signed displacement and cooling into a real SEA-06 basin', async () => {
  const { world, lava, tsunami } = await shore(rate);
  const dry = await shore(rate, undefined, false);
  world.advance(120);
  dry.world.advance(120);
  const source = lava.budget;
  const wave = tsunami.budget;
  assert.ok(lava.sample(7, 0).depth > 0);
  assert.ok(source.displacedWater > 0);
  assert.ok(source.waterHeat > 0);
  assert.equal(dry.lava.budget.waterHeat, 0);
  assert.equal(dry.tsunami.budget.admittedSourceVolume, 0);
  assert.ok(tsunami.sample(7, 0).height > 0);
  near(wave.unplacedSourceVolume, 0, 32 * 120 * Number.EPSILON * source.storedVolume);
  near(wave.admittedSourceVolume, source.displacedWater, 32 * 120 * Number.EPSILON * source.storedVolume);
  near(source.storedVolume, source.suppliedVolume, 32 * 120 * Number.EPSILON * source.suppliedVolume);
});

async function factories(rates) {
  const list = new Map();
  for (const num of rates) {
    const worlds = [];
    for (let i = 0; i < 3; i++) worlds.push((await shore({ num, den: 1 })).world);
    list.set(num, worlds);
  }
  return (choice = twentyFour) => list.get(choice.num).shift();
}

test('LavaSolver: live terrain and coastal wave fields replay across cadence, restore and memory kinds', async () => {
  frameRateIndependent(await factories([24, 30, 60]));
  seekEqualsContinuous(await factories([24]));
  const plain = await shore(rate, worldMemory({ shared: false }));
  const shared = await shore(rate, worldMemory({ shared: true }));
  plain.world.advance(48);
  shared.world.advance(48);
  assert.equal(plain.world.hash(), shared.world.hash());
});
