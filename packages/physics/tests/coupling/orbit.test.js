import assert from 'node:assert/strict';
import test from 'node:test';

import { keplerDiskSample, ORBIT_FIELD_LAYOUT, OrbitSolver } from '../../dist/orbit.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const bodies = [
  { position: [0, 0, 0], mass: 1 },
  { position: [4, 0, 0], velocity: [0, 0.5, 0] },
  { position: [5, 1, 0], velocity: [0, 0.42, 0.05], mass: 0.05 },
];
const emitter = { gravitationalParameter: 1, radius: 4, radialVelocity: -0.001 };

class OrbitalObserver {
  constructor(orbit) {
    this.fields = [orbit.positionField, orbit.velocityField, orbit.timeField];
  }
  describe() {
    return {
      id: 'orbit-observer',
      rate: 0,
      stableRate: () => 0,
      fields: this.fields.map((field) => ({ field, access: 'read' })),
    };
  }
  init(host) {
    this.memory = host.memory;
    this.output = host.allocate('orbital-observations', 9 * 8, 'f64', 1);
  }
  importPorts() {}
  step({ inputs }) {
    const [position, velocity, time] = this.fields.map((field) => {
      const port = inputs.get(field.name);
      assert.ok(port);
      assert.equal(port.region.type, 'f64');
      assert.equal(port.region.layout, ORBIT_FIELD_LAYOUT);
      return regionWords(this.memory, port.region);
    });
    const observer = regionWords(this.memory, this.output);
    observer.set(position.subarray(3, 6));
    observer.set(velocity.subarray(3, 6), 3);
    const disk = keplerDiskSample(emitter, time[0]);
    observer.set([time[0], disk.radius, disk.azimuth], 6);
  }
  exportPorts() {
    return [];
  }
  stateRegions() {
    return [this.output];
  }
  extraState() {
    return [];
  }
  state() {
    return Array.from(regionWords(this.memory, this.output));
  }
}

async function factory(count) {
  const solvers = await Promise.all(Array.from({ length: count }, () => OrbitSolver.load()));
  return (fps = { num: 24, den: 1 }, memory = undefined) => {
    const orbit = solvers.shift();
    assert.ok(orbit, 'each world has its own loaded solver');
    const observer = new OrbitalObserver(orbit);
    const world = new PhysicsWorld({ rate: fps, memory })
      .add(observer, {})
      .add(orbit, { bodies, gravitationalConstant: 1, timeScale: 5 });
    return Object.assign(world, { orbit, observer });
  };
}

test('OrbitSolver: an observer receives integrated motion and time through the registry', async () => {
  const make = await factory(2);
  const world = make(rate);
  const start = world.orbit.sample(1);
  world.advance(60);
  const now = world.orbit.sample(1);
  assert.notDeepEqual(now.position, start.position);
  const time = world.orbit.elapsedSeconds;
  const disk = keplerDiskSample(emitter, time);
  assert.deepEqual(world.observer.state(), [...now.position, ...now.velocity, time, disk.radius, disk.azimuth]);
  assert.ok(disk.radius < emitter.radius);
  const repeated = make(rate);
  repeated.advance(60);
  assert.equal(world.hash(), repeated.hash());
});

test('OrbitSolver: N-body worlds have identical hashes across frame rates and after seek', async () => {
  const make = await factory(5);
  frameRateIndependent(make);
  seekEqualsContinuous(make);
});

test('OrbitSolver: distinct plain and shared SIMD builds give identical full hashes', async () => {
  const make = await factory(2);
  const plain = make(rate, worldMemory(false));
  const shared = make(rate, worldMemory(true));
  plain.advance(180);
  shared.advance(180);
  assert.equal(plain.hash(), shared.hash());
});
