import { bedVertexAreas, TerrainBed } from '../../dist/earth.js';
import { LandscapeEvolution } from '../../dist/landscape.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

export const rate = { num: 60, den: 1 };
export const farCell = [-233_541, 0, 120_345];
export const size = [17, 13];
const year = 31_557_600;
const yearsPerFrame = 100;
const finalFrame = 54;
const upliftPerYear = 0.001;
const rain = {
  name: 'landscape-thread-rain',
  kind: 'uniformGrid',
  quantity: 'rainfall',
  unit: 'm/s',
  centring: 'vertex',
};

function publisher(nx, nz) {
  let host;
  let region;
  return {
    describe: () => ({
      id: 'landscape-thread-weather',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: rain, access: 'write' }],
    }),
    init(owner) {
      host = owner;
      region = host.allocate('rainfall', nx * nz * 8, 'f64', 1);
    },
    step({ tick }) {
      const regional = tick >= 6 && tick < 41 ? 1.8 : 0.32;
      const values = regionWords(host.memory, region);
      for (let column = 0; column < nx; column++) {
        for (let row = 0; row < nz; row++) {
          const dryDivide = (column + 2 * row) % 11 === 0;
          values[column * nz + row] = dryDivide ? 0 : (regional + (0.6 * column) / nx + (0.2 * row) / nz) / year;
        }
      }
    },
    importPorts() {},
    exportPorts: (tick) => [{ field: rain.name, tick, cell: host.cell, region }],
    stateRegions: () => [region],
    extraState: () => [],
  };
}

function equalBytes(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export async function runValley(shared, threads) {
  const [nx, nz] = size;
  const grid = { columns: nx - 1, rows: nz - 1, width: 480, depth: 288, centre: [0, 0] };
  const terrain = new TerrainBed();
  using landscape = await LandscapeEvolution.load({ threads, rainField: rain });
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared) });
  function heights(x, z) {
    const divide = Math.max(0, 1 - Math.abs((x + 90) / 98)) * Math.max(0, 1 - Math.abs((z - 75) / 90));
    return 38 + 0.095 * (240 - x) + 0.17 * Math.abs(z - 13) + 49 * divide;
  }
  world
    .add(terrain, { ...grid, elevations: heights }, farCell)
    .add(publisher(nx, nz), {}, farCell)
    .add(
      landscape,
      {
        grid,
        uplift: upliftPerYear / year,
        secondsPerSecond: yearsPerFrame * year * rate.num,
        erodibility: 1.1e-9,
        hillslopeDiffusivity: 0.13 / year,
        thermalDiffusivity: 0.08 / year,
        talusSlope: 0.42,
        outlets: { maxX: true },
        alluvialDepth: 0.6,
        grains: [
          { diameter: 0.0001, fraction: 0.38, travelLength: 35 },
          { diameter: 0.0008, fraction: 0.62, travelLength: 11 },
        ],
      },
      farCell,
    );
  const bed0 = terrain.elevations();
  const volume0 = terrain.volume();
  const weights = bedVertexAreas(grid);

  function receipt() {
    const elevations = terrain.elevations();
    const ports = landscape.exportPorts(finalFrame);
    const pending = regionWords(world.memory, ports[0].region);
    let accumulatedVolume = 0;
    let maximumRise = 0;
    let maximumFall = 0;
    let fixedOutlet = true;
    let discharge = 0;
    let incision = 0;
    let sediment = 0;
    let outletDischarge = 0;
    for (let i = 0; i < elevations.length; i++) {
      const column = Math.floor(i / nz);
      const row = i % nz;
      const sample = landscape.read(column, row);
      accumulatedVolume += pending[i] * weights[i];
      maximumRise = Math.max(maximumRise, elevations[i] - bed0[i]);
      maximumFall = Math.min(maximumFall, elevations[i] - bed0[i]);
      if (column === grid.columns) {
        fixedOutlet &&= elevations[i] === bed0[i];
        outletDischarge += sample.discharge;
      }
      discharge = Math.max(discharge, sample.discharge);
      incision = Math.max(incision, sample.incision);
      sediment = Math.max(sediment, sample.sedimentFlux);
    }
    const budget = landscape.budget;
    return {
      volume0,
      volume: terrain.volume(),
      pendingVolume: accumulatedVolume,
      expectedUplift:
        finalFrame * yearsPerFrame * upliftPerYear * (grid.width - grid.width / (2 * grid.columns)) * grid.depth,
      elapsedYears: budget.elapsed / year,
      budget,
      maximumRise,
      maximumFall,
      fixedOutlet,
      discharge,
      incision,
      sediment,
      outletDischarge,
      terrainCell: terrain.bed.cell,
      fieldCell: ports[0].cell,
    };
  }

  try {
    const start = world.takeSnapshot();
    const coldWork = landscape.workCounts();
    world.advance(23);
    const checkpoint = world.takeSnapshot();
    const beforeShiftCell = landscape.exportPorts(23)[0].cell;
    const reachEnd = () => {
      world.shiftOrigin(farCell);
      world.advance(finalFrame);
      return world.takeSnapshot();
    };
    const final = reachEnd();
    const physical = receipt();
    const work = landscape.workCounts();
    world.restoreSnapshot(checkpoint.bytes);
    const replay = reachEnd();
    return {
      start,
      checkpoint,
      final,
      physical,
      beforeShiftCell,
      coldWork,
      work,
      replayWork: landscape.workCounts(),
      replayed: replay.hash === final.hash && equalBytes(replay.bytes, final.bytes),
    };
  } finally {
    world.remove('landscape');
  }
}
