import { AccretionDiskSolver } from '@margoengine/physics/accretion';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const start = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const accretionCell = start.map((value, axis) => value - shift[axis]);
const rate = { num: 60, den: 1 };
const feedField = {
  name: 'observedDiskFeed',
  kind: 'scalarSeries',
  quantity: 'diskMassSupply',
  unit: 'kg/s',
  centring: 'face',
};

export function expectedAccretionWork(n, threads) {
  const pairs = Math.floor(n / 2);
  const workers = Array.from({ length: threads }, (_, part) => {
    const from = 2 * Math.floor((part * pairs) / threads);
    const to = part === threads - 1 ? n : 2 * Math.floor(((part + 1) * pairs) / threads);
    const annuli = to - from;
    return { annuli, pairedAnnuli: annuli - (annuli % 2) };
  });
  return { threads, annuli: n, pairedAnnuli: 2 * pairs, workers };
}

class Feed {
  describe() {
    return {
      id: 'observed-disk-feed',
      fields: [{ field: feedField, access: 'write' }],
      rate: 0,
      stableRate: () => 0,
    };
  }

  init(host) {
    this.host = host;
    this.region = host.allocate('supplied-mass-rate', 8, 'f64', 1);
  }

  step({ tick }) {
    regionWords(this.host.memory, this.region)[0] = 0.7 + (tick % 3) * 0.26;
  }

  importPorts() {}

  exportPorts(tick) {
    return [{ field: feedField.name, region: this.region, cell: this.host.cell, tick }];
  }

  stateRegions() {
    return [this.region];
  }

  extraState() {
    return [];
  }
}

export async function followAccretion(n, threads, shared = threads > 1) {
  using disk = await AccretionDiskSolver.load({ threads, feedField });
  const edges = [1.7];
  for (let i = 0; i < n; i++) edges.push(edges.at(-1) + 0.027 + (i % 8) * 0.013);
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared), cellSize: 4096 });
  world.add(new Feed(), {}, start).add(
    disk,
    {
      edges,
      centralMass: 28000 / 6.6743e-11,
      viscosity: Array.from({ length: n }, (_, i) => 0.043 + (i % 17) / 230),
      initialDensity: Array.from({ length: n }, (_, i) => 0.35 + (i % 23) / 29),
      outerBoundary: 'zero-torque',
      feed: 0.1,
    },
    start,
  );
  world.advance(2);
  const checkpoint = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const before = disk.ring(0);
    const work = [];
    for (let frame = 3; frame <= 9; frame++) {
      world.advance(frame);
      work.push(disk.readNativeWork());
    }
    const ports = Object.fromEntries(
      disk.exportPorts(9).map(({ field }) => {
        const port = world.fields.port(field);
        return [field, { cell: Array.from(port.cell), words: regionWords(world.memory, port.region).slice() }];
      }),
    );
    return {
      state: {
        snapshot: world.takeSnapshot(),
        before,
        budget: disk.budget(),
        ports,
        rings: Array.from({ length: n }, (_, i) => disk.ring(i)),
      },
      work,
    };
  }
  const accepted = run();
  world.restoreSnapshot(checkpoint.bytes);
  return { accepted, replay: run() };
}
