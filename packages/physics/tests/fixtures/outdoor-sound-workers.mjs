import { OutdoorSound } from '../../dist/outdoor-sound.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const farCell = [-808_692_027, 911_420_619, -850_160_193];
const windCell = [farCell[0] - 1, farCell[1] + 1, farCell[2] - 1];
const shift = [0, 1, 0];
const id = 'worker-outdoor';

export async function outdoorWorkerWorld(count, threads) {
  const sound = threads === 0 ? new OutdoorSound(id) : await OutdoorSound.load({ id, threads });
  try {
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, cellSize: 512, memory: worldMemory(false) });
    let invalid = false;
    let registered = false;
    const params = {
      links: Array.from({ length: count }, (_, link) => {
        const z = link - Math.floor(count / 2);
        const height = link % 3 === 0 ? 85 : 18 + (link % 5);
        if (link === 0) return { source: [0, height, z], listener: [0, height, z] };
        return {
          source: (time) => [-123 + 0.2 * time, height, z],
          listener: (time) => [116 + (link % 7), height + 0.6 * time, z + 0.3 * (link % 8)],
        };
      }),
      cellSize: 512,
      intervals: 17,
      humidity: 0.68,
      groundReflection: 0.4,
      air: {
        medium: 'air',
        cell: windCell,
        sample(x, y, z, time, out) {
          const varying = z > 512;
          out.velocity = [0.3 + 0.1 * time, 0, -0.2];
          out.temperature = varying ? 293 + (x - 512) * 0.006 + (y + 512) * 0.01 : 287.15;
          out.density = invalid && z > 531 && x > 610 ? 0 : 1.2;
          return out;
        },
      },
      bed: {
        columns: 140,
        rows: 50,
        width: 420,
        depth: 150,
        centre: [0, 0],
        get cell() {
          return registered ? world.cellOf(sound.id) : farCell;
        },
        sample(x, _z, out) {
          out.elevation = Math.abs(x) < 7 ? 48 : 0;
          out.normal = [0, 1, 0];
          return out;
        },
      },
    };
    world.add(sound, params, farCell);
    registered = true;
    return {
      world,
      sound,
      fail: () => {
        invalid = true;
      },
      recover: () => {
        invalid = false;
      },
    };
  } catch (cause) {
    sound.dispose();
    throw cause;
  }
}

export async function outdoorSoundRun(count, threads) {
  const { world, sound } = await outdoorWorkerWorld(count, threads);
  try {
    const start = world.takeSnapshot();
    world.advance(2);
    const checkpoint = world.takeSnapshot();
    const field = () => {
      const { cell, region } = world.fields.port(sound.field.name);
      return { cell: [...cell], values: regionWords(region.memory ?? world.memory, region).slice() };
    };
    const finish = () => {
      world.shiftOrigin(shift);
      world.advance(6);
      return {
        snapshot: world.takeSnapshot(),
        field: field(),
        countBlocked: Array.from({ length: count }, (_, i) => sound.read(i)).filter(({ blocked }) => blocked).length,
        zeroLength: sound.read(0).distance,
        work: sound.workCounts(),
      };
    };
    const accepted = finish();
    world.restoreSnapshot(checkpoint.bytes);
    const restored = field().cell;
    const replay = finish();
    return { start, accepted, replay, restored, initial: farCell };
  } finally {
    sound.dispose();
  }
}
