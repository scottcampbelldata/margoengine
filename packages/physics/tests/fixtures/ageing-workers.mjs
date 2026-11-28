import {
  AGEING_EXPOSURE_WORDS,
  AGEING_YEAR,
  MaterialAgeingSolver,
  writeAgeingExposure,
} from '@margoengine/physics/ageing';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const start = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const ageingCell = start.map((value, axis) => value - shift[axis]);
const materials = ['steel', 'copper', 'wood', 'limestone'];

export function expectedAgeingWork(count, threads) {
  const pairs = Math.floor(count / 2);
  const workers = Array.from({ length: threads }, (_, part) => {
    const from = 2 * Math.floor((part * pairs) / threads);
    const to = part === threads - 1 ? count : 2 * Math.floor(((part + 1) * pairs) / threads);
    const patches = to - from;
    const work = { patches, pairedPatches: patches - (patches % 2), steel: 0, copper: 0, wood: 0, limestone: 0 };
    for (let row = from; row < to; row++) work[materials[row % 4]]++;
    return work;
  });
  const sums = Object.fromEntries(
    Object.keys(workers[0]).map((key) => [key, workers.reduce((sum, work) => sum + work[key], 0)]),
  );
  return { threads, ...sums, workers };
}

function exposure(index, tick) {
  const material = materials[index % 4];
  const wood = material === 'wood';
  const submerged = [0, 1, 0.17, 0.73, 0.31, 0][(tick + Math.floor(index / 4)) % 6];
  return {
    temperature: (wood ? 294.15 : 281.15) + (index % 5) * 2,
    relativeHumidity: wood ? 0.98 : 0.51 + ((index + 2 * tick) % 11) / 25,
    sulphurDioxide: index % 7 === 1 ? 0 : 1.25 + (index % 18),
    chloride: index % 11 === 1 ? 0 : 2.3 + (index % 53),
    submerged,
    rainfall: (0.4 + tick / 3 + (index % 3) / 5) / AGEING_YEAR,
    rainPh: 3.9 + (index % 7) / 3,
    corrosionCurrent: index % 17 === 1 ? 0 : 0.07 + (index % 9) / 130,
    dryRecession: ((1 + (index % 6)) * 1e-6) / AGEING_YEAR,
    larvalSupply: 0.1 + (index % 9) / 13,
  };
}

class Exposure {
  constructor(field, patches) {
    this.field = field;
    this.patches = patches;
  }

  describe() {
    return {
      id: 'civil-material-exposure',
      fields: [{ field: this.field, access: 'write' }],
      rate: 0,
      stableRate: () => 0,
    };
  }

  init(host) {
    this.host = host;
    this.region = host.allocate('civil-material-climate', this.patches * AGEING_EXPOSURE_WORDS * 8, 'f64', 1);
  }

  step({ tick }) {
    const bank = regionWords(this.host.memory, this.region);
    for (let i = 0; i < this.patches; i++) writeAgeingExposure(bank, exposure(i, tick), i);
  }

  importPorts() {}

  exportPorts(tick) {
    return [{ field: this.field.name, cell: this.host.cell, tick, region: this.region }];
  }

  stateRegions() {
    return [this.region];
  }

  extraState() {
    return [];
  }
}

export async function followAgeing(count, threads, shared = threads > 1) {
  using solver = threads
    ? await MaterialAgeingSolver.load({ readExposure: true, threads })
    : new MaterialAgeingSolver({ readExposure: true });

  const patches = Array.from({ length: count }, (_, i) => ({
    material: materials[i % 4],
    thickness: (i % 4 < 2 ? 0.002 : 0.009) + (i % 7) * 0.0001,
    initialLoss: i % 17 === 0 ? 0.00018 : 0,
    initialCover: i % 11 === 0 ? 0.22 : -0,
    initialRotActivity: i % 4 === 2 ? 0.82 : -0,
    exposureMultiplier: i % 13 === 1 ? 0 : 0.2 + (i % 7) * 0.37,
    coatingRetention: 0.54 + (i % 6) * 0.075,
    copperInnerScale: 7.4e-6 + (i % 5) * 1e-6,
    fouling: { settlement: 0.004 + (i % 5) * 0.002, wetRemoval: 0.004, dryRemoval: 0.008 },
  }));
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared), cellSize: 4096 });
  world
    .add(new Exposure(solver.exposureField, count), {}, start)
    .add(solver, { patches, timeScale: AGEING_YEAR * 6 }, start);
  world.advance(2);
  const checkpoint = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const before = [0, 1, 2, 3].filter((i) => i < count).map((i) => solver.read(i));
    const work = [];
    for (let frame = 3; frame <= 9; frame++) {
      world.advance(frame);
      work.push(solver.readNativeWork());
    }
    const port = world.fields.port(solver.stateField.name);
    return {
      state: {
        before,
        snapshot: world.takeSnapshot(),
        cell: Array.from(port.cell),
        words: regionWords(world.memory, port.region).slice(),
        readings: patches.map((_, i) => solver.read(i)),
        appearances: patches.map((_, i) => solver.appearance(i)),
      },
      work,
    };
  }
  const accepted = run();
  world.restoreSnapshot(checkpoint.bytes);
  return { accepted, replay: run() };
}
