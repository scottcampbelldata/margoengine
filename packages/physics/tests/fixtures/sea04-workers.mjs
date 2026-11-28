import { WAKE_HEIGHT_FIELD, WAKE_SOURCE_LAYOUT, WakeSolver } from '@margoengine/physics/sea';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const rate = { num: 60, den: 1 };
const start = [-890_100_110, -410_549_675, 638_332_201];
const shift = [219_059, -86_382, 37_273];
export const wakeCell = start.map((coordinate, axis) => coordinate - shift[axis]);
const sourceField = {
  name: 'sea04PressureVolume',
  kind: 'particleSet',
  quantity: 'seaSource',
  unit: 'SI',
  centring: 'particle',
};

export const wakeCases = {
  gravity: { cells: [18, 15], cellSize: 0.22, depth: 0.83 },
  current: {
    cells: [30, 25],
    cellSize: 0.045,
    depth: 0.17,
    current: [0.23, -0.11],
    surfaceTension: 0.073,
    kinematicViscosity: 1.05e-6,
  },
};

export function expectedWakeWork(cells, threads) {
  const count = (cells[0] / 2 + 1) * cells[1];
  const workers = Array.from({ length: threads }, (_, part) => {
    const hi = Math.floor(((part + 1) * count) / threads);
    const lo = Math.min(hi, Math.max(1, Math.floor((part * count) / threads)));
    const modes = hi - lo;
    return { modes, pairedModes: modes };
  });
  return { threads, workers, modes: count - 1, pairedModes: count - 1 };
}

class MovingLoad {
  constructor(dx) {
    this.dx = dx;
  }

  describe() {
    return {
      id: 'sea04-moving-pressure',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: sourceField, access: 'write' }],
    };
  }

  init(host) {
    this.host = host;
    this.region = host.allocate(sourceField.name, 80, 'f64', WAKE_SOURCE_LAYOUT);
    this.step({ tick: 0 });
  }

  step({ tick }) {
    const dx = this.dx;
    regionWords(this.host.memory, this.region).set([
      dx * (0.37 + tick * 0.019),
      0.29 * dx,
      2.1 * dx,
      18 + (tick % 5),
      dx * dx * 0.0005,
      -1.36 * dx,
      dx * (1.39 + tick * 0.015),
      1.8 * dx,
      -9,
      -dx * dx * 0.00012,
    ]);
  }

  exportPorts(tick) {
    return [{ field: sourceField.name, region: this.region, cell: this.host.cell, tick }];
  }
  importPorts() {}
  stateRegions() {
    return [this.region];
  }
  extraState() {
    return [];
  }
}

export async function followWake(kind, threads = 1, shared = threads > 1, Wake = WakeSolver) {
  const params = wakeCases[kind];
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared), cellSize: 1024 });
  const wake = threads ? await Wake.load({ sourceField, threads }) : new Wake(undefined, sourceField);
  try {
    world.add(new MovingLoad(params.cellSize), {}, start);
    world.add(
      wake,
      {
        ...params,
        sponge: kind === 'gravity' ? 0 : 2,
        waterBelow: true,
        initial: (x, z) => [0.001 * Math.cos(x * 3.6 - z * 2.3), 0.003 * Math.sin(x * 1.1 + z * 2.7)],
      },
      start,
    );
    world.couple(['sea04-moving-pressure', 'wake'], 'staggered');
    world.advance(3);
    const checkpoint = world.takeSnapshot();

    function run() {
      world.shiftOrigin(shift);
      const work = [];
      for (let frame = 4; frame <= 10; frame++) {
        world.advance(frame);
        work.push(wake.readNativeWork?.());
      }
      const surface = world.fields.port(WAKE_HEIGHT_FIELD.name);
      const physical = {
        cell: Array.from(surface.cell),
        heights: wake.heights().slice(),
        potential: regionWords(world.memory, wake.stateRegions()[1]).slice(),
        sample: wake.sample(0.12, -0.07),
        below: wake.velocityAt(0.12, -0.07, -0.07),
      };
      return { physical, snapshot: world.takeSnapshot(), fft: wake.fftWork(), work };
    }
    const accepted = run();
    world.restoreSnapshot(checkpoint.bytes);
    return { accepted, replay: run() };
  } finally {
    wake[Symbol.dispose]?.();
  }
}
