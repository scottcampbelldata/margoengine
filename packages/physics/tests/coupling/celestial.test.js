import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CelestialSolver,
  INSOLATION_FIELD,
  TIDAL_POTENTIAL_FIELD,
  insolationFromPort,
  tideFromPort,
} from '../../dist/celestial.js';
import { PhysicsWorld, regionWords } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const site = { latitude: 0, longitude: 0 };
const coastalPoint = [6378137, 0, 0];

class SeaAndAtmosphere {
  describe() {
    return {
      id: 'radiation-and-tide-reader',
      fields: [
        { field: INSOLATION_FIELD, access: 'read' },
        { field: TIDAL_POTENTIAL_FIELD, access: 'read' },
      ],
      rate: 0,
      stableRate: () => 0,
      // It reads the sky at the sky's time, which runs 120 seconds a world second here.
      timeScale: () => 120,
    };
  }

  init(host) {
    this.memory = host.memory;
    this.region = host.allocate('celestialResponse', 5 * 8, 'f64', 1);
  }

  step({ inputs }) {
    const light = inputs.get(INSOLATION_FIELD.name);
    const tides = inputs.get(TIDAL_POTENTIAL_FIELD.name);
    assert.ok(light && tides, 'a coupled step receives both celestial fields');
    const insolation = insolationFromPort(this.memory, light, site);
    const tide = tideFromPort(this.memory, tides, coastalPoint);
    regionWords(this.memory, this.region).set([insolation.horizontal, tide.potential, ...tide.acceleration]);
  }

  importPorts() {}
  exportPorts() {
    return [];
  }
  extraState() {
    return [];
  }
  stateRegions() {
    return [this.region];
  }

  words() {
    return Array.from(regionWords(this.memory, this.region));
  }
}

function make(rate = { num: 24, den: 1 }) {
  const celestial = new CelestialSolver();
  const reader = new SeaAndAtmosphere();
  const world = new PhysicsWorld({ rate }).add(reader, {}).add(celestial, { timeScale: 120 });
  world.celestial = celestial;
  world.reader = reader;
  return world;
}

test('CelestialSolver: the insolation and tides received through the registry reproduce the field samples', () => {
  const world = make({ num: 60, den: 1 });
  const { celestial, reader } = world;
  world.advance(1);
  const insolation = celestial.insolation(site);
  const tide = celestial.tide(coastalPoint);
  assert.ok(insolation.horizontal > 1200);
  assert.notEqual(tide.potential, 0);
  assert.deepEqual(reader.words(), [insolation.horizontal, tide.potential, ...tide.acceleration]);
  const first = world.hash();

  const repeated = make({ num: 60, den: 1 });
  repeated.advance(1);
  assert.equal(repeated.hash(), first);
  const snapshot = world.takeSnapshot();
  world.advance(90);
  const result = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  assert.equal(world.hash(), first);
  world.advance(90);
  assert.equal(world.hash(), result);
});

test('CelestialSolver: coupled state is independent of frame rate', () => frameRateIndependent(make));
test('CelestialSolver: coupled state after seeking equals a continuous run', () => seekEqualsContinuous(make));
