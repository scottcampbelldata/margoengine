import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '@margoengine/physics';
import { TerrainBed } from '@margoengine/physics/earth';
import { ResistiveSoil } from '@margoengine/physics/terramechanics';
import { PhysicsWorld, RigidSolver, worldMemory } from '@margoengine/physics/world';

const dt = 1 / 60;
const terrain = { columns: 8, rows: 8, width: 0.24, depth: 0.22, centre: [0, 0] };
const close = (actual, expected, error) =>
  assert.ok(Math.abs(actual - expected) <= error, `${actual} vs ${expected}, bound ${error}`);

function semicircle() {
  const radius = 0.0381;
  const point = (angle) => [-radius * Math.sin(angle), -radius * (1 - Math.cos(angle)), 0];
  return Array.from({ length: 30 }, (_, i) => ({
    start: point((Math.PI * i) / 30),
    end: point((Math.PI * (i + 1)) / 30),
    width: 0.0254,
    samples: 1,
  }));
}

// Solid experimental traces from Li et al. Fig. S5 A and D, sampled at -π/2 through π/2 every π/8.
// The pressure coefficients are from separate thin-plate intrusion and extraction (their Table S2).
const media = [
  {
    name: 'loosely packed poppy seeds',
    coefficients: [51_000, 47_000, 53_000, 83_000, 20_000, -26_000, 57_000, 0, 25_000],
    peaks: [4.619, 9.357],
    peakError: 0.1,
    measured: [
      [0.359, 4.26],
      [0.781, 7.699],
      [2.617, 9.357],
      [4.44, 7.328],
      [4.2, 3.815],
      [2.388, 1.105],
      [0.603, 0.061],
      [0.081, 0.025],
      [0.028, 0.037],
    ],
  },
  {
    name: 'closely packed poppy seeds',
    coefficients: [94_000, 92_000, 92_000, 151_000, 35_000, -39_000, 86_000, 18_000, 46_000],
    peaks: [6.981, 15.175],
    peakError: 0.33,
    measured: [
      [0.62, 9.495],
      [2.031, 14.52],
      [5.679, 14.057],
      [6.936, 8.302],
      [4.667, 2.784],
      [1.779, 0.315],
      [0.323, -0.081],
      [0, 0],
      [0, 0],
    ],
  },
];

function setup(world, soil, physics, body, coefficients, strips) {
  const bed = new TerrainBed();
  world
    .add(bed, { ...terrain, elevations: () => 0 })
    .add(new RigidSolver(), { physics })
    .add(soil, { terrain, coefficients, bodies: [{ row: body.row, strips }] })
    .couple(['bed', 'rigid', soil.id], 'staggered');
  return bed;
}

for (const { name, coefficients, peaks, peakError, measured } of media) {
  test(`Li et al. held-out C-leg lift and thrust on ${name}`, async () => {
    await Physics.load();
    const soil = await ResistiveSoil.load();
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
    using physics = new Physics(null, { arena: world.arena, fixedTimestep: dt });
    const body = physics.addBody(null, { type: 'kinematicPosition', colliders: [], position: [0, 0.02, 0] });
    setup(world, soil, physics, body, coefficients, semicircle());
    const rotation = (theta) => [0, 0, -Math.sin(theta / 2), Math.cos(theta / 2)];
    let frame = 0;
    const force = (theta) => {
      // The independent rotary apparatus commanded only position and angular speed (0.2 rad/s).
      body.setRotation(rotation(theta - 0.2 * dt)).setNextRotation(rotation(theta));
      world.advance(++frame);
      return soil.read(body.row).force;
    };
    for (const theta of [(-3 * Math.PI) / 4, (3 * Math.PI) / 4]) assert.deepEqual(force(theta), [0, 0, 0]);
    const curve = Array.from({ length: 97 }, (_, i) => force(((i - 48) * Math.PI) / 64));
    for (let axis = 0; axis < 2; axis++) {
      const observedPeak = peaks[axis];
      // The author's 33% all-leg peak envelope, and 10% in four of five C-leg beds, are
      // model error bounds. 0.05 N is instrument precision; the PDF stroke adds up to 0.13 N.
      close(Math.max(...curve.map((load) => load[axis])), observedPeak, peakError * observedPeak + 0.18);
      for (const [phase, row] of measured.entries())
        close(curve[16 + phase * 8][axis], row[axis], 0.33 * observedPeak + 0.18);
    }
  });
}

test('a live soil strip transfers its integrated force and moment to a dynamic rigid body in both memories', async () => {
  await Physics.load({ threads: true });
  const hashes = [];
  for (const shared of [false, true]) {
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared) });
    const soil = await ResistiveSoil.load();
    using physics = new Physics(null, { arena: world.arena, fixedTimestep: dt, gravity: [0, 0, 0] });
    const body = physics.addBody(null, {
      type: 'dynamic',
      colliders: { shape: 'sphere', radius: 0.05, mass: 2 },
      linearVelocity: [0, -0.06, 0],
    });
    const strip = { start: [0.01, -0.1, 0], end: [0.11, -0.1, 0], width: 0.1, samples: 3 };
    const bed = setup(world, soil, physics, body, [1000, 0, 0, 0, 0, 0, 0, 0, 0], [strip]);
    world.advance(1);
    const { force, torque } = soil.read(body.row);
    const depth = 0.1 - body.position[1];
    close(force[1], 1000 * 0.1 * 0.1 * depth, 1e-14);
    close(torque[2], 0.06 * force[1], 1e-14);
    assert.equal(force[0], 0);
    assert.equal(force[2], 0);
    const before = body.linearVelocity[1];
    const snapshot = world.takeSnapshot();
    world.advance(2);
    close(body.linearVelocity[1] - before, (force[1] / 2) * dt, 2e-8);
    assert.ok(body.angularVelocity[2] > 0);
    assert.equal(bed.volume(), 0);
    const hash = world.hash();
    world.restoreSnapshot(snapshot.bytes);
    world.advance(2);
    assert.equal(world.hash(), hash);
    hashes.push(hash);
  }
  assert.equal(hashes[0], hashes[1]);
});
