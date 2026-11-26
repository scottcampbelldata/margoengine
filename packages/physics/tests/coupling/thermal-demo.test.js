import assert from 'node:assert/strict';
import test from 'node:test';
import { lavaGlow } from '../../../weather/dist/lava.js';
import { HeatConduction } from '../../dist/thermal.js';
import { PhysicsWorld, regionWords } from '../../dist/world.js';

const rate = { num: 24, den: 1 };

function temperatures(world, heat) {
  const port = world.fields.port(heat.temperatureField.name);
  assert.ok(port, 'heat published its temperature at the world tick');
  return regionWords(world.memory, port.region).slice();
}

test('THE-KILN-SHIFT-5: exposed ceramic loses heat and visible emission before its insulated edge', async () => {
  const heat = await HeatConduction.load();
  const world = new PhysicsWorld({ rate });
  const emissivity = 0.9;
  world.add(heat, {
    dimensions: [8, 1, 1],
    cellSize: [0.01, 0.1, 0.1],
    materials: { conductivity: 1.8, heatCapacity: 1600000 },
    initialTemperature: 1350,
    boundaries: { xMin: { kind: 'radiation', kelvin: 293.15, emissivity } },
    integration: 'implicit',
  });
  // Report photopic radiance in cd/m² before a display transfer, at fixed camera exposure.
  // A grey emissivity multiplies the Planck/CIE spectrum at every visible wavelength.
  const emission = () => Array.from(temperatures(world, heat), (kelvin) => emissivity * lavaGlow(kelvin)[3]);
  const initial = emission();
  assert.ok(initial[0] > 0);
  assert.equal(initial[0], initial.at(-1));
  world.advance(24 * 60);
  const firstMinute = emission();
  assert.ok(firstMinute[0] < firstMinute[1], 'the cold exposed edge glows less than the inner cell');
  assert.ok(firstMinute[1] < firstMinute.at(-1), 'the wall has a visible emission gradient');
  assert.ok(firstMinute[0] < initial[0], 'the glowing exposed face fades as it cools');
  world.advance(24 * 120);
  const secondMinute = emission();
  assert.ok(secondMinute[0] < firstMinute[0], 'the face continues to cool');
  assert.ok(secondMinute[1] < firstMinute[1], 'cooling and loss of glow travel into the wall');
});

test('INSIDE-A-TURBOFAN-4: prescribed heat increases gas volume in a fixed-pressure flow stand-in', async () => {
  const heat = await HeatConduction.load();
  const world = new PhysicsWorld({ rate });
  const inletKelvin = 600;
  const airMass = 0.3;
  const fuelToAir = 0.02;
  const mass = airMass * (1 + fuelToAir);
  const cp = 1005;
  const heatValue = 42000000;
  const efficiency = 0.95;
  const addedHeat = airMass * fuelToAir * heatValue * efficiency;
  world.add(heat, {
    dimensions: [1, 1, 1],
    materials: { conductivity: 0, heatCapacity: mass * cp },
    initialTemperature: (airMass * cp * inletKelvin) / (mass * cp),
    boundaries: { xMin: { kind: 'flux', wattsPerSquareMetre: addedHeat } },
  });
  world.advance(24);
  const [outletKelvin] = temperatures(world, heat);
  // NASA Glenn burner energy balance, using constant cp and a slow-flow approximation T ≈ Tt.
  const expected = (cp * inletKelvin + fuelToAir * efficiency * heatValue) / (cp * (1 + fuelToAir));
  const roundoff = 128 * Number.EPSILON;
  assert.ok(Math.abs(outletKelvin / expected - 1) < roundoff);
  const pressure = 101325;
  const gasConstant = 287.05;
  const inletDensity = pressure / (gasConstant * inletKelvin);
  const outletDensity = pressure / (gasConstant * outletKelvin);
  const volumeRatio = mass / outletDensity / (airMass / inletDensity);
  assert.ok(outletDensity < inletDensity);
  assert.ok(volumeRatio > 1);
  const expectedRatio = 1 + (fuelToAir * efficiency * heatValue) / (cp * inletKelvin);
  assert.ok(Math.abs(volumeRatio / expectedRatio - 1) < roundoff);
});
