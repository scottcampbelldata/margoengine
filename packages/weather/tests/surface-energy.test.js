import assert from 'node:assert/strict';
import test from 'node:test';
import { PhysicsWorld } from '@margoengine/physics/world';
import { PrecipitationField } from '../dist/precipitation.js';
import { SurfaceEnergySolver } from '../dist/surface-energy.js';

// The producer reports mm/h of water equivalent. The patch output is water mass per square metre.
test('the public surface energy entry receives the Weather precipitation contract', () => {
  const field = new PrecipitationField({ rate: 3.6 });
  const surface = new SurfaceEnergySolver({ precipitation: { field, position: [1, 0, 2] } });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(surface, {
    initialWater: 0,
    airTemperature: 273.15,
    humidity: 1,
    emissivity: 0,
    groundConductance: 0,
  });
  world.advance(60);
  const state = surface.read();
  const mass = field.sample(1, 0, 2, 0).rate / 3600;
  assert.ok(state.water > 0);
  assert.ok(state.snow > 0);
  assert.ok(Math.abs(state.water + state.snow - mass) <= 8 * 60 * Number.EPSILON * mass);
});
