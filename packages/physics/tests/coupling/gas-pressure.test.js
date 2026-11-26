import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { SoftBodies, SoftBodyDesc, SoftBodyMaterial } from '../../dist/soft.js';
import { PhysicsWorld, RigidSolver, SoftSolver } from '../../dist/world.js';
import { frameRateIndependent } from './harness.js';

await Physics.load();

async function scene(pressure = 108_000, rate = { num: 60, den: 1 }, ballHeight = 1.68) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] });
  const soft = await SoftBodies.attach(physics);
  const material = new SoftBodyMaterial();
  material.edgeSoftness = { naturalFrequency: 4, dampingRatio: 1 };
  material.bendSoftness = { naturalFrequency: 2, dampingRatio: 1 };
  const shell = soft.create(
    SoftBodyDesc.sphere([0, 1, 0], 0.5, { detail: 1 })
      .setParticleMass(0.06)
      .setParticleRadius(0.025)
      .setGravityScale(0)
      .setMaterial(material)
      .setGasPressure({ pressure }),
  );
  const ball = physics.addBody(null, {
    // The ball starts 5 mm beyond the sum of the 0.15 m radius and the 0.025 m particle skin.
    position: [0, ballHeight, 0],
    colliders: { shape: 'sphere', radius: 0.15, mass: 1 },
  });
  const world = new PhysicsWorld({ rate })
    .add(new RigidSolver(), { physics })
    .add(new SoftSolver(), { soft })
    .couple(['soft', 'rigid'], 'staggered');
  return { physics, soft, shell, ball, world };
}

test('sealed gas pushes a real rigid contact only after the membrane reaches it', async () => {
  const firm = await scene(),
    soft = await scene(101_325),
    separated = await scene(108_000, { num: 60, den: 1 }, 1.7);
  const start = firm.shell.gasState();
  const atRest = firm.ball.position[1];
  assert.equal(atRest, soft.ball.position[1]);
  firm.world.advance(1);
  assert.equal(firm.ball.position[1], atRest, 'pressure acts on the shell before it reaches the other body');
  firm.world.advance(20);
  soft.world.advance(20);
  const end = firm.shell.gasState();
  assert.ok(end.volume > start.volume, 'positive gauge pressure expands the membrane');
  assert.ok(end.pressure < start.pressure, 'isothermal gas pressure falls as its volume increases');
  assert.ok(
    Math.abs(end.pressure * end.volume - start.pressure * start.volume) <=
      Number.EPSILON * start.pressure * start.volume,
  );
  assert.equal(soft.ball.position[1], atRest, 'equal pressures do not bridge the air gap');
  assert.ok(firm.ball.position[1] > atRest, 'the gas shell transfers momentum through the rigid world port');
  separated.world.advance(20);
  const top = (body) => Math.max(...body.particlePositions().filter((_, i) => i % 3 === 1));
  assert.ok(top(firm.shell) < top(separated.shell), 'the rigid ball pushes back on the shell');
});

test('the SoftSolver gas state replays across frames and restores fill and ambient pressure', async () => {
  const rates = [24, 30, 60];
  const worlds = new Map();
  for (const fps of rates) worlds.set(fps, (await scene(108_000, { num: fps, den: 1 })).world);
  frameRateIndependent((rate) => worlds.get(rate.num), { rates });

  const { shell, world } = await scene();
  world.advance(9);
  const saved = world.takeSnapshot(),
    gas = shell.gasState();
  world.advance(19);
  const expected = world.hash();
  shell.setGasPressure({ pressure: 150_000, ambientPressure: 95_000 });
  assert.equal(shell.gasState().ambientPressure, 95_000);
  world.advance(24);
  world.restoreSnapshot(saved.bytes);
  assert.equal(world.hash(), saved.hash);
  assert.deepEqual(shell.gasState(), gas);
  world.advance(19);
  assert.equal(world.hash(), expected);
});

test('a missing triangle is rejected, and compacting bodies preserves each independent gas fill', async () => {
  const { soft, shell } = await scene();
  const sphere = SoftBodyDesc.sphere([0, 3, 0], 0.5, { detail: 0 });
  assert.throws(
    () =>
      soft.create(
        SoftBodyDesc.trimesh(sphere.positions, sphere.triangles.slice(0, -3)).setGasPressure({ pressure: 108_000 }),
      ),
    /closed surface/,
  );
  const another = soft.create(sphere.setGasPressure({ pressure: 111_000, ambientPressure: 90_000 }));
  const state = another.gasState();
  soft.remove(shell);
  assert.deepEqual(another.gasState(), state);
  assert.equal(another.gasState().ambientPressure, 90_000);
  assert.throws(() => another.setGasPressure({ pressure: 0 }), /positive finite absolute pressure/);
  assert.deepEqual(another.gasState(), state);
  another.setVolumeFactor(1);
  assert.equal(another.gasState(), null);
  another.setGasPressure({ pressure: 111_000 });
  assert.equal(another.gasState().ambientPressure, 101_325);
});
