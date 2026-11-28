import { BED_FIELD, TerrainBed } from '@margoengine/physics/earth';
import { LEGGED_LAYOUT, LEGGED_LOAD_FIELD, LeggedLocomotion } from '@margoengine/physics/legged';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const start = [1_015_000_000, -720_000_000, -890_000_000];
const shift = [13_430_000, -153_000, 1_835_000];
const rate = { num: 60, den: 1 };
const bed = { width: 18, depth: 20, columns: 17, rows: 19, centre: [0, 0] };
const speed = [1, 3.6, 3.1, 6.15];
const footCount = (row) => (row % 2 === 0 ? 2 : 4);
export const leggedCell = start.map((coordinate, axis) => coordinate - shift[axis]);
export const terrainHeight = (x, z) => 0.55 + 0.022 * x - 0.017 * z;

export function expectedLeggedWork(stance, threads) {
  const fields = ['bodies', 'contactRows', 'snakeLinks', 'feet', 'torsoRows', 'stanceRows', 'pairedContactDots'];
  const workers = Array.from({ length: threads }, (_, part) => {
    const from = Math.floor((part * stance.length) / threads);
    const to = Math.floor(((part + 1) * stance.length) / threads);
    const bodies = to - from;
    let feet = 0;
    let stanceRows = 0;
    for (let i = from; i < to; i++) {
      feet += footCount(i);
      stanceRows += stance[i];
    }
    return {
      bodies,
      contactRows: bodies + feet,
      snakeLinks: 0,
      feet,
      torsoRows: bodies,
      stanceRows,
      pairedContactDots: stanceRows,
    };
  });
  const sum = (field) => workers.reduce((total, worker) => total + worker[field], 0);
  return { threads, workers, ...Object.fromEntries(fields.map((field) => [field, sum(field)])) };
}

class CarriedForce {
  constructor(count, enabled) {
    this.count = count;
    this.enabled = enabled;
  }

  describe() {
    return {
      id: 'legged-carried-force',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: LEGGED_LOAD_FIELD, access: 'write' }],
    };
  }

  init(host) {
    this.host = host;
    this.region = host.allocate('legged-applied-force', 24 * this.count, 'f64', LEGGED_LAYOUT);
    this.step({ tick: 0 });
  }

  step({ tick }) {
    if (!this.enabled) return;
    const rows = regionWords(this.host.memory, this.region);
    for (let i = 0; i < this.count; i++) {
      rows[3 * i] = 5 * ((i % 9) - 4) + (tick % 5) * 7;
      rows[3 * i + 1] = -37 - (i % 7) * (5 + (tick % 3));
      rows[3 * i + 2] = 2 * ((i % 11) - 5);
    }
  }

  importPorts() {}
  exportPorts(tick) {
    return [{ field: LEGGED_LOAD_FIELD.name, region: this.region, cell: this.host.cell, tick }];
  }
  stateRegions() {
    return [this.region];
  }
  extraState() {
    return [];
  }
}

export async function followLegged(count, threads, shared = threads > 1, withLoad = true) {
  const cellSize = 1024;
  using legs = await LeggedLocomotion.load({ threads, bedShape: bed, cellSize, readLoad: true });
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared), cellSize });
  const bodies = Array.from({ length: count }, (_, i) => {
    const biped = footCount(i) === 2;
    const x = 0.55 * (i % 12) - 3;
    const z = 0.48 * Math.floor(i / 12) - 2.4;
    const legLength = (biped ? 0.9 : 1.08) + (i % 7) * 0.01;
    return {
      kind: biped ? 'biped' : 'quadruped',
      position: [x, terrainHeight(x, z) + legLength * 0.84, z],
      velocity: [0.03 * (i % 3), 0, speed[i % 4]],
      legLength,
      loadMass: 2 + (i % 11) * 1.2,
      target: { speed: speed[i % 4], heading: 0.06 * ((i % 8) - 3) },
    };
  });
  world
    .add(new TerrainBed(), { ...bed, elevations: terrainHeight }, start)
    .add(new CarriedForce(count, withLoad), {}, start)
    .add(legs, { bodies }, start);
  world.advance(2);
  const baseline = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const work = [];
    const stance = [];
    for (let frame = 3; frame <= 10; frame++) {
      world.advance(frame);
      work.push(legs.readNativeWork());
      stance.push(
        bodies.map((_, row) => {
          let grounded = 0;
          for (let foot = 0; foot <= footCount(row); foot++) grounded += Number(legs.readContact(row, foot).stance);
          return grounded;
        }),
      );
    }
    const ports = Object.fromEntries(
      [...legs.exportPorts(10).map(({ field }) => field), BED_FIELD.name, LEGGED_LOAD_FIELD.name].map((name) => {
        const port = world.fields.port(name);
        return [name, { words: regionWords(world.memory, port.region).slice(), cell: Array.from(port.cell) }];
      }),
    );
    return {
      state: {
        snapshot: world.takeSnapshot(),
        ports,
        poses: bodies.map((_, row) => legs.read(row)),
        feet: bodies.map((_, row) => Array.from({ length: footCount(row) }, (_, foot) => legs.readContact(row, foot))),
      },
      work,
      stance,
    };
  }
  const accepted = run();
  world.restoreSnapshot(baseline.bytes);
  return { accepted, replay: run() };
}
