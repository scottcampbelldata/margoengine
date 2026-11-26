import assert from 'node:assert/strict';
import test from 'node:test';

import { ACOUSTIC_FIELD_LAYOUT, acousticBeamPressure, UnderwaterAcousticsSolver } from '../../dist/underwater.js';
import { PhysicsWorld, regionWords } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

class Listener {
  constructor(path, signal, delay) {
    this.fields = [path, signal, delay];
  }

  describe() {
    return {
      id: 'acoustics-listener',
      rate: 0,
      stableRate: () => 0,
      fields: this.fields.map((field) => ({ field, access: 'read' })),
    };
  }

  init(host) {
    this.memory = host.memory;
    this.observations = host.allocate('observations', 14 * 8, 'f64', 1);
  }

  step({ inputs }) {
    let position = 0;
    const out = regionWords(this.memory, this.observations);
    for (const field of this.fields) {
      const port = inputs.get(field.name);
      assert.ok(port);
      assert.equal(port.region.layout, ACOUSTIC_FIELD_LAYOUT);
      const data = regionWords(this.memory, port.region);
      out.set(data, position);
      position += data.length;
    }
  }

  exportPorts() {
    return [];
  }

  importPorts() {}

  stateRegions() {
    return [this.observations];
  }

  extraState() {
    return [];
  }

  read() {
    return Array.from(regionWords(this.memory, this.observations));
  }
}

function make(rate = { num: 24, den: 1 }) {
  const acoustics = new UnderwaterAcousticsSolver({ id: 'cove' });
  const listener = new Listener(acoustics.pathField, acoustics.signalField, acoustics.delayField);
  const world = new PhysicsWorld({ rate }).add(listener, {}).add(acoustics, {
    profile: [
      { depth: 0, speed: 1495 },
      { depth: 14, speed: 1480 },
      { depth: 26, speed: 1500 },
    ],
    rays: [
      { depth: 10, declination: 0.65, frequency: 1200 },
      { depth: 17, declination: -0.54, pressure: 0.7 },
    ],
    absorption: 6,
  });
  return Object.assign(world, { acoustics, listener });
}

test('UnderwaterAcousticsSolver: a registry reader receives path geometry and propagated pressure', () => {
  const world = make({ num: 60, den: 1 });
  const { acoustics, listener } = world;
  world.advance(60);
  const rays = [acoustics.sample(0), acoustics.sample(1)];
  assert.ok(rays.every((ray) => ray.reflections > 0));
  assert.deepEqual(listener.read(), [
    ...rays.flatMap((ray) => [ray.range, ray.depth, ray.pathLength, ray.width]),
    ...rays.flatMap((ray) => Object.values(acousticBeamPressure(ray, 0))),
    ...rays.map((ray) => ray.travelTime),
  ]);
  const saved = world.takeSnapshot();
  world.advance(240);
  const result = world.hash();
  world.restoreSnapshot(saved.bytes);
  assert.equal(world.hash(), saved.hash);
  world.advance(240);
  assert.equal(world.hash(), result);
});

test('UnderwaterAcousticsSolver: rays, beams and reader have a common hash at 24, 30 and 60 fps', () =>
  frameRateIndependent(make));
test('UnderwaterAcousticsSolver: a seek restores exact arrival times, pressure and integration history', () =>
  seekEqualsContinuous(make));
