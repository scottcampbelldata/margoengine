// Fragment and shot hits (FIRE-05 into DYN-01, BREAK-01 and SEA-10): each fragment's path is cast against the rigid world;
// the first body it meets stops it there and takes its momentum through bodyImpulses, a breakable target takes it as an
// impact, and a hull plate it holes opens the hull's opening through the crush damage layout the hull solver reads.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ExplosionSolver, FRAGMENT_WORDS, HIT_WORDS } from '../../dist/explosive.js';
import { Physics } from '../../dist/index.js';
import { HULL_BREACH_WORDS, HULL_BREACHES_FIELD, HullSolver } from '../../dist/seakeeping.js';
import { PhysicsWorld, RigidSolver, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();
const zero = [0, 0, 0];
const charges = [{ position: [0, 0, 0], time: 0.02, mass: 1, case: { mass: 2, fragments: 200, dragCoefficient: 0 } }];

function boxWorld({ rate = { num: 60, den: 1 }, kernel = null, breakables } = {}) {
  const physics = new Physics(null, { gravity: zero, fixedTimestep: 1 / 60 });
  const box = physics.addBody(null, {
    position: [5, 0, 0],
    colliders: { shape: 'box', halfExtents: [1, 1, 1], mass: 100 },
  });
  const solver = kernel ?? new ExplosionSolver('blast', { carriers: true });
  const world = new PhysicsWorld({ rate, gravity: zero })
    .add(new RigidSolver(), { physics })
    .add(solver, { charges, physics, breakables })
    .couple(['blast', 'rigid'], 'staggered');
  return { physics, box, solver, world };
}

test('fragments that meet a box stop on its face and give it exactly their momentum', () => {
  const impacts = [];
  const { box, solver, world } = boxWorld({ breakables: { applyImpact: (p, j) => impacts.push([p, j]) } });
  world.advance(30);
  const hits = solver.hitRows(),
    f = solver.fragments();
  let count = 0;
  const momentum = [0, 0, 0];
  for (let i = 0; i < hits.length / HIT_WORDS; i++) {
    const h = i * HIT_WORDS;
    if (hits[h + 9] !== 1) continue;
    count++;
    assert.equal(hits[h + 7], box.row, 'the box was hit');
    assert.ok(Math.abs(hits[h] - 4) < 1e-6, `stopped on the face x = 4: ${hits[h]}`);
    assert.equal(f[i * FRAGMENT_WORDS + 7], 3, 'the fragment is stopped as hit');
    for (let k = 0; k < 3; k++) momentum[k] += hits[h + 6] * hits[h + 3 + k];
  }
  // A cylinder's 200 fragments fly round its axis; the box spans 2 atan(1/4) of the circle.
  assert.ok(count > 10 && count < 40, `${count} hits`);
  assert.equal(solver.counts.hits, count);
  const v = box.linearVelocity;
  assert.ok(Math.abs(v[0] * 100 - momentum[0]) < 1e-4 * momentum[0], `box ${v[0] * 100} against ${momentum[0]}`);
  // The breakable target took each hit as an impact of the fragment's momentum at its point.
  assert.equal(impacts.length, count);
  const sum = impacts.reduce((a, [, j]) => a + j[0], 0);
  assert.ok(Math.abs(sum - momentum[0]) < 1e-9 * momentum[0]);
});

test('the kernel finds the same hits as TypeScript, to the bit', async () => {
  const twin = boxWorld();
  const native = boxWorld({ kernel: await ExplosionSolver.load({ id: 'blast', carriers: true }) });
  twin.world.advance(30);
  native.world.advance(30);
  const bits = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  assert.ok(bits(twin.solver.hitRows()).equals(bits(native.solver.hitRows())));
  assert.ok(bits(twin.solver.fragments()).equals(bits(native.solver.fragments())));
});

test('the hits step the same at 24, 30 and 60 frames a second, and a snapshot re-runs them bit for bit', () => {
  frameRateIndependent((rate) => boxWorld({ rate }).world, { seconds: 1 });
  seekEqualsContinuous(() => boxWorld({ rate: { num: 24, den: 1 } }).world);
});

// A floating hull with one compartment and a bottom opening tied to plate 0; a small gun below it fires up into the plate.
function hullWorld(thickness) {
  const rate = { num: 60, den: 1 },
    gravity = [0, -9.81, 0];
  const world = new PhysicsWorld({ rate, gravity, memory: worldMemory(false) });
  const physics = new Physics(null, { arena: world.arena, gravity });
  const body = physics.addBody(null, {
    position: [0, 0.1, 0],
    colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], mass: 16 },
  });
  const corners = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  const mesh = {
    vertices: Float64Array.from(corners.flat().map((v) => v * 0.2)),
    indices: Uint32Array.from([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
    ]),
  };
  const blast = new ExplosionSolver('blast', { carriers: true, hullPlates: true });
  const hull = new HullSolver('hull', undefined, blast.damageField);
  const capacity = physics.kernel.capacity;
  world.add(new RigidSolver(), { physics, capacity });
  world.add(hull, {
    hulls: [
      {
        row: body.row,
        mesh,
        compartments: [{ mesh, permeability: 1 }],
        openings: [
          {
            from: 0,
            to: 'outside',
            centre: [0, -0.2, 0],
            normal: [0, -1, 0],
            width: 0.02,
            height: 0.02,
            discharge: 0.6,
            crushPatch: 0,
          },
        ],
      },
    ],
    sea: { density: 1000, elevation: () => 0, pressure: (_x, y) => Math.max(0, -9810 * y) },
    gravity,
    addedMass: false,
    radiation: false,
    greenWater: false,
    drag: false,
    rollDamping: false,
  });
  world.add(blast, {
    physics,
    guns: [
      {
        bore: 0.02,
        travel: 0.5,
        chamber: 2e-5,
        shotMass: 0.01,
        charge: 0.003,
        web: 3e-4,
        time: 0.05,
        breech: [0, -3, 0],
        axis: [0, 1, 0],
      },
    ],
    plates: [{ body: body.row, centre: [0, -0.2, 0], radius: 0.15, thickness }],
  });
  world.couple(['rigid', hull.id, blast.id], 'staggered');
  return { world, physics, body, blast };
}

test("a shot that holes a hull plate opens the hull's opening and the sea comes in; a thick plate keeps it shut", () => {
  const run = (thickness) => {
    const { world, physics, blast } = hullWorld(thickness);
    try {
      let inflow = 0;
      for (let frame = 1; frame <= 60; frame++) {
        world.advance(frame);
        const words = regionWords(world.memory, world.fields.port(HULL_BREACHES_FIELD.name).region);
        inflow = Math.min(inflow, words.slice(1, 1 + HULL_BREACH_WORDS)[9]);
      }
      return { plate: blast.plate(0), inflow, hits: blast.counts.hits };
    } finally {
      physics.dispose();
    }
  };
  const thin = run(0.002),
    thick = run(0.05);
  assert.equal(thin.hits, 1);
  assert.equal(thin.plate.hits, 1);
  assert.equal(thin.plate.sealLoss, 1, 'the shot punches through 2 mm');
  assert.ok(thin.inflow < 0, `the sea floods in: ${thin.inflow}`);
  assert.equal(thick.plate.hits, 1);
  assert.ok(thick.plate.sealLoss < 1, `a 50 mm plate holds: ${thick.plate.sealLoss}`);
  assert.equal(thick.inflow, 0, 'and the hull stays dry');
});

test('hits need what they act on, and say so', () => {
  const physics = new Physics(null, { gravity: zero, fixedTimestep: 1 / 60 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics });
  assert.throws(
    () => world.add(new ExplosionSolver('a'), { charges, breakables: { applyImpact() {} } }),
    /pass physics/,
  );
  assert.throws(
    () =>
      world.add(new ExplosionSolver('b'), {
        charges,
        physics,
        plates: [{ body: 0, centre: zero, radius: 1, thickness: 0.01 }],
      }),
    /hullPlates: true/,
  );
  assert.throws(() => world.add(new ExplosionSolver('c'), { charges, physics, breakables: {} }), /applyImpact/);
});
