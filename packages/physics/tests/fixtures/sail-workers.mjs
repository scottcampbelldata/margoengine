import { Physics } from '@margoengine/physics';
import { SailForce, SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';
import { PhysicsWorld, RigidSolver, worldMemory } from '@margoengine/physics/world';

const rate = { num: 60, den: 1 };
export const sailInitialCell = [-894_031_230, 508_862_100, -361_639_701];
const shift = [13_530, -251_300, 360_140];
export const sailCell = sailInitialCell.map((coordinate, axis) => coordinate - shift[axis]);

export async function sailWorkerWorld(panels, threads = 0, chord = 'u', differentWindCell = false) {
  await Physics.load();
  const world = new PhysicsWorld({ rate, cellSize: 1024, memory: worldMemory(false) });
  const physics = new Physics(null, { arena: world.arena, gravity: [0, 0, 0] });
  try {
    const hull = physics.addBody(null, {
      position: [0, 0.25, 0],
      linearVelocity: [0.24, 0, -0.025],
      colliders: { shape: 'box', halfExtents: [1.4, 0.25, 0.6], mass: 640 },
    });
    const soft = await SoftBodies.attach(physics);
    const [nc, ns] = panels;
    const chordwise = [1.35 / nc, -0.105 / nc, 0];
    const spanwise = [0, 0, 4.6 / ns];
    const grid = chord === 'u' ? [nc + 1, ns + 1] : [ns + 1, nc + 1];
    const edges = chord === 'u' ? [chordwise, spanwise] : [spanwise, chordwise];
    const cloth = soft.create(SoftBodyDesc.cloth([0.15, 1.85, -2.2], ...edges, ...grid));
    for (let s = 0; s <= ns; s++) cloth.attachParticle(chord === 'u' ? s : s * (nc + 1), hull);
    let invalid = false;
    let registered = false;
    const frame = {
      cellSize: world.cellSize,
      get cell() {
        return registered ? world.cellOf('rigid') : sailInitialCell;
      },
    };
    function sampleWind(z, time) {
      const rising = z > 0.15 && z < 1.75 ? 6.25 : 0.3;
      return [11.8 + z * 0.35, invalid && z > 1.75 ? Number.NaN : rising + time * 0.22, -0.15 + 0.03 * z];
    }
    const options = {
      grid,
      chord,
      ...(differentWindCell
        ? {
            frame,
            wind: {
              medium: 'air',
              get cell() {
                const [x, y, z] = frame.cell;
                return [x, y, z + 1];
              },
              sample(_x, _y, z, time) {
                return { velocity: sampleWind(z + frame.cellSize, time), density: 1.225, temperature: 288.15 };
              },
            },
          }
        : { wind: ([, , z], time) => sampleWind(z, time) }),
    };
    const sail = threads
      ? await SailForce.attachNative(physics, cloth, { ...options, threads })
      : new SailForce(physics, cloth, options);
    world.add(new RigidSolver(), { physics }, sailInitialCell);
    registered = true;
    return {
      world,
      physics,
      soft,
      cloth,
      sail,
      hull,
      setInvalid: (value) => {
        invalid = value;
      },
    };
  } catch (cause) {
    physics.dispose();
    throw cause;
  }
}

export function readSailPhysical({ sail, hull, cloth }) {
  return {
    force: Array.from(sail.force),
    circulation: sail.circulation.slice(),
    positions: cloth.particlePositions().slice(),
    velocities: cloth.particleVelocities().slice(),
    hullPosition: Array.from(hull.position),
    hullVelocity: Array.from(hull.linearVelocity),
    hullAngularVelocity: Array.from(hull.angularVelocity),
  };
}

export async function followSail(panels, threads = 0, chord = 'u', differentWindCell = false) {
  const fixture = await sailWorkerWorld(panels, threads, chord, differentWindCell);
  const { world, physics, soft, sail } = fixture;
  try {
    world.advance(2);
    const worldCheckpoint = world.takeSnapshot();
    const softCheckpoint = soft.takeSnapshot();

    function run() {
      world.shiftOrigin(shift);
      world.advance(7);
      return {
        physical: readSailPhysical(fixture),
        world: world.takeSnapshot(),
        cell: Array.from(world.cellOf('rigid')),
        work: sail.readNativeWork?.(),
      };
    }
    const accepted = run();
    soft.restoreSnapshot(softCheckpoint);
    world.restoreSnapshot(worldCheckpoint.bytes);
    const replay = run();
    return { accepted, replay };
  } finally {
    physics.dispose();
  }
}
