import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ICE_FIELD_LAYOUT,
  ICE_GEOMETRY_FIELD,
  ICE_HEAT_ABSORPTION_FIELD,
  ICE_HEAT_FIELD,
  ICE_MELTWATER_FIELD,
  ICE_STEAM_FIELD,
  ICE_TEMPERATURE_FIELD,
  ICE_VAPOUR_FIELD,
  IceSolver,
} from '../../dist/ice.js';
import { PhysicsWorld, regionWords } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const dt = 1 / 60;
const mass = 0.000917;
const fusion = 333500;
const sensible = 4180 * 100;
const vaporisation = 2257000;
const heat = mass * (fusion + sensible + vaporisation / 2);
const energy = heat / dt;
const forcing = [ICE_HEAT_FIELD, ICE_TEMPERATURE_FIELD, ICE_VAPOUR_FIELD];
const exchange = [ICE_GEOMETRY_FIELD, ICE_MELTWATER_FIELD, ICE_STEAM_FIELD, ICE_HEAT_ABSORPTION_FIELD];

// Layout-1 stand-in for lava forcing and the receiving water/steam fields.
class IceBoundary {
  constructor(invalidLayout = false) {
    this.layout = invalidLayout ? 2 : ICE_FIELD_LAYOUT;
  }

  describe() {
    return {
      id: 'ice-boundary',
      rate: 0,
      stableRate: () => 0,
      fields: [
        ...forcing.map((field) => ({ field, access: 'write' })),
        ...exchange.map((field) => ({ field, access: 'read' })),
      ],
    };
  }

  init(host) {
    this.memory = host.memory;
    this.forcing = forcing.map((field) => host.allocate(field.name, 16, 'f64', this.layout));
    this.received = host.allocate('boundary-interface', 5 * 8, 'f64', 1);
    this.words(this.forcing[1]).set([273.15, 250]);
    this.words(this.forcing[2]).set([0, 500]);
  }

  importPorts() {}

  step({ tick, inputs }) {
    const output = this.words(this.received);
    output[0] = this.words(inputs.get(ICE_GEOMETRY_FIELD.name).region)[0];
    output[1] = this.words(inputs.get(ICE_GEOMETRY_FIELD.name).region)[2];
    for (let i = 1; i < exchange.length; i++) {
      output[1 + i] = this.words(inputs.get(exchange[i].name).region)[0];
    }
    this.words(this.forcing[0])[0] = tick === 0 ? energy : 0;
  }

  exportPorts(tick) {
    return forcing.map((field, i) => ({ field: field.name, region: this.forcing[i], tick, cell: [0, 0, 0] }));
  }

  words(region) {
    return regionWords(this.memory, region);
  }

  stateRegions() {
    return [...this.forcing, this.received];
  }

  extraState() {
    return [];
  }
}

function make(rate = { num: 24, den: 1 }, invalidLayout = false) {
  const ice = new IceSolver({ readHeat: true, readTemperature: true, readVapour: true });
  const source = new IceBoundary(invalidLayout);
  const world = new PhysicsWorld({ rate })
    .add(source, {})
    .add(ice, {
      sites: [
        { kind: 'sheet', thickness: 1e-6, area: 1 },
        { kind: 'frost', temperature: 275, vapourPressure: 0 },
      ],
    })
    .couple(['ice-boundary', 'ice-thermodynamics'], 'staggered');
  world.ice = ice;
  world.source = source;
  return world;
}

const fps = { num: 60, den: 1 };

test('IceSolver: applied heat melts ice and returns mass-conserving water, steam and cooling', () => {
  const world = make(fps);
  world.advance(1);
  const sample = world.ice.sample(0);
  assert.equal(sample.thickness, 0);
  const tolerance = 8 * Number.EPSILON * mass;
  assert.ok(Math.abs(sample.meltwater * dt - mass / 2) <= tolerance);
  assert.ok(Math.abs(sample.steam * dt - mass / 2) <= tolerance);
  assert.ok(Math.abs((sample.heatAbsorbed - energy) * dt) <= 4 * Number.EPSILON * heat);
  assert.ok(world.ice.sample(1).thickness > 0, 'temperature and vapour fields supersede the static site conditions');
  world.advance(2);
  assert.deepEqual(Array.from(world.source.words(world.source.received)), [
    sample.thickness,
    world.ice.sample(1).thickness / 2,
    sample.meltwater,
    sample.steam,
    sample.heatAbsorbed,
  ]);
  assert.equal(world.ice.sample(0).steam, 0);
  assert.equal(world.ice.sample(0).meltwater, 0);
});

test('IceSolver: corrupt forcing layout fails before changing the geometry', () => {
  const world = make(fps, true);
  const first = world.ice.sample(0);
  assert.throws(() => world.advance(1), /publish layout-1 f64 values/);
  assert.deepEqual(world.ice.sample(0), first);
});

test('IceSolver: mixed sites and exchanges have the same hash at 24, 30 and 60 fps', () => frameRateIndependent(make));
test('IceSolver: mixed sites and exchanges are identical after restore and seek', () => seekEqualsContinuous(make));
