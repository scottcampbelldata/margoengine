import { AirSolver } from '../../dist/flight.js';
import { Physics, WindForce } from '../../dist/index.js';
import { PhysicsWorld, regionWords, RigidSolver } from '../../dist/world.js';

function triangles(count) {
  const vertices = new Float32Array(count * 9);
  const indices = new Uint32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const y = (i % 65) / 64;
    const z = Math.floor(i / 65) / 64;
    vertices.set([0.2, y, z, 0.2, y, z + 1 / 128, 0.2, y + 1 / 128, z], 9 * i);
    indices.set([3 * i, 3 * i + 1, 3 * i + 2], 3 * i);
  }
  return { shape: 'trimesh', vertices, indices };
}

export async function tractionWorld(count, threads) {
  await Physics.load();
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] });
  try {
    const body = physics.addBody(null, {
      position: [0.25, -0.5, 1.25],
      rotation: [0, 0, 0.125, Math.sqrt(1 - 0.125 * 0.125)],
      linearVelocity: [-0.2, 0.05, 0.7],
      angularVelocity: [0.25, -0.125, 0.5],
      colliders: [{ shape: 'box', halfExtents: [0.125, 0.25, 0.375], mass: 10 }, triangles(count)],
    });
    const cell = [-955_121_884, 736_221_938, -804_221_539];
    let firstSample;
    const options = {
      frame: { cell, cellSize: 8 },
      velocity: {
        medium: 'air',
        cell: [cell[0] - 1, cell[1] + 1, cell[2] - 1],
        sample(x, y, z, time) {
          firstSample ??= [x, y, z];
          return {
            velocity: [8 + (y + 8) * 0.75, 1 + (x - 8) * 0.5, -0.5 + (z - 8) * 0.25 + time * 2],
            density: 1.125 + (z - 8) / 128,
            temperature: 280,
          };
        },
      },
    };
    const wind =
      threads === undefined ? new WindForce(physics, options) : await WindForce.create(physics, options, { threads });
    const air = new AirSolver();
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(new RigidSolver(), { physics })
      .add(air, { physics })
      .couple(['air', 'rigid'], 'staggered');
    function load(tick) {
      const { region } = air.exportPorts(tick)[0];
      return regionWords(region.memory ?? world.memory, region).slice(body.row * 6, 6 * (body.row + 1));
    }
    world.advance(2);
    const checkpoint = world.takeSnapshot();
    const first = load(2);
    world.advance(5);
    const accepted = world.takeSnapshot();
    const held = load(5);
    const counts = wind.workCounts();
    world.restoreSnapshot(checkpoint.bytes);
    world.advance(5);
    const replay = world.takeSnapshot();
    return { first, held, accepted, replay, replayHeld: load(5), counts, firstSample };
  } finally {
    physics.dispose();
  }
}
