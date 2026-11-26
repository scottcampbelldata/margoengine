import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGEING_EXPOSURE_WORDS,
  AGEING_STATE_WORDS,
  AGEING_YEAR,
  atmosphericMetalLoss,
  MaterialAgeingSolver,
  writeAgeingExposure,
} from '@margoengine/physics/ageing';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const FPS = { num: 60, den: 1 };
const CENTRE = [0, 0, 0];
const DAY = 86400;

function near(a, b, tolerance) {
  assert.ok(Math.abs(a - b) <= tolerance, `expected ${b} ± ${tolerance}, got ${a}`);
}

class SampleExposure {
  constructor(field, count, exposure) {
    this.field = field;
    this.count = count;
    this.exposure = exposure;
  }
  describe() {
    return { id: 'exposure', fields: [{ field: this.field, access: 'write' }], rate: 0, stableRate: () => 0 };
  }
  init(host) {
    this.memory = host.memory;
    this.region = host.allocate('data', AGEING_EXPOSURE_WORDS * this.count * 8, 'f64', 1);
  }
  step({ tick }) {
    const out = regionWords(this.memory, this.region);
    for (let i = 0; i < this.count; i++) writeAgeingExposure(out, this.exposure(tick, i), i);
  }
  exportPorts(tick) {
    return [{ field: this.field.name, region: this.region, tick, cell: CENTRE }];
  }
  importPorts() {}
  stateRegions() {
    return [this.region];
  }
  extraState() {
    return [];
  }
}

function scenario({ rate = FPS, shared = false, patches, scale, exposure, fromPort, count = 1 }) {
  const solver = new MaterialAgeingSolver({ readExposure: !!fromPort });
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared) });
  world.add(solver, { patches, exposure, timeScale: scale });
  if (fromPort) world.add(new SampleExposure(solver.exposureField, count, fromPort), {});
  return { world, solver };
}

test('MaterialAgeingSolver follows ISO 9224 for 20 years, then the tangent continuation', () => {
  const climate = { temperature: 283.15, relativeHumidity: 0.75, sulphurDioxide: 10, chloride: 30, submerged: 0 };
  const { world, solver } = scenario({
    patches: [{ material: 'steel' }, { material: 'copper' }],
    scale: AGEING_YEAR * 60,
    exposure: climate,
  });
  for (const t of [1, 6, 20, 21, 30]) {
    world.advance(t);
    for (const [i, [metal, b]] of [
      ['steel', 0.523],
      ['copper', 0.667],
    ].entries()) {
      const first = atmosphericMetalLoss(metal, climate);
      const age = t <= 20 ? t ** b : 20 ** b + b * 20 ** (b - 1) * (t - 20);
      const result = solver.read(i);
      near(result.consumedThickness, first * age, 3e-17);
      near(result.consumedThickness + result.remainingThickness, 0.01, 3e-18);
      near(result.exposureSeconds, t * AGEING_YEAR, 1e-6);
    }
  }
  const copper = solver.read(1);
  assert.ok(copper.coatingThickness > copper.innerCoatingThickness);
  const color = solver.appearance(1).color;
  assert.ok(color[1] > color[0], 'the mature outer copper coating is green');
  const statePort = solver.exportPorts(29)[0];
  assert.equal(statePort.region.layout, 1);
  assert.equal(statePort.region.byteLength, 2 * AGEING_STATE_WORDS * 8);
  assert.equal(regionWords(world.memory, statePort.region)[AGEING_STATE_WORDS + 2], copper.coatingThickness);
});

test('Marine steel loses thickness by Faraday charge and recruits fouling only while immersed', () => {
  const exposure = { corrosionCurrent: 0.1, sulphurDioxide: 0, chloride: 0, submerged: 1, larvalSupply: 0.4 };
  const patch = { material: 'steel', fouling: { settlement: 0.03, wetRemoval: 0.01, dryRemoval: 0.02 } };
  const { world, solver } = scenario({
    patches: [patch],
    scale: 60 * DAY,
    fromPort: (tick) => ({ ...exposure, submerged: tick < 40 ? 1 : 0 }),
  });
  world.advance(40);
  const after = solver.read(0);
  const steelSpeed = (0.1 * 0.055845) / (2 * 96485.33212331002 * 7870);
  near(after.consumedThickness, steelSpeed * 40 * DAY, 1e-18);
  const settlement = 0.03 * 0.4;
  const total = settlement + 0.01;
  const cover = (settlement / total) * (1 - Math.exp(-40 * total));
  near(after.fouledFraction, cover, 1e-14);
  world.advance(70);
  const exposed = solver.read(0);
  assert.equal(exposed.consumedThickness, after.consumedThickness);
  near(exposed.fouledFraction, cover * Math.exp(-0.02 * 30), 1e-14);
});

test('A wreck switches from atmospheric attack to immersion, and loss stops at its substrate thickness', () => {
  const atmosphere = { temperature: 283.15, relativeHumidity: 0.7, sulphurDioxide: 15, chloride: 25, submerged: 0 };
  const first = atmosphericMetalLoss('steel', atmosphere);
  const cap = first + 1.4 * 60e-6;
  const { world, solver } = scenario({
    patches: [{ material: 'steel', thickness: cap, coatingRetention: 0.5 }],
    scale: AGEING_YEAR * 60,
    fromPort: (tick) => ({ ...atmosphere, submerged: tick ? 1 : 0 }),
  });
  world.advance(1);
  near(solver.read(0).consumedThickness, first, 3e-19);
  world.advance(2);
  near(solver.read(0).consumedThickness, first + 60e-6, 3e-19);
  assert.ok(solver.read(0).fouledFraction > 0);
  world.advance(3);
  const last = solver.read(0);
  assert.equal(last.consumedThickness, cap);
  assert.equal(last.remainingThickness, 0);
  const rustRatio = (0.159687 / (2 * 0.055845)) * (7870 / 5240);
  near(last.coatingThickness, 0.5 * rustRatio * cap, 1e-18);
  world.advance(10);
  assert.equal(solver.read(0).consumedThickness, cap);
});

test('Pine sapwood begins losing mass at the analytically computed activation threshold', () => {
  const temperature = 293.15;
  const t = 20;
  const rh = 100;
  const critical = (720 * (2.3 * t + 0.035 * rh - 0.024 * t * rh)) / (-42 + 0.14 * t + 0.45 * rh);
  const lossPerHour = (-0.0596 + 0.000196 * t + 0.000625 * rh) / 100;
  const { world, solver } = scenario({
    patches: [{ material: 'wood', thickness: 0.05 }],
    scale: 60 * 3600 * 100,
    fromPort: (tick) => ({ temperature, relativeHumidity: tick === 2 ? 0.6 : 1 }),
  });
  world.advance(1);
  near(solver.read(0).rotActivity, 100 / critical, 2e-14);
  assert.equal(solver.read(0).consumedThickness, 0);
  world.advance(2);
  const wet = solver.read(0);
  near(wet.rotActivity, 1, 0);
  near(wet.consumedThickness, (200 - critical) * lossPerHour * 0.05, 2e-17);
  world.advance(3);
  const dry = solver.read(0);
  assert.equal(dry.consumedThickness, wet.consumedThickness);
  near(dry.rotActivity, 1 - 100 / 17520, 1e-15);
  world.advance(4);
  near(
    solver.read(0).consumedThickness,
    wet.consumedThickness + (100 - (100 / 17520) * critical) * lossPerHour * 0.05,
    2e-17,
  );
});

test('Calcite recession tracks clean rainfall, excess-proton mass balance and individual climate rows', () => {
  const { world, solver } = scenario({
    patches: [{ material: 'limestone' }, { material: 'limestone' }, { material: 'limestone' }],
    scale: 60 * AGEING_YEAR,
    count: 3,
    fromPort: (_, row) => ({
      rainfall: 1 / AGEING_YEAR,
      rainPh: row === 1 ? 4 : 5.6,
      dryRecession: row === 1 ? 1e-6 / AGEING_YEAR : 0,
      submerged: row === 2 ? 1 : 0,
    }),
  });
  world.advance(1);
  near(solver.read(0).consumedThickness, 18.8e-6, 1e-19);
  const excessMolPerCubicMetre = (10 ** -4 - 10 ** -5.6) * 1000;
  const loss = 18.8e-6 + ((excessMolPerCubicMetre / 2) * 0.1000869) / 2710 + 1e-6;
  near(solver.read(1).consumedThickness, loss, 1e-19);
  assert.equal(solver.read(2).consumedThickness, 0);
});

test('MaterialAgeingSolver preserves material and field states across film rates, shared memory and seeks', () => {
  const options = {
    patches: [{ material: 'steel' }, { material: 'wood', exposureMultiplier: 2 }, { material: 'limestone' }],
    scale: 60 * 14 * DAY,
    fromPort: (tick) => ({
      submerged: tick > 24 && tick < 51 ? 1 : 0,
      temperature: 293.15,
      relativeHumidity: tick % 10 < 6 ? 1 : 0.7,
      rainPh: 4,
    }),
  };
  frameRateIndependent((rate) => scenario({ ...options, rate }).world);
  seekEqualsContinuous(() => scenario({ ...options, rate: { num: 24, den: 1 } }).world);
  const plain = scenario(options);
  const shared = scenario({ ...options, shared: true });
  plain.world.advance(60);
  shared.world.advance(60);
  assert.equal(plain.world.hash(), shared.world.hash());
  assert.deepEqual(plain.solver.appearance(0), shared.solver.appearance(0));
});
