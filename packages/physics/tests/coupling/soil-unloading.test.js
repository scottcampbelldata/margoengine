import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed } from '@margoengine/physics/earth';
import { soilPatchField, Terramechanics } from '@margoengine/physics/terramechanics';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const terrain = { columns: 8, rows: 8, width: 0.8, depth: 0.8, centre: [0, 0] };
const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}, tolerance ${tolerance}`);

function driver(field, sequence, side) {
  let region;
  let memory;
  return {
    describe: () => ({
      id: 'plate-test',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field, access: 'write' }],
    }),
    init(host) {
      memory = host.memory;
      region = host.allocate('plate-load', 80, 'f64', 1);
    },
    step(context) {
      const { x = 0, pressure } = sequence[context.tick];
      regionWords(memory, region).set([x, 0, 0, 1, side, side, pressure * side * side, 0, 0, 0]);
    },
    exportPorts: (tick) => [{ field: field.name, region, tick, cell: [0, 0, 0] }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
}

async function drivenCycle(tier, shared, soilMaterial, sequence, floor) {
  const input = soilPatchField();
  const soil = await Terramechanics.load({ tier, input });
  const bed = new TerrainBed();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared) });
  const plate = driver(input, sequence, 0.3);
  world.add(plate);
  world.add(soil, { terrain, inputRows: 1, material: soilMaterial, floor });
  world.add(bed, { ...terrain, elevations: () => 0, bedrock: floor === undefined ? undefined : () => floor });
  world.couple(['plate-test', 'terramechanics', 'bed'], 'staggered');
  return { world, bed, soil };
}

const material = {
  cohesiveModulus: 0,
  frictionalModulus: 100_000,
  exponent: 1,
  compaction: 1,
  dustFraction: 0,
  unloading: { stiffness: 400_000, hardening: 2_000_000 },
};

for (const tier of ['mean', 'resolved']) {
  test(`the ${tier} plate rebounds and reloads on the previous elastic line on the live bed`, async () => {
    const pressureSequence = [10_000, 5000, 0, 7500, 10_000, 15_000, 0];
    const sequence = pressureSequence.map((pressure) => ({ pressure }));
    const hashes = [];
    for (const shared of [false, true]) {
      const { world, bed, soil } = await drivenCycle(tier, shared, material, sequence);
      // This plate covers exactly nine equally weighted interior nodes in the selected grid.
      const area = 0.09;
      const depth1 = 0.1;
      const depth2 = 0.15;
      const ku1 = 600_000;
      const ku2 = 700_000;
      const plastic1 = depth1 - 10_000 / ku1;
      const plastic2 = depth2 - 15_000 / ku2;
      const expectations = [
        [depth1, plastic1],
        [plastic1 + 5000 / ku1, plastic1],
        [plastic1, plastic1],
        [plastic1 + 7500 / ku1, plastic1],
        [depth1, plastic1],
        [depth2, plastic2],
        [plastic2, plastic2],
      ];
      let snapshot;
      for (const [index, [total, plastic]] of expectations.entries()) {
        world.advance(index + 1);
        if (index === 1) snapshot = world.takeSnapshot();
        const pressure = pressureSequence[index];
        if (pressure > 0) {
          near(soil.read(0).normalForce, pressure * area, 2e-12);
          near(soil.read(0).sinkage, total, 2e-15);
        }
        near(bed.elevations()[40], -total, 2e-15);
        near(bed.volume(), -total * area, 2e-15);
        near(soil.budget.removed, plastic * area, 2e-15);
        near(soil.budget.compacted, plastic * area, 2e-15);
        assert.equal(soil.budget.deposited, 0);
        assert.equal(soil.budget.suspended, 0);
        assert.equal(bed.refusedVolume(), 0);
      }
      const hash = world.hash();
      world.restoreSnapshot(snapshot.bytes);
      world.advance(expectations.length);
      assert.equal(world.hash(), hash);
      hashes.push(hash);
    }
    assert.equal(hashes[0], hashes[1]);
  });
}

test('the previous footprint recovers as a plate moves onto another part of the bed', async () => {
  const sequence = [
    { pressure: 10_000, x: -0.2 },
    { pressure: 10_000, x: 0.2 },
    { pressure: 0, x: 0.2 },
  ];
  const { world, bed, soil } = await drivenCycle('resolved', false, material, sequence);
  world.advance(1);
  const total = 0.1;
  const elastic = 10_000 / 600_000;
  const plastic = total - elastic;
  near(bed.bed.sample(-0.2, 0).elevation, -total, 2e-8);
  assert.equal(bed.bed.sample(0.2, 0).elevation, 0);
  world.advance(2);
  near(bed.bed.sample(-0.2, 0).elevation, -plastic, 2e-8);
  near(bed.bed.sample(0.2, 0).elevation, -total, 2e-8);
  const cut = soil.budget.removed;
  world.advance(3);
  near(bed.bed.sample(0.2, 0).elevation, -plastic, 2e-8);
  near(bed.volume(), -cut, 4e-15);
});

test('repeated elastic loads against a bed floor cannot carve below the floor or create permanent dust', async () => {
  const pressureSequence = [10_000, 5000, 10_000, 0, 10_000, 0];
  const sequence = pressureSequence.map((pressure) => ({ pressure }));
  const floor = -0.09;
  const dustySoil = { ...material, compaction: 0.6, dustFraction: 0.01 };
  const { world, bed, soil } = await drivenCycle('resolved', false, dustySoil, sequence, floor);
  const plastic = 0.1 - 10_000 / 600_000;
  // The f32 bed field uses its conservative rounding interval to calculate remaining room.
  const floorUlp = 2 ** -27;
  let firstCut = 0;
  let firstDust = 0;
  for (const [index, pressure] of pressureSequence.entries()) {
    world.advance(index + 1);
    if (!index) {
      firstCut = soil.budget.removed;
      firstDust = soil.budget.suspended;
      assert.ok(firstDust > 0);
    }
    const elevation = bed.elevations()[40];
    if (pressure > 0) assert.ok(elevation >= floor && elevation <= floor + floorUlp);
    else near(elevation, -plastic, 2e-15);
    assert.equal(soil.budget.removed, firstCut);
    assert.equal(soil.budget.suspended, firstDust);
    assert.equal(bed.refusedVolume(), 0);
  }
});
