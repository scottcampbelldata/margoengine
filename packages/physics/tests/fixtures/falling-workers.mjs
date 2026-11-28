import { FALLING_SPHERE_DRAW_WORDS, FallingSolver } from '@margoengine/physics/falling';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';

const cellStart = [1_170_000_000, -1_070_000_000, 2_000_000_000];
const shift = [4_100_000, -21_500_000, 17_300_000];
const cellSize = 4096;
export const expectedCell = cellStart.map((coordinate, axis) => coordinate - shift[axis]);

function bodiesFor(count) {
  return Array.from({ length: count }, (_, row) => {
    const kind = row % 3;
    const x = (row % 19) * 0.22 - 2;
    const z = Math.floor(row / 19) * 0.17;
    const altitude = 5.1 + (row % 11) * 0.12;
    if (kind === 0) {
      const chord = 0.1 + 0.007 * (row % 5);
      const span = 0.25;
      const mass = (row % 2 ? 1.1 : 1.4) * Math.PI * (chord * chord / 4) * span;
      return {
        kind: 'plate',
        chord,
        span,
        mass,
        position: [x, altitude, z],
        velocity: [0.21, -0.25, -0.1],
        spanDirection: [0.23, 0, 1],
        angle: 0.18 + (row % 7) * 0.04,
        angularVelocity: row % 2 ? -2.3 : 2.8,
      };
    }
    if (kind === 1) {
      const end = 0.0368;
      const mass = 0.0001;
      const strips = 5 + (row % 7);
      const hand = row % 2 ? 1 : -1;
      return {
        kind: 'samara',
        mass,
        spinInertia: (mass * end * end) / 10,
        position: [x, altitude, z],
        velocity: [0.02, -0.9, -0.13],
        angularVelocity: hand * (23 + (row % 13) * 2),
        sections: Array.from({ length: strips }, (_, i) => ({
          start: end * i / strips,
          end: end * (i + 1) / strips,
          chord: 0.0084,
          pitch: -hand * 7 * Math.PI / 180,
        })),
      };
    }
    const radius = 0.0032 + (row % 8) * 0.0005;
    return {
      kind: 'sphere',
      diameter: 2 * radius,
      mass: (4 / 3) * Math.PI * 890 * radius * radius * radius,
      position: [x, row % 17 === 2 ? 0.055 : altitude, z],
      velocity: [0.11, -0.45, 0.1],
      restitution: 0,
    };
  });
}

export async function followFalling(count, threads, shared = threads > 1) {
  using falling = await FallingSolver.load({ id: 'mixed-falling-flight', rate: 0, threads });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared), cellSize });
  const bodies = bodiesFor(count);
  let attached = false;
  const cell = () => (attached ? world.cellOf(falling.id) : cellStart);
  const wind = {
    medium: 'air',
    get cell() {
      const [x, y, z] = cell();
      return [x + 1, y, z];
    },
    sample(x, y, z, time) {
      return {
        velocity: [0.8 + 0.15 * (x + cellSize) + time, -0.11 - 0.05 * y, 0.21 - 0.08 * z],
        density: 1.21,
        temperature: 285 + 0.07 * y,
      };
    },
  };
  const boundary = {
    get cell() {
      return cell();
    },
    sweep(centre, displacement, radius) {
      if (displacement[1] >= 0 || centre[1] + displacement[1] >= radius) return null;
      return { fraction: Math.max(0, (radius - centre[1]) / displacement[1]), normal: [0, 1, 0] };
    },
  };
  world.add(falling, { bodies, wind, boundary, cellSize }, cellStart);
  attached = true;
  world.advance(2);
  const baseline = world.takeSnapshot();

  function run() {
    world.shiftOrigin(shift);
    const work = [];
    for (let frame = 3; frame <= 9; frame++) {
      world.advance(frame);
      work.push(falling.readNativeWork());
    }
    const port = world.fields.port(falling.poseField.name);
    const draw = new Float32Array(falling.sphereCount * FALLING_SPHERE_DRAW_WORDS);
    falling.writeSpheres(draw);
    return {
      state: {
        snapshot: world.takeSnapshot(),
        poses: regionWords(world.memory, port.region).slice(),
        cell: Array.from(port.cell),
        draw,
        plate: falling.pose(0),
        samara: falling.pose(1),
        grounded: falling.pose(2),
        groundedRadius: bodies[2].diameter * 0.5,
      },
      work,
    };
  }
  const accepted = run();
  world.restoreSnapshot(baseline.bytes);
  return { accepted, replay: run() };
}
