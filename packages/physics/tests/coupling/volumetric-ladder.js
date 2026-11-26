import { Physics } from '../../dist/index.js';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '../../dist/soft.js';
import { PhysicsWorld, RigidSolver, SoftSolver } from '../../dist/world.js';

export async function ladder(rate = { num: 60, den: 1 }, { mass = 35, stiffness = 2e6, solver = 'vertex-block' } = {}) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 });
  const projective = solver === 'projective';
  const soft = await SoftBodies.attach(physics, { substeps: 4, iterations: projective ? 4 : 24 });
  const material = Object.assign(new CellMaterial(), {
    density: 650,
    youngsModulus: stiffness,
    poissonRatio: 0.23,
    elasticDampingRatio: 0.12,
    model: projective ? 'corotated' : 'neo-hookean',
  });
  const desc = SoftBodyDesc.box([-0.35, 0.84, -0.07], [0.7, 0.14, 0.14], [10, 2, 2], material);
  const fixed = [];
  let center = -1;
  for (let i = 0; i < desc.particleCount; i++) {
    const [x, y, z] = desc.positions.slice(i * 3, i * 3 + 3);
    if (Math.abs(x) > 0.34) fixed.push(i);
    if (Math.abs(x) < 1e-6 && y > 0.97 && Math.abs(z) < 1e-6) center = i;
  }
  const rung = soft.create(desc.setPinnedParticles(fixed).setSolver(solver));
  const boot =
    mass > 0 &&
    physics.addBody(null, {
      position: [0, 1.07, 0],
      colliders: { shape: 'box', halfExtents: [0.053, 0.06, 0.06], friction: 0.9, mass },
      linearDamping: 0.3,
      angularDamping: 0.4,
      lockRotations: true,
      enabledTranslations: [false, true, false],
    });
  const softSolver = new SoftSolver();
  const world = new PhysicsWorld({ rate })
    .add(new RigidSolver(), { physics })
    .add(softSolver, { soft })
    .couple(['soft', 'rigid'], 'staggered');
  const reading = () => {
    const [impulses, forces] = softSolver.exportPorts(0);
    const value = (port) =>
      new Float64Array(
        port.region.memory?.buffer ?? world.memory.buffer,
        port.region.byteOffset,
        port.region.byteLength / 8,
      )[boot.row * 6 + 1];
    return {
      y: rung.particlePosition(center)[1],
      speed: rung.particleVelocity(center)[1],
      bootHeight: boot ? boot.position[1] : 0,
      bootSpeed: boot ? boot.linearVelocity[1] : 0,
      support: boot ? value(forces) + 60 * value(impulses) : 0,
    };
  };
  return { world, physics, soft, rung, boot, center, fixed, reading };
}
