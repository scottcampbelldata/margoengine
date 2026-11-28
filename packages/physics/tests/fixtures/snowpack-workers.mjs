import { Snowpack } from '@margoengine/physics/snowpack';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const startCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const originShift = [4_100_000, -21_500_000, 17_300_000];
export const expectedCell = startCell.map((index, axis) => index - originShift[axis]);
export const layerCount = 5;

export async function followSnowpack(width, depth, threads, shared = threads > 1) {
  using pack = await Snowpack.load({ threads });
  const world = new PhysicsWorld({
    rate: { num: 60, den: 1 },
    memory: worldMemory(shared),
    cellSize: 4096,
  });
  const count = width * depth;
  const row = (sample) => Array.from({ length: count }, (_, i) => sample(i, i % width, Math.floor(i / width)));
  const wetColumn = (i) => i % 12 < 2;
  const freeze = 273.15;
  let attached = false;
  const wind = {
    medium: 'air',
    get cell() {
      return attached ? world.cellOf('snowpack') : [0, 0, 0];
    },
    sample(x, _y, z, time) {
      return { velocity: [8.9 + 0.14 * z + time, 0, -3.4 + 0.11 * x], density: 1.23, temperature: 269 };
    },
  };
  world
    .add(pack, {
      width,
      depth,
      cellSize: 0.8,
      origin: [-1.5, 2.25],
      ground: row((_, x, z) => 10 - 0.06 * x - 0.11 * z - (x > 3 ? 2 : 0)),
      snowfall: row((i) => 0.05 + (i % 4) * 0.03),
      rain: row((i) => (wetColumn(i) ? 0.9 : 0)),
      topHeat: row((i) => 180 + (i % 5) * 9),
      bottomHeat: 80,
      airTemperature: row((i) => (wetColumn(i) ? freeze - 4 : freeze - 7 + (i % 5) * 0.2)),
      freshDensity: 125,
      retention: 0.02,
      secondsPerSecond: 5,
      wind,
      layers: [
        { mass: row((i) => 13 + (i % 11)), density: 210, temperature: freeze - 2.4 },
        {
          mass: row((i) => 20 + (i % 3)),
          density: 330,
          temperature: row((i) => (wetColumn(i) ? freeze : freeze - 3.8)),
          liquidFraction: row((i) => (wetColumn(i) ? 0.17 : 0)),
        },
        { mass: row((i) => (i % 11 === 0 ? 0 : 22)), density: 285, temperature: freeze - 5 },
        { mass: 51, density: 400, temperature: freeze - 1 },
      ],
    })
    .setCell('snowpack', startCell);
  attached = true;
  world.advance(1);
  const baseline = world.takeSnapshot();

  function run() {
    world.shiftOrigin(originShift);
    const work = [];
    for (let frame = 2; frame <= 7; frame++) {
      world.advance(frame);
      work.push(pack.readNativeWork());
    }
    const fields = Object.fromEntries(
      pack.exportPorts(7).map(({ field }) => {
        const port = world.fields.port(field);
        return [field, { words: regionWords(world.memory, port.region).slice(), cell: Array.from(port.cell) }];
      }),
    );
    return {
      state: { snapshot: world.takeSnapshot(), fields, wet: pack.read(0, 0), cliff: pack.read(3, 1) },
      work,
    };
  }
  const accepted = run();
  world.restoreSnapshot(baseline.bytes);
  return { accepted, replay: run() };
}
