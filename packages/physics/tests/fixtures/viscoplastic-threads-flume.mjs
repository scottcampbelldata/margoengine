import { TerrainBed } from '../../dist/earth.js';
import { VISCOPLASTIC_INLET_WORDS, VISCOPLASTIC_LAYOUT, ViscoplasticSolver } from '../../dist/viscoplastic.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

export const rate = { num: 60, den: 1 };
const cell = [361_000, 0, -190_200];
const cellWidth = 4096;
const authoredCell = [cell[0] - 1, cell[1], cell[2]];
const cells = [17, 8, 9];
const spacing = 0.125;
const inletStart = 6;
const inletEnd = 15;
const jets = 3;
const flow = 0.003;
const endFrame = 42;
const checkpointFrame = 11;
const floor = (x, z) => 0.24 - 0.061 * x + 0.011 * z;
export const injectedVolume = (jets * flow * (inletEnd - inletStart)) / rate.num;
export const outletVolume = 0.0007;
export const seedVolume = outletVolume + 4 * 0.00015;

const terrain = {
  columns: cells[0],
  rows: cells[2],
  width: cells[0] * spacing,
  depth: cells[2] * spacing,
  centre: [cellWidth + (cells[0] * spacing) / 2, (cells[2] * spacing) / 2],
};
const inlet = {
  name: 'mud-thread-inlet',
  kind: 'particleSet',
  quantity: 'volumeRate',
  unit: 'SI',
  centring: 'particle',
};

class TimedInlet {
  describe() {
    return { id: 'mud-thread-valve', rate: 0, stableRate: () => 0, fields: [{ field: inlet, access: 'write' }] };
  }

  init(host) {
    this.host = host;
    this.region = host.allocate('flow-rows', 8 * jets * VISCOPLASTIC_INLET_WORDS, 'f64', VISCOPLASTIC_LAYOUT);
  }

  importPorts() {}

  step({ tick }) {
    const value = tick >= inletStart && tick < inletEnd ? flow : 0;
    const rows = regionWords(this.host.memory, this.region);
    const x = 0.32;
    for (let jet = 0; jet < jets; jet++) {
      const z = 0.4 + 0.1 * jet;
      rows.set([cellWidth + x, floor(x, z) + 0.075, z, 0.67, -0.12, 0, value], jet * VISCOPLASTIC_INLET_WORDS);
    }
  }

  exportPorts(tick) {
    return [{ field: inlet.name, region: this.region, tick, cell: this.host.cell }];
  }

  stateRegions() {
    return [this.region];
  }

  extraState() {
    return [];
  }
}

export function equalBytes(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export async function runFlume({ shared, threads, solvent }) {
  using mud = await ViscoplasticSolver.load({ terrain, inlet, threads });
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared) });
  const points = [
    // This isolated point starts just inside the authored +X outlet.
    { position: [cellWidth + cells[0] * spacing - 0.007, 0.55, 0.83], velocity: [1, 0, 0], volume: outletVolume },
    ...Array.from({ length: 4 }, (_, i) => ({
      position: [cellWidth + 0.26 + 0.08 * i, 0.34 + 0.038 * i, 0.32 + 0.11 * i],
      velocity: [0.21 + 0.12 * i, -0.02, 0],
      volume: 0.00015,
    })),
  ];
  const capacity = 35;
  world
    .add(new TerrainBed(), { ...terrain, elevations: (x, z) => floor(x - cellWidth, z) }, authoredCell)
    .add(new TimedInlet(), {}, authoredCell)
    .add(
      mud,
      {
        cells,
        spacing,
        origin: [cellWidth, 0, 0],
        walls: [true, false, true, true, true, true],
        capacity,
        points,
        bulkModulus: 8300,
        shearModulus: 270,
        yieldStress: 20,
        consistency: 10,
        exponent: 0.65,
        solventViscosity: solvent,
        friction: 0.02,
      },
      authoredCell,
    );
  try {
    const initial = world.takeSnapshot();
    const coldWork = mud.workCounts();
    world.advance(checkpointFrame);
    const checkpoint = world.takeSnapshot();
    const inflow = mud.budget.injectedReferenceVolume;
    function finish() {
      world.shiftOrigin(cell);
      world.advance(endFrame);
      return world.takeSnapshot();
    }
    const accepted = finish();
    const work = mud.workCounts();
    const budget = mud.budget;
    let minimumBedClearance = Infinity;
    let front = 0;
    for (let i = 0; i < capacity; i++) {
      const point = mud.sample(i);
      if (!point.present) continue;
      const [x, y, z] = point.position;
      front = Math.max(front, x - cellWidth);
      minimumBedClearance = Math.min(minimumBedClearance, y - floor(x - cellWidth, z));
    }
    const portCell = mud.exportPorts(endFrame)[0].cell;
    world.restoreSnapshot(checkpoint.bytes);
    const replay = finish();
    const replayWork = mud.workCounts();
    return {
      initial,
      checkpoint,
      bytes: accepted.bytes,
      hash: accepted.hash,
      replayed: accepted.hash === replay.hash && equalBytes(accepted.bytes, replay.bytes),
      budget,
      inflow,
      minimumBedClearance,
      front,
      portCell,
      work,
      coldWork,
      replayWork,
    };
  } finally {
    world.remove('viscoplastic');
  }
}
