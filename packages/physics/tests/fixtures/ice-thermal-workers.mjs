import {
  ICE_FIELD_LAYOUT,
  ICE_HEAT_FIELD,
  ICE_TEMPERATURE_FIELD,
  ICE_VAPOUR_FIELD,
  IceSolver,
} from '@margoengine/physics/ice';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const startCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const iceCell = startCell.map((coordinate, axis) => coordinate - shift[axis]);
const rate = { num: 60, den: 1 };
const dt = 1 / 60;
const boilingMass = 0.000917;
const vapourFraction = 0.35;
const forcing = [ICE_HEAT_FIELD, ICE_TEMPERATURE_FIELD, ICE_VAPOUR_FIELD];
const solverOptions = { readHeat: true, readTemperature: true, readVapour: true };

const modes = [
  {
    site: { kind: 'sheet', thickness: 0.09, salinity: 27, snowThickness: 0.012, waterHeatFlux: -5 },
    thermal: [0, 268.5, 360],
  },
  { site: { kind: 'frost', thickness: 0.013 }, thermal: [0, 248, 470] },
  {
    site: { kind: 'icicle', radius: 0.008, length: 0.11, waterSupply: 5e-5 },
    thermal: [0, 255, 340],
  },
  {
    site: { kind: 'sheet', thickness: 0.11, waterHeatFlux: 46 },
    thermal: [230, 276.5, 520],
  },
  { site: { kind: 'frost', thickness: 0.019, density: 125 }, thermal: [140, 280, 600] },
  {
    site: { kind: 'icicle', radius: 0.011, length: 0.17, waterSupply: 4e-5 },
    thermal: [415, 280, 620],
  },
  {
    site: { kind: 'sheet', thickness: 1e-6 },
    thermal: [(boilingMass * (333500 + 4180 * 100 + vapourFraction * 2257000)) / dt, 273.15, 0],
  },
];

export function expectedIceWork(sites, threads) {
  const pairs = Math.floor(sites / 2);
  const workers = Array.from({ length: threads }, (_, part) => {
    const first = Math.floor((part * pairs) / threads);
    const end = Math.floor(((part + 1) * pairs) / threads);
    const pairedSites = 2 * (end - first);
    return { sites: pairedSites + (part === threads - 1 ? sites % 2 : 0), pairedSites };
  });
  return { threads, sites, pairedSites: pairs * 2, workers };
}

class Boundary {
  describe() {
    return {
      id: 'thermal-source',
      rate: 0,
      stableRate: () => 0,
      fields: forcing.map((field) => ({ field, access: 'write' })),
    };
  }

  init(host, rows) {
    this.host = host;
    this.regions = forcing.map(({ name }) => host.allocate(name, 8 * rows.length, 'f64', ICE_FIELD_LAYOUT));
    for (const [column, region] of this.regions.entries())
      regionWords(host.memory, region).set(rows.map((row) => row.thermal[column]));
  }

  step() {}

  importPorts() {}

  exportPorts(tick) {
    return this.regions.map((region, i) => ({ region, field: forcing[i].name, tick, cell: this.host.cell }));
  }

  stateRegions() {
    return this.regions;
  }

  extraState() {
    return [];
  }
}

export async function followIce(sites, threads, shared = threads > 1) {
  using ice = threads ? await IceSolver.load({ ...solverOptions, threads }) : new IceSolver(solverOptions);
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared), cellSize: 4096 });
  const rows = Array.from({ length: sites }, (_, i) => {
    const row = modes[i % modes.length];
    if (i < modes.length) return row;
    const variation = 1 + 0.013 * (i % 11);
    return {
      site: { ...row.site, area: (row.site.area ?? 1) * variation },
      thermal: [row.thermal[0] / variation, row.thermal[1], row.thermal[2]],
    };
  });
  world.add(new Boundary(), rows, startCell).add(ice, { sites: rows.map(({ site }) => site) }, startCell);
  world.advance(1);
  const first = Array.from({ length: Math.min(modes.length, sites) }, (_, i) => ice.sample(i));
  const checkpoint = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const work = [];
    for (let frame = 2; frame <= 8; frame++) {
      world.advance(frame);
      if (threads) work.push(ice.readNativeWork());
    }
    const ports = Object.fromEntries(
      ice.exportPorts(8).map(({ field }) => {
        const port = world.fields.port(field);
        return [field, { words: regionWords(world.memory, port.region).slice(), cell: Array.from(port.cell) }];
      }),
    );
    return {
      state: {
        first,
        snapshot: world.takeSnapshot(),
        ports,
        samples: rows.map((_, i) => ice.sample(i)),
      },
      work,
    };
  }

  const accepted = run();
  world.restoreSnapshot(checkpoint.bytes);
  return { accepted, replay: run() };
}

export function iceWaterMasses(first) {
  return {
    expectedSteam: boilingMass * vapourFraction,
    expectedDrainage: boilingMass * (1 - vapourFraction),
    steam: first[6].steam * dt,
    drainage: first[6].meltwater * dt,
  };
}
