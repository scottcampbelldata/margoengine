import assert from 'node:assert/strict';
import test from 'node:test';

import { IceSolver, iceFreezingTemperature, iceVapourPressure } from '../dist/ice.js';
import { PhysicsWorld } from '../dist/world.js';

const density = 917;
const fusion = 333500;
const freezing = 273.15;

function make(sites) {
  const ice = new IceSolver();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(ice, { sites });
  return { world, ice };
}

function close(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);
}

test('bare and snow-covered ice follow the closed form of the Stefan problem', () => {
  const start = 0.02;
  const snow = 0.04;
  const conductivity = 2.03;
  const insulation = (snow * conductivity) / 0.31;
  const temperature = 253.15;
  const { world, ice } = make([
    { kind: 'sheet', temperature },
    { kind: 'sheet', temperature, thickness: start, snowThickness: snow },
    { kind: 'sheet', temperature: 293.15, thickness: start, snowThickness: snow },
    { kind: 'sheet', temperature: 293.15, thickness: 1e-8 },
  ]);
  const seconds = 10;
  world.advance(seconds * 60);
  const drive = (2 * conductivity * (freezing - temperature) * seconds) / (density * fusion);
  // Each recurrence adds one square root and a few rounded arithmetic operations. Use their summed f64 error.
  const tolerance = 8 * seconds * 60 * Number.EPSILON * (insulation + start);
  close(ice.sample(0).thickness, Math.sqrt(drive), tolerance);
  close(
    ice.sample(1).thickness,
    Math.sqrt((start + insulation) * (start + insulation) + drive) - insulation,
    tolerance,
  );
  close(
    ice.sample(2).thickness,
    Math.sqrt((start + insulation) * (start + insulation) - drive) - insulation,
    tolerance,
  );
  assert.equal(ice.sample(3).thickness, 0);
  assert.equal(ice.sample(3).meltwater, 0, 'meltwater flux clears after the last ice drains');
});

test('UNESCO freezing-point depression separates fresh and sea ice', () => {
  assert.equal(iceFreezingTemperature(), freezing);
  // UNESCO 1983, table at p=0 and S=35, tabulated to three decimal places in Celsius.
  close(iceFreezingTemperature(35), freezing - 1.922, 0.0005);
  const { world, ice } = make([
    { kind: 'sheet', temperature: 272.15 },
    { kind: 'sheet', temperature: 272.15, salinity: 35 },
    { kind: 'sheet', temperature: freezing, thickness: 0.1, area: 2, waterHeatFlux: 1000 },
  ]);
  world.advance(60);
  assert.ok(ice.sample(0).thickness > 0);
  assert.equal(ice.sample(1).thickness, 0);
  close(ice.sample(2).meltwater * fusion, 2000, 2 * 2000 * Number.EPSILON);
});

test('frost deposits and sublimes according to the vapour-density difference', () => {
  const temperature = 250;
  const saturation = 76.02389003659836;
  close(iceVapourPressure(temperature), saturation, 16 * Number.EPSILON * saturation);
  const pressureOffset = 10;
  const common = { kind: 'frost', temperature, airTemperature: temperature, massTransfer: 0.01, density: 100 };
  const { world, ice } = make([
    { ...common, vapourPressure: saturation + pressureOffset },
    { ...common, thickness: 0.005, vapourPressure: saturation - pressureOffset },
    { ...common, thickness: 1e-9, vapourPressure: saturation - pressureOffset },
    { ...common, thickness: 0.005, temperature: 274.15, heatTransfer: 100 },
  ]);
  world.advance(60);
  const change = (pressureOffset * common.massTransfer) / (461.5 * temperature * common.density);
  const tolerance = 16 * 60 * Number.EPSILON * 0.005;
  close(ice.sample(0).thickness, change, tolerance);
  close(ice.sample(1).thickness, 0.005 - change, tolerance);
  assert.equal(ice.sample(2).thickness, 0);
  assert.equal(ice.sample(2).meltwater, 0, 'sublimation does not drain liquid');
  close(ice.sample(3).meltwater, 100 / fusion, (4 * 100 * Number.EPSILON) / fusion);
});

test('side and tip ice conserve the supplied water; thaw changes both dimensions', () => {
  const area = (r) => Math.PI * r * r;
  const dt = 1 / 60;
  const options = { kind: 'icicle', radius: 0.005, length: 0.1, temperature: 263.15, waterSupply: 0.01 };
  const halfSideCapacity = (2 * Math.PI * options.radius * options.length * 10 * 10) / (2 * fusion);
  const { world, ice } = make([
    options,
    { ...options, waterSupply: halfSideCapacity },
    { ...options, temperature: 283.15, waterSupply: 0 },
  ]);
  const initial = density * area(options.radius) * options.length;
  world.advance(1);
  for (const i of [0, 1, 2]) {
    const { length, thickness, meltwater } = ice.sample(i);
    const water = i === 2 ? 0 : i === 1 ? halfSideCapacity : options.waterSupply;
    close(density * area(thickness) * length + meltwater * dt, initial + water * dt, 16 * initial * Number.EPSILON);
  }
  assert.ok(ice.sample(0).thickness > options.radius && ice.sample(0).length > options.length);
  assert.equal(ice.sample(1).meltwater, 0);
  assert.equal(ice.sample(1).length, options.length, 'the upstream film consumes the limited feed before the tip');
  assert.ok(ice.sample(2).thickness < options.radius && ice.sample(2).length < options.length);
});

test('invalid initial ice geometry and thermodynamic ranges identify a repair', () => {
  assert.throws(() => make([]), /pass a list/);
  assert.throws(() => make([{ kind: 'sheet', conductivity: 0 }]), /pass a finite value greater than 0/);
  assert.throws(() => make([{ kind: 'frost', temperature: 100 }]), /pass a temperature/);
  assert.throws(() => iceFreezingTemperature(50), /use a practical salinity/);
  const { ice } = make([{ kind: 'sheet' }]);
  assert.throws(() => ice.sample(-1), /pass an integer/);
});
