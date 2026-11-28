import { FallingSolver } from '@margoengine/physics/falling';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { rainSphere } from '@margoengine/weather/precipitation';

const signedCell = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
export const rainCell = signedCell.map((index, axis) => index - shift[axis]);

export async function followRainFlight(count, threads, shared = threads > 1) {
  const id = 'signed-rain-flight';
  using rain = await FallingSolver.load({ id, rate: 0, threads });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared), cellSize: 4096 });
  const diameters = Float64Array.from({ length: count }, (_, i) => 0.00055 + (i % 13) * 0.00031);
  let added = false;
  const cell = () => (added ? world.cellOf(id) : [0, 0, 0]);
  const bodies = Array.from(diameters, (diameter, i) =>
    rainSphere({
      diameter,
      position: [(i % 19) * 0.23 - 2, i % 17 === 0 ? 0.055 : 5.4, Math.floor(i / 19) * 0.31],
      velocity: [0, -0.35, 0],
    }),
  );
  const wind = {
    medium: 'air',
    get cell() {
      return cell();
    },
    sample(x, y, z, time) {
      return { velocity: [3.5 + 0.25 * x + time, 0.18 * y, 0.16 * z - time], density: 1.15, temperature: 287 };
    },
  };
  const boundary = {
    get cell() {
      return cell();
    },
    sweep(center, displacement, radius) {
      if (displacement[1] >= 0 || center[1] + displacement[1] >= radius) return null;
      return { fraction: Math.max(0, (radius - center[1]) / displacement[1]), normal: [0, 1, 0] };
    },
  };
  world.add(rain, { bodies, wind, boundary }).setCell(id, signedCell);
  added = true;
  world.advance(4);
  const start = world.takeSnapshot();
  function run() {
    world.shiftOrigin(shift);
    const work = [];
    for (const frame of [8, 12, 16]) {
      world.advance(frame);
      work.push(rain.readNativeWork());
    }
    const port = world.fields.port(rain.poseField.name);
    const draw = new Float32Array(count * 8);
    rain.writeSpheres(draw);
    return {
      snapshot: world.takeSnapshot(),
      poses: regionWords(world.memory, port.region).slice(),
      draw,
      work,
      cell: Array.from(port.cell),
      grounded: rain.pose(0),
      small: rain.pose(13),
      large: rain.pose(12),
    };
  }
  const accepted = run();
  world.restoreSnapshot(start.bytes);
  return { accepted, replay: run(), count };
}
