import assert from 'node:assert/strict';
import test from 'node:test';

import { GlacierSolver } from '../../dist/glacier.js';
import { ICEBERG_BODY_WORDS, ICEBERG_FIELD_LAYOUT, IcebergSolver } from '../../dist/iceberg.js';
import { WakeSolver } from '../../dist/sea.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const rock = {
  nx: 4,
  nz: 1,
  dx: 1,
  bed: [-0.53, -0.63, -0.83, -2],
  thickness: [1, 1, 1, 0],
  boundary: [0, 0, 0, 1],
  timeScale: 60,
};

class WaveVolumeProbe {
  constructor(berg) {
    this.fields = [berg.bodyField, berg.waveField, berg.meltwaterField, berg.releaseField];
  }
  describe() {
    return {
      id: 'iceberg-consumer',
      rate: 0,
      stableRate: () => 0,
      fields: this.fields.map((field) => ({ field, access: 'read' })),
    };
  }
  init(host) {
    this.memory = host.memory;
    this.output = host.allocate('iceberg-consumer-budget', 24, 'f64', 1);
  }
  importPorts() {}
  step({ inputs }, dt) {
    const data = this.fields.map((field) => {
      const port = inputs.get(field.name);
      assert.ok(port);
      assert.equal(port.region.type, 'f64');
      assert.equal(port.region.layout, ICEBERG_FIELD_LAYOUT);
      return regionWords(this.memory, port.region);
    });
    const [body, wave, fresh, release] = data;
    assert.equal(body.length, wave.length * ICEBERG_BODY_WORDS);
    const output = regionWords(this.memory, this.output);
    output[0] += wave.reduce((sum, value) => sum + value, 0);
    output[1] += fresh.reduce((sum, value) => sum + value * dt, 0);
    output[2] += release.reduce((sum, value) => sum + value, 0);
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
  budget() {
    return Array.from(regionWords(this.memory, this.output));
  }
}

async function factory(count) {
  const inputs = await Promise.all(
    Array.from({ length: count }, async () => {
      const glacier = await GlacierSolver.load();
      const berg = await IcebergSolver.load({ calving: glacier.calvingField });
      return { glacier, berg };
    }),
  );
  return (fps = rate, memory) => {
    const { glacier, berg } = inputs.shift();
    const observer = new WaveVolumeProbe(berg);
    const wake = new WakeSolver('iceberg-wake', berg.wakeSourceField);
    const world = new PhysicsWorld({ rate: fps, memory })
      .add(observer, {})
      .add(wake, { cells: [24, 24], cellSize: 0.25, centre: [3, 7], depth: 8, sponge: 0 })
      .add(berg, { releaseSites: [{ sourceCell: 2, position: [3, 7] }], basalMelt: 0.03 })
      .add(glacier, rock);
    return Object.assign(world, { glacier, berg, observer, wake });
  };
}

function near(actual, expected, bound) {
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} differs from ${expected} by more than ${bound}`);
}

test('IcebergSolver: real glacier loses the ice that spawns a block, with signed wave and freshwater records', async () => {
  const make = await factory(2);
  const first = make();
  first.advance(1);
  const event = first.glacier.sample(2, 0).calving;
  assert.ok(event > 0);
  const [x, , z] = first.berg.sample(0).position;
  // Moving the mass centre through one basal recession shifts it by at most half that thickness.
  near(x, 3, 0.03 / (2 * 60));
  assert.equal(z, 7);
  near(first.berg.budget.ice + first.berg.budget.melted, event, 32 * Number.EPSILON * event);
  assert.equal(first.observer.budget()[2], event);
  assert.ok(first.observer.budget()[0] > 0);
  const wakeHeight = first.wake.heights();
  const displaced = first.berg.sample(0).displaced;
  assert.ok(wakeHeight.some((height) => height < 0));
  assert.ok(wakeHeight.some((height) => height > 0));
  near(
    wakeHeight.reduce((sum, height) => sum + height * 0.25 * 0.25, 0),
    0,
    24 * 24 * 32 * Number.EPSILON * displaced,
  );
  first.advance(120);
  const [wave, fresh, admitted] = first.observer.budget();
  assert.ok(Math.abs(first.wake.sample(4.5, 7).height) > 0.0001, 'the launched wave travels beyond the source rings');
  const error = 120 * 32 * Number.EPSILON * event;
  near(wave, first.berg.sample(0).displaced, error);
  near(fresh, (first.berg.budget.melted * 917) / 1000, error);
  assert.equal(admitted, event);
  const { calved, awaiting, ice, melted } = first.berg.budget;
  assert.equal(calved, first.glacier.budget.calved);
  assert.ok(awaiting > 0, 'the still-occupied destination keeps subsequent small calving events pending');
  near(calved, admitted + awaiting, error);
  near(calved, ice + melted + awaiting, error);
  const repeat = make();
  repeat.advance(120);
  assert.equal(repeat.hash(), first.hash());
});

test('IcebergSolver: frame cadence and seeking preserve complete coupled world hashes', async () => {
  const make = await factory(5);
  frameRateIndependent(make);
  seekEqualsContinuous(make);
});

test('IcebergSolver: no-slot shared and plain builds give identical coupled hashes', async () => {
  const make = await factory(2);
  const plainMemory = worldMemory(false);
  const sharedMemory = worldMemory(true);
  assert.ok(plainMemory.buffer instanceof ArrayBuffer);
  assert.ok(sharedMemory.buffer instanceof SharedArrayBuffer);
  const plain = make(rate, plainMemory);
  const shared = make(rate, sharedMemory);
  plain.advance(90);
  shared.advance(90);
  assert.equal(shared.hash(), plain.hash());
});
