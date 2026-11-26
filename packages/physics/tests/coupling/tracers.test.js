// The tracers' coupling checks (SEA-15): `TracerSolver` held to the harness, the same plume at 24, 30 and 60 frames a second
// and a seek equal to a continuous run, with a breach leaking ore and a slick drifting in a current.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SpectralSea } from '../../dist/sea.js';
import { TracerSolver } from '../../dist/tracers.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const water = {
  medium: 'water',
  cell: [0, 0, 0],
  sample(_x, y, _z, t, out = { velocity: [0, 0, 0], density: 1025, temperature: 285 }) {
    out.velocity[0] = 0.3 + 0.1 * Math.sin(t);
    out.velocity[1] = 0;
    out.velocity[2] = 0.05 * y;
    return out;
  },
};

const make = (rate = { num: 24, den: 1 }) =>
  new PhysicsWorld({ rate }).add(new TracerSolver(), {
    water,
    capacity: 2000,
    sources: [
      { material: 'ironOre', position: (t) => [2 * t, -4, 0], rate: 30 },
      { material: 'oil', position: [0, 0, 3], rate: 20, stop: 0.5 },
    ],
  });

test('TracerSolver: the same plume at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('TracerSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));

test('SEA-15 a slick rides live wave height while dye follows submerged orbital flow across an origin cell', () => {
  const frequencies = new Float64Array([0.2, 0.4, 0.6]);
  const directions = new Float64Array([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]);
  const energy = new Float64Array(12);
  energy[4] = 0.25 / (0.2 * Math.PI);
  const sea = new SpectralSea({ waves: { frequencies, directions, energy, depth: Infinity, density: 1025 } });
  const tracer = new TracerSolver();
  const dt = 1 / 60;
  const cellSize = 128;
  const stillLevel = 1.25;
  let x = -cellSize;
  let z = 0;
  let dx = x;
  let dy = stillLevel - 2;
  let dz = z;
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, cellSize })
    .add(tracer, {
      sea,
      cellSize,
      waterLevel: stillLevel,
      sources: [
        { material: 'oil', position: [x, 0, z], rate: 60, stop: dt },
        { material: 'dye', position: [dx, dy, dz], rate: 60, stop: dt },
      ],
      horizontalDiffusivity: 0,
      verticalDiffusivity: 0,
    })
    .setCell('tracers', [1, 0, 0]);
  for (let step = 1; step <= 18; step++) {
    const time = step * dt;
    const { velocity } = sea.sample(x + cellSize, z, time);
    x += velocity[0] * dt;
    z += velocity[2] * dt;
    const y = stillLevel + sea.elevation(x + cellSize, z, time);
    const submerged = sea.water.sample(dx + cellSize, dy - stillLevel, dz, time).velocity;
    dx += submerged[0] * dt;
    dy += submerged[1] * dt;
    dz += submerged[2] * dt;
    world.advance(step);
    const particles = [...tracer.particlesOf()];
    assert.equal(particles.length, 2);
    assert.equal(particles[0].state, 'surface');
    assert.deepEqual(particles[0].position, [x, y, z]);
    assert.equal(particles[1].state, 'water');
    assert.deepEqual(particles[1].position, [dx, dy, dz]);
  }
  assert.notEqual(x, -cellSize);
  assert.equal(tracer.budget.surface, 1);
  assert.equal(tracer.budget.water, 1);
  const snapshot = world.takeSnapshot();
  world.advance(25);
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(25);
  assert.equal(world.hash(), hash);

  const depthSpeed = 2;
  const crest = sea.elevation(0, 0, dt);
  const reflection = new TracerSolver();
  const secondWorld = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(reflection, {
    sea,
    water: { ...water, sample: () => ({ velocity: [0, depthSpeed, 0], density: 1025, temperature: 285 }) },
    sources: [{ material: 'dye', position: [0, crest - dt, 0], rate: 60, stop: dt }],
    horizontalDiffusivity: 0,
    verticalDiffusivity: 0,
  });
  secondWorld.advance(1);
  const [parcel] = [...reflection.particlesOf()];
  assert.ok(Math.abs(parcel.position[1] - (crest - dt)) < 4 * Number.EPSILON);
  assert.equal(parcel.state, 'water');
});
