import assert from 'node:assert/strict';
import test from 'node:test';

import { bedSurface } from '../../dist/earth.js';
import { GLACIER_FIELD_LAYOUT, GlacierSolver } from '../../dist/glacier.js';
import { ShallowWaterSolver } from '../../dist/hydro.js';
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
  melt: 1e-4,
  timeScale: 60,
};

class MarineSourceProbe {
  constructor(ice) {
    this.fields = [ice.calvingField, ice.icefallField];
  }
  describe() {
    return {
      id: 'marine-volume-source-probe',
      rate: 0,
      stableRate: () => 0,
      fields: this.fields.map((field) => ({ field, access: 'read' })),
    };
  }
  init(host) {
    this.memory = host.memory;
    this.total = host.allocate('marine-source-total', 16, 'f64', 1);
  }
  importPorts() {}
  step({ inputs }) {
    const output = regionWords(this.memory, this.total);
    for (const [i, field] of this.fields.entries()) {
      const port = inputs.get(field.name);
      assert.ok(port);
      assert.equal(port.region.type, 'f64');
      assert.equal(port.region.layout, GLACIER_FIELD_LAYOUT);
      output[i] += regionWords(this.memory, port.region).reduce((sum, value) => sum + value, 0);
    }
  }
  exportPorts() {
    return [];
  }
  stateRegions() {
    return [this.total];
  }
  extraState() {
    return [];
  }
  volumes() {
    return Array.from(regionWords(this.memory, this.total));
  }
}

async function factory(count) {
  const solvers = await Promise.all(Array.from({ length: count }, () => GlacierSolver.load()));
  return (fps = rate, memory) => {
    const ice = solvers.shift();
    assert.ok(ice);
    const flood = new ShallowWaterSolver('river', {
      field: ice.meltwaterField,
      outlets: [
        { sourceCell: 2, position: [1, 1] },
        { sourceCell: 3, position: [1, 1] },
      ],
    });
    const geometry = { columns: 2, rows: 2, width: 4, depth: 4, centre: [2, 2] };
    const bed = bedSurface(geometry, new Float64Array(9));
    const source = new MarineSourceProbe(ice);
    const world = new PhysicsWorld({ rate: fps, memory }).add(flood, { bed }).add(source, {}).add(ice, rock);
    return Object.assign(world, { ice, flood, source });
  };
}

test('GlacierSolver: real shallow water receives routed melt and a wave source sees detached volume once', async () => {
  const make = await factory(2);
  const world = make();
  world.advance(120);
  const moved = (world.ice.budget.melted * 917) / 1000;
  assert.ok(moved > 0);
  const bound = 120 * 32 * Number.EPSILON * moved;
  assert.ok(Math.abs(world.flood.budget.inflow - moved) <= bound);
  assert.ok(Math.abs(world.flood.volume() - moved) <= bound);
  assert.ok(world.flood.sample(1, 1).depth > 0);
  assert.ok(world.ice.budget.calved > 0);
  assert.deepEqual(world.source.volumes(), [world.ice.budget.calved, 0]);
  const repeat = make();
  repeat.advance(120);
  assert.equal(repeat.hash(), world.hash());
});

test('GlacierSolver: coupled snapshots and frame-rate changes preserve the exact state', async () => {
  const make = await factory(5);
  frameRateIndependent(make);
  seekEqualsContinuous(make);
});

test('GlacierSolver: plain and shared kernels give the same hashes after drainage and release', async () => {
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
