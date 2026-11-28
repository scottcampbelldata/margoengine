import assert from 'node:assert/strict';
import test from 'node:test';
import { LavaSolver } from '../dist/lava.js';
import { PhysicsWorld } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const dt = 1 / 60;
const defaults = {
  cells: [7, 3],
  spacing: 1,
  bed: 0,
  conductivity: 0,
  emissivity: 0,
  convection: 0,
  yieldStrength: 0,
};
const near = (a, b, bound) => assert.ok(Math.abs(a - b) <= bound, `${a} vs ${b}; bound ${bound}`);

async function scene(options) {
  const lava = await LavaSolver.load();
  const world = new PhysicsWorld({ rate }).add(lava, { ...defaults, ...options });
  return { lava, world };
}

test('LavaSolver: wide-sheet Newtonian basal resistance matches the exact implicit momentum update', async () => {
  const viscosity = 480;
  const density = 2400;
  const depth = 0.75;
  const q = 0.225;
  const { lava, world } = await scene({ depth, viscosity, density, dischargeX: q });
  world.advance(1);
  const expected = q / (1 + (dt * 3 * viscosity) / (density * depth * depth));
  const middle = lava.sample(3, 1);
  near(middle.discharge[0], expected, 32 * Number.EPSILON * q);
  near(middle.depth, depth, 8 * Number.EPSILON * depth);
  assert.equal(middle.discharge[1], 0);
});

test('LavaSolver: implicit yielded sheet recovers the analytical Bingham discharge', async () => {
  const depth = 0.6;
  const density = 2500;
  const viscosity = 600;
  const yieldStrength = 225;
  const basalAcceleration = 0.4;
  const plug = yieldStrength / (density * basalAcceleration * depth);
  const want =
    (density * basalAcceleration * depth * depth * depth * (1 - plug) * (1 - plug) * (1 + plug / 2)) / (3 * viscosity);
  const before = want + dt * depth * basalAcceleration;
  const { lava, world } = await scene({ depth, viscosity, density, dischargeX: before, yieldStrength });
  world.advance(1);
  // 40 bisections of the original acceleration bracket, plus arithmetic roundoff.
  const bound = before / 2 ** 40 + 32 * Number.EPSILON * before;
  near(lava.sample(3, 1).discharge[0], want, bound);
});

test('LavaSolver: a sub-yield inclined deposit holds while lower-strength lava advances', async () => {
  const bed = Array.from({ length: 21 }, (_, i) => -0.1 * (i % 7));
  const stable = await scene({ bed, depth: 0.2, yieldStrength: 600 });
  const flowing = await scene({ bed, depth: 0.2, yieldStrength: 0 });
  stable.world.advance(60);
  flowing.world.advance(60);
  for (let x = 0; x < 7; x++) {
    const stopped = stable.lava.sample(x, 1);
    assert.deepEqual(stopped.discharge, [0, 0]);
    assert.equal(stopped.depth, 0.2);
  }
  assert.ok(flowing.lava.sample(5, 1).discharge[0] > 0);
  assert.ok(flowing.lava.sample(6, 1).depth > 0.2);
});

test('LavaSolver: basal cooling converts the exact sensible-plus-latent enthalpy to crust', async () => {
  const solidus = 1200;
  const liquidus = 1400;
  const thickness = 0.2;
  const temperature = 1300;
  const density = 2500;
  const heatCapacity = 1000;
  const latentHeat = 200000;
  const conductivity = 2.5;
  const skinDepth = 0.01;
  const groundTemperature = 300;
  const { lava, world } = await scene({
    cells: [1, 1],
    depth: thickness,
    temperature,
    solidus,
    liquidus,
    density,
    heatCapacity,
    latentHeat,
    conductivity,
    skinDepth,
    groundTemperature,
    convection: 0,
    emissivity: 0,
  });
  world.advance(1);
  const initialCrust = thickness / 2;
  const power = (conductivity * (temperature - groundTemperature)) / (skinDepth + initialCrust);
  const apparentCapacity = heatCapacity + latentHeat / (liquidus - solidus);
  const expected = temperature - (power * dt) / (density * thickness * apparentCapacity);
  const cell = lava.sample(0, 0);
  near(cell.temperature, expected, 16 * Number.EPSILON * temperature);
  near(
    cell.crustDepth,
    thickness * (1 - (expected - solidus) / (liquidus - solidus)),
    128 * Number.EPSILON * thickness,
  );
  near(lava.budget.environmentalHeat, power * dt, 100 * Number.EPSILON * power * dt);
  near(
    lava.budget.storedEnthalpy + lava.budget.environmentalHeat,
    lava.budget.initialEnthalpy,
    8 * Number.EPSILON * lava.budget.initialEnthalpy,
  );
});

test('LavaSolver: surface radiation and water film transfer remain active without conduction', async () => {
  const temperature = 1500;
  const airTemperature = 320;
  const waterTemperature = 290;
  const emissivity = 0.9;
  const convection = 14;
  const waterHeatTransfer = 180;
  const density = 2500;
  const heatCapacity = 1200;
  const thickness = 0.8;
  for (const wet of [false, true]) {
    const { lava, world } = await scene({
      cells: [1, 1],
      bed: wet ? -1 : 0,
      seaLevel: wet ? 0 : undefined,
      depth: thickness,
      temperature,
      airTemperature,
      waterTemperature,
      emissivity,
      convection,
      waterHeatTransfer,
      density,
      heatCapacity,
    });
    world.advance(1);
    const radiation = emissivity * 5.670374419e-8 * (temperature ** 4 - airTemperature ** 4);
    const waterPower = wet ? waterHeatTransfer * (temperature - waterTemperature) : 0;
    const cooling = (radiation + convection * (temperature - airTemperature) + waterPower) * dt;
    const expected = temperature - cooling / (density * heatCapacity * thickness);
    const cell = lava.sample(0, 0);
    near(cell.temperature, expected, 16 * Number.EPSILON * temperature);
    assert.equal(cell.surfaceTemperature, cell.temperature);
    near(lava.budget.environmentalHeat, cooling, 32 * Number.EPSILON * cooling);
    near(lava.budget.waterHeat, waterPower * dt, 32 * Number.EPSILON * cooling);
    near(
      lava.budget.storedEnthalpy + cooling,
      lava.budget.initialEnthalpy,
      8 * Number.EPSILON * lava.budget.initialEnthalpy,
    );
  }
});

test('LavaSolver: an insulated cold bottom cannot cool the exposed surface below the active air bath', async () => {
  const airTemperature = 400;
  const { lava, world } = await scene({
    cells: [1, 1],
    depth: 0.8,
    temperature: 1500,
    airTemperature,
    groundTemperature: 200,
    convection: 1e12,
  });
  world.advance(1);
  near(lava.sample(0, 0).temperature, airTemperature, 16 * Number.EPSILON * airTemperature);
  near(
    lava.budget.storedEnthalpy + lava.budget.environmentalHeat,
    lava.budget.initialEnthalpy,
    8 * Number.EPSILON * lava.budget.initialEnthalpy,
  );
});

test('LavaSolver: lateral conduction through stationary crust follows the conservative face stencil', async () => {
  const density = 2500;
  const cp = 1200;
  const conductivity = 5;
  const ground = 800;
  const depth = 0.5;
  const skin = 0.1;
  const dx = 0.25;
  const { lava, world } = await scene({
    cells: [2, 1],
    spacing: dx,
    depth,
    density,
    heatCapacity: cp,
    conductivity,
    temperature: [ground + 80, ground - 80],
    skinDepth: skin,
    groundTemperature: ground,
    convection: 0,
    emissivity: 0,
  });
  world.advance(1);
  const laterally = 1 - (2 * conductivity * dt) / (density * cp * dx * dx);
  const basally = 1 - (conductivity * dt) / (density * cp * depth * (skin + depth));
  near(lava.sample(0, 0).temperature, ground + laterally * basally * 80, 32 * Number.EPSILON * ground);
  near(lava.sample(1, 0).temperature, ground - laterally * basally * 80, 32 * Number.EPSILON * ground);
  near(lava.budget.storedEnthalpy, lava.budget.initialEnthalpy, 16 * Number.EPSILON * lava.budget.initialEnthalpy);
  assert.equal(lava.sample(1, 0).crustDepth, depth);
});

test('LavaSolver: a finite vent integrates the fractional start and stop intervals and retains volume', async () => {
  const start = 0.007;
  const end = 0.138;
  const flow = 9;
  const { lava, world } = await scene({ vents: [{ cell: [3, 1], start, end, flow }] });
  world.advance(60);
  const want = flow * (end - start);
  const b = lava.budget;
  near(b.suppliedVolume, want, 16 * Number.EPSILON * want);
  near(b.storedVolume, want, 16 * 60 * Number.EPSILON * want);
  near(b.storedEnthalpy, b.suppliedEnthalpy, 16 * 60 * Number.EPSILON * b.suppliedEnthalpy);
  assert.ok(lava.sample(4, 1).depth > 0);
  world.advance(120);
  assert.equal(lava.budget.suppliedVolume, b.suppliedVolume);
});

test('LavaSolver: cold margins form stationary levees around a fed channel', async () => {
  const cells = [7, 3];
  const depth = Array.from({ length: 21 }, (_, i) => (i >= 7 && i < 14 ? 0 : 1));
  const temperature = Array.from({ length: 21 }, (_, i) => (i >= 7 && i < 14 ? 1443 : 700));
  const { lava, world } = await scene({ cells, depth, temperature, vents: [{ cell: [1, 1], flow: 0.1 }] });
  world.advance(60);
  for (let x = 0; x < 7; x++) {
    assert.equal(lava.sample(x, 0).crustDepth, 1);
    assert.equal(lava.sample(x, 2).crustDepth, 1);
  }
  assert.ok(lava.sample(3, 1).depth > 0);
  assert.ok(lava.sample(3, 1).discharge[0] > 0);
});
