// A damaged hull's breaches (SEA-10) feeding the sea's tracers (SEA-15: the cargo it loses) and its foam (SEA-13: the boil
// of the air it lets out under water) through the `hullBreaches` port, held to the harness.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { bubblePlume, FoamSolver, surfaceCurrent, WASH_SPEED } from '../../dist/foam.js';
import { HULL_BREACH_WORDS, HULL_BREACHES_FIELD, HullSolver } from '../../dist/seakeeping.js';
import { TracerSolver } from '../../dist/tracers.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();

/** A box from corner a to corner b, twelve triangles wound outward. */
function cuboid([x0, y0, z0], [x1, y1, z1]) {
  return {
    vertices: [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1],
    indices: [
      0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ],
  };
}

/** A calm sea for the foam: a spectrum with no energy, so no breakers whiten it. */
const frequencies = new Float64Array(8).map((_, i) => 0.06 * 1.3 ** i),
  directions = new Float64Array(8).map((_, j) => (2 * Math.PI * j) / 8),
  calm = {
    cell: [0, 0, 0],
    sample: (_x, _z, out) =>
      out ?? { frequencies, directions, energy: new Float64Array(64), depth: Infinity, density: 1025 },
  };

/**
 * A 20 by 4 by 8 m barge floating at 2 m. Its forward hold (x 2 to 9) is holed low in its side, where the sea comes in,
 * and high in its side under the waterline, where its air bubbles out (the hold fills as fast as its air goes). Its aft
 * hold (x -9 to -2), half full of iron ore and flooded above the waterline, is holed low in its side: its water drains
 * out, and the ore with it. The tracers take the ore and the foam the air.
 */
function damaged(rate = { num: 60, den: 1 }) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
    body = physics.addBody(null, {
      colliders: { shape: 'box', halfExtents: [10, 2, 4], mass: 1025 * 20 * 8 * 2 },
    }),
    hull = new HullSolver(),
    tracers = new TracerSolver(),
    foam = new FoamSolver(),
    world = new PhysicsWorld({ rate })
      .add(new RigidSolver(), { physics })
      .add(hull, {
        hulls: [
          {
            row: body.row,
            mesh: cuboid([-10, -2, -4], [10, 2, 4]),
            compartments: [
              { mesh: cuboid([2, -1.8, -3.8], [9, 1.8, 3.8]) },
              {
                mesh: cuboid([-9, -1.8, -3.8], [-2, 1.8, 3.8]),
                permeability: 0.6,
                water: 0.6 * 7 * 7.6 * 2.8,
                cargo: { material: 'ironOre', mass: 7 * 7.6 * 1.6 * 0.6 * 5200 },
              },
            ],
            openings: [
              { from: 0, to: 'outside', centre: [5, -1.4, 4], normal: [0, 0, 1], width: 1, height: 0.6 },
              { from: 0, to: 'outside', centre: [5, -0.4, 4], normal: [0, 0, 1], width: 0.2, height: 0.2 },
              { from: 1, to: 'outside', centre: [-5, -1.4, 4], normal: [0, 0, 1], width: 1, height: 0.6 },
            ],
          },
        ],
        sea: { density: 1025, elevation: () => 0 },
        greenWater: false,
      })
      .add(tracers, { particleMass: 50, bed: 40 })
      .add(foam, { waves: calm, cells: [32, 32], cellSize: 1, statistics: 32 })
      .couple(['hull', 'rigid'], 'staggered');
  return Object.assign(world, { body, hull, tracers, foam });
}

/** The records of the hull's breaches now. */
function breaches(world) {
  const port = world.hull.exportPorts(0).find((p) => p.field === HULL_BREACHES_FIELD.name),
    words = new Float64Array(world.memory.buffer, port.region.byteOffset, port.region.byteLength / 8);
  return Array.from({ length: words[0] }, (_, k) =>
    words.subarray(1 + k * HULL_BREACH_WORDS, 1 + (k + 1) * HULL_BREACH_WORDS),
  );
}

test('a holed hull lets its air bubble up into a boil and its ore into the tracers, all it loses accounted', () => {
  const world = damaged();
  let lost = 0,
    boiled = false,
    // The foam steps before the hull (by id, uncoupled), so it paints the breaches the hull wrote a step before.
    before = null;
  for (let f = 1; f <= 60 * 30; f++) {
    world.advance(f);
    const [, high, aft] = breaches(world).map((r) => Float64Array.from(r));
    // The cargo out this step, as the tracers take it (the step's flux over its 1/60 s).
    lost += aft[12] / 60;
    const seen = before;
    before = high;
    if (seen && seen[10] > 0 && seen[14] > 0 && !boiled) {
      const high = seen;
      // Air going out under water: the boil whitens the water over the breach as its plume's surface current says.
      // (The foam's cells are 1 m about [0, 0]; the cell over the breach is white as the boil is at its centre.)
      const plume = bubblePlume(high[14], high[11], { source: Math.sqrt(high[8] / Math.PI) }),
        centre = (v) => Math.floor(v + 16) + 0.5 - 16,
        distance = Math.hypot(centre(high[2]) - high[2], centre(high[4]) - high[4]),
        expected = Math.min(1, surfaceCurrent(plume, distance).speed / WASH_SPEED);
      if (expected > 0.5) {
        assert.ok(
          world.foam.coverage(high[2], high[4]) >= expected * 0.99,
          `foam ${world.foam.coverage(high[2], high[4])} over the breach against ${expected}`,
        );
        boiled = true;
      }
    }
  }
  assert.ok(boiled, 'the air boiled up');
  assert.ok(lost > 100, `ore lost: ${lost} kg`);
  // The tracers released what the breach lost, less the remainder under one particle's mass.
  const { released } = world.tracers.budget;
  assert.ok(lost - released >= -1e-6 && lost - released < 50, `released ${released} kg of the ${lost} kg lost`);
});

test('hull, tracers and foam: the same state at 24, 30 and 60 frames a second', () =>
  frameRateIndependent(damaged, { seconds: 2 }));
test('hull, tracers and foam: a seek equals a continuous run', () =>
  seekEqualsContinuous(() => damaged({ num: 24, den: 1 })));
