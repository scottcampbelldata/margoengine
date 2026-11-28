import { HeatConduction } from '@margoengine/physics/thermal';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const startCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const thermalCell = startCell.map((coordinate, axis) => coordinate - shift[axis]);
const rate = { num: 60, den: 1 };

export function expectedThermalWork([nx, ny, nz], substeps, threads) {
  const rows = ny * nz;
  const cells = nx * rows;
  const pairs = Math.floor(cells / 2);
  const interiorPairs = Math.floor(Math.max(0, nx - 2) / 2);
  const decoded = substeps + 1;
  const workers = Array.from({ length: threads }, (_, part) => {
    const inPart = (total) => Math.floor(((part + 1) * total) / threads) - Math.floor((part * total) / threads);
    const decodePaired = 2 * inPart(pairs);
    const tail = part === threads - 1 ? cells % 2 : 0;
    return {
      decodedCells: (decodePaired + tail) * decoded,
      pairedDecodeCells: decodePaired * decoded,
      stencilCells: inPart(rows) * nx * substeps,
      pairedStencilCells: inPart(rows) * 2 * interiorPairs * substeps,
    };
  });
  return {
    threads,
    substeps,
    decodedCells: cells * decoded,
    pairedDecodeCells: 2 * pairs * decoded,
    stencilCells: cells * substeps,
    pairedStencilCells: 2 * interiorPairs * rows * substeps,
    workers,
  };
}

class HeatInput {
  constructor(field) {
    this.field = field;
  }

  describe() {
    return {
      id: 'prescribed-heat',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: this.field, access: 'accumulate' }],
    };
  }

  init(host, count) {
    this.host = host;
    this.region = host.allocate('prescribed-heat-energy', 8 * count, 'f64', 1);
  }

  importPorts() {}

  step({ tick }, dt) {
    const values = regionWords(this.host.memory, this.region);
    for (let i = 0; i < values.length; i++) values[i] = (0.5 + (i % 7) / 9 + (tick % 3) / 10) * dt;
    // The last participant receives a finite, signed but physically impossible energy.
    if (this.reject) values[values.length - 1] = -1e9;
  }

  exportPorts(tick) {
    return [{ field: this.field.name, region: this.region, cell: this.host.cell, tick }];
  }

  stateRegions() {
    return [this.region];
  }

  extraState() {
    return [];
  }
}

export function thermalOptions(dimensions) {
  const count = dimensions.reduce((a, b) => a * b);
  return {
    dimensions,
    cellSize: [0.025, 0.032, 0.021],
    materials: [
      {
        conductivity: 1.9,
        heatCapacity: 1.6e6,
        phaseChange: { temperature: 273.15, latentHeat: 2.1e8, liquidHeatCapacity: 3.9e6 },
      },
      { conductivity: 3.1, heatCapacity: 2.1e6 },
    ],
    materialIndices: Array.from({ length: count }, (_, i) => Number(i % 4 === 1)),
    initialTemperature: Array.from({ length: count }, (_, i) => (i % 4 === 0 ? 273.15 : 265 + (i % 29))),
    initialLiquidFraction: Array.from({ length: count }, (_, i) => (i % 4 === 0 ? 0.28 + (i % 7) / 11 : 0)),
    boundaries: {
      xMin: { kind: 'radiation', kelvin: 303, emissivity: 0.83, coefficient: 7 },
      xMax: { kind: 'convection', kelvin: 285, coefficient: 14 },
      yMin: { kind: 'temperature', kelvin: 280 },
      zMin: { kind: 'flux', wattsPerSquareMetre: 17 },
      zMax: { kind: 'radiation', kelvin: 255, emissivity: 0.69 },
    },
  };
}

export function attachThermal(heat, dimensions, shared) {
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared), cellSize: 4096 });
  const input = new HeatInput(heat.enthalpyField);
  world
    .add(
      input,
      dimensions.reduce((a, b) => a * b),
      startCell,
    )
    .add(heat, thermalOptions(dimensions), startCell);
  return { world, input };
}

export function readThermal(heat, world, tick) {
  return Object.fromEntries(
    heat
      .exportPorts(tick)
      .map(({ field, region, cell }) => [
        field,
        { words: regionWords(world.memory, region).slice(), cell: Array.from(cell) },
      ]),
  );
}

export async function followThermal(dimensions, threads, shared = threads > 1) {
  using heat = await HeatConduction.load({ threads });
  const { world } = attachThermal(heat, dimensions, shared);
  world.advance(1);
  const first = readThermal(heat, world, 1);
  const checkpoint = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const work = [];
    for (let frame = 2; frame <= 8; frame++) {
      world.advance(frame);
      work.push(heat.readNativeWork());
    }
    return {
      state: { first, snapshot: world.takeSnapshot(), ports: readThermal(heat, world, 8) },
      work,
    };
  }

  const accepted = run();
  world.restoreSnapshot(checkpoint.bytes);
  return { accepted, replay: run() };
}
