import { RainfallRunoff } from '../../dist/runoff.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

export const rate = { num: 60, den: 1 };
export const farCell = [285_465, 0, -964_270];
export const smallGrid = [13, 7];
const rainStart = 4;
const rainChange = 17;
const rainStop = 26;
const meltStart = 6;
const meltStop = 22;
const evaporationStart = 10;
const condensationStart = 27;
const condensationStop = 33;
// ATMO-09 water-flux rows are millimetres of equivalent water per second.
const meltRate = 0.14;
const evaporationRate = 0.09;
const condensationRate = 0.06;
const dx = 1.2;
const dz = 0.8;
const area = dx * dz;

const rain = {
  name: 'threaded-rain',
  kind: 'uniformGrid',
  quantity: 'precipitationRate',
  unit: 'm/s',
  centring: 'cell',
};
const energy = {
  name: 'threaded-energy',
  kind: 'uniformGrid',
  quantity: 'surfaceWaterFlux',
  unit: 'kg/(m^2 s)',
  centring: 'cell',
};
const rates = [0.018, 0.014, 0, 0.01, 0, 0.006, 0];
const rainRate = (i) => rates[i % rates.length];

function atmosphere(n) {
  let host;
  let rainRegion;
  let energyRegion;
  return {
    describe: () => ({
      id: 'runoff-thread-forcing',
      fields: [
        { field: rain, access: 'write' },
        { field: energy, access: 'write' },
      ],
      rate: 0,
      stableRate: () => 0,
    }),
    init(owner) {
      host = owner;
      rainRegion = host.allocate('rain-rates', n * 8, 'f64', 1);
      energyRegion = host.allocate('energy-water-flux', 3 * 8, 'f64', 1);
    },
    importPorts() {},
    step({ tick }) {
      const factor = tick < rainStart || tick >= rainStop ? 0 : tick < rainChange ? 1 : 0.5;
      const values = regionWords(host.memory, rainRegion);
      for (let i = 0; i < n; i++) values[i] = factor * rainRate(i);
      const evaporation =
        tick < evaporationStart
          ? 0
          : tick < condensationStart
            ? evaporationRate
            : tick < condensationStop
              ? -condensationRate
              : 0;
      regionWords(host.memory, energyRegion).set([evaporation, tick >= meltStart && tick < meltStop ? meltRate : 0, 0]);
    },
    exportPorts(tick) {
      return [
        { field: rain.name, region: rainRegion, tick, cell: host.cell },
        { field: energy.name, region: energyRegion, tick, cell: host.cell },
      ];
    },
    stateRegions: () => [rainRegion, energyRegion],
    extraState: () => [],
  };
}

export function setupRain() {
  return { rain: { field: rain }, surfaceEnergy: energy };
}

export function makeCatchment(runoff, [nx, nz], shared) {
  const n = nx * nz;
  const middle = Math.floor(nz / 2);
  const outlet = middle * nx + nx - 1;
  const downstream = Int32Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / nx);
    return i === outlet ? -1 : row < middle ? i + nx : row > middle ? i - nx : i + 1;
  });
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared) });
  world.add(
    runoff,
    {
      nx,
      nz,
      dx,
      dz,
      origin: [12, -9],
      downstream,
      conductivity: Float64Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 3e-5 : 9e-4)),
      wetnessIndex: Float64Array.from({ length: n }, (_, i) => (i % 9) - 4),
      soilCapacity: 0.055,
      drainage: 0.016,
      roughness: 0.031,
      slope: 0.11,
    },
    farCell,
  );
  world.add(atmosphere(n), {}, farCell);

  function summary() {
    let stored = 0;
    let wet = 0;
    let soilCells = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const sample = runoff.read(i, j);
        stored += (sample.depth + sample.soilWater) * area;
        if (sample.depth > 0) wet++;
        if (sample.soilWater > 0) soilCells++;
      }
    }
    return { stored, wet, soilCells, outlet: runoff.read(nx - 1, middle).outflow, budget: runoff.budget };
  }

  return { world, summary };
}

export function authoredInput([nx, nz], frame) {
  const span = (start, end) => Math.max(0, Math.min(frame, end) - start) / rate.num;
  const n = nx * nz;
  const wholeGroups = Math.floor(n / rates.length);
  const remainder = n % rates.length;
  const allRain = rates.reduce((sum, value, i) => sum + value * (wholeGroups + Number(i < remainder)), 0);
  return {
    rain: area * allRain * (span(rainStart, rainChange) + 0.5 * span(rainChange, rainStop)),
    melt: (area * n * meltRate * span(meltStart, meltStop)) / 1000,
    condensation: (area * n * condensationRate * span(condensationStart, condensationStop)) / 1000,
  };
}

export function equalBytes(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export async function runCatchment(grid, { shared, threads }) {
  using runoff = await RainfallRunoff.load({ ...setupRain(), threads });
  const { world, summary } = makeCatchment(runoff, grid, shared);
  try {
    const initial = world.takeSnapshot();
    const initialWork = runoff.workCounts();
    const initialCell = runoff.exportPorts(0)[0].cell;
    world.advance(14);
    const checkpoint = world.takeSnapshot();
    const wet = summary();
    const finalFrame = 39;
    const finish = () => {
      world.shiftOrigin(farCell);
      world.advance(finalFrame);
      return world.takeSnapshot();
    };
    const final = finish();
    const finalPort = runoff.exportPorts(finalFrame)[0].cell;
    const work = runoff.workCounts();
    const settled = summary();
    world.restoreSnapshot(checkpoint.bytes);
    const restoredPort = runoff.exportPorts(14)[0].cell;
    const replay = finish();
    return {
      initial,
      initialWork,
      initialCell,
      checkpoint,
      final,
      finalPort,
      restoredPort,
      work,
      settled,
      wet,
      authored: authoredInput(grid, finalFrame),
      replayWork: runoff.workCounts(),
      replayed: final.hash === replay.hash && equalBytes(final.bytes, replay.bytes),
    };
  } finally {
    world.remove('runoff');
  }
}
