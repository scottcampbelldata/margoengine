// The world's parameters and its readings on the own solver: the length unit, continuous collision switched off for the
// world, step timing, iterating what the step worked on, and user data on bodies and colliders.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RapierPhysics } from './oracle.js';
import { Physics } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const near = (actual, expected, bound, message) =>
  assert.ok(
    Math.abs(actual - expected) <= bound,
    `${message ?? 'value'}: ${actual} is not within ${bound} of ${expected}`,
  );
const steps = (physics, count) => {
  for (let i = 0; i < count; i++) physics.step();
};

/** A floor, a stack of three 1 unit boxes and a ball dropped on it, in `scale` units to the metre, masses the same. */
const scene = (scale) => {
  const physics = new Physics(null, { gravity: [0, -9.81 * scale, 0], lengthUnit: scale }),
    density = 1 / scale ** 3;
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5 * scale, 0],
    colliders: { shape: 'box', halfExtents: [20 * scale, 0.5 * scale, 20 * scale] },
  });
  const boxes = [0, 1, 2].map((i) =>
    physics.addBody(null, {
      position: [0, (0.5 + i * 1.02) * scale, 0],
      colliders: { shape: 'box', halfExtents: [0.5 * scale, 0.5 * scale, 0.5 * scale], density },
    }),
  );
  const ball = physics.addBody(null, {
    position: [0.2 * scale, 5 * scale, 0],
    colliders: { shape: 'sphere', radius: 0.3 * scale, density, restitution: 0.3 },
  });
  return { physics, boxes, ball };
};

test('a world in centimetres with a length unit of 100 plays out as the one in metres does', () => {
  const metres = scene(1),
    centimetres = scene(100);
  assert.equal(metres.physics.lengthUnit, 1);
  assert.equal(centimetres.physics.lengthUnit, 100);
  for (let i = 0; i < 180; i++) {
    metres.physics.step();
    centimetres.physics.step();
  }
  for (const [a, b] of [...metres.boxes.map((box, i) => [box, centimetres.boxes[i]]), [metres.ball, centimetres.ball]])
    for (let axis = 0; axis < 3; axis++)
      near(b.position[axis] / 100, a.position[axis], 1e-4, `the same place on axis ${axis}`);
  // The tolerances scale with it.
  near(centimetres.physics.predictionDistance, 100 * metres.physics.predictionDistance, 1e-4);
  near(centimetres.physics.solver.allowedPenetration, 100 * metres.physics.solver.allowedPenetration, 1e-6);
  near(centimetres.physics.solver.contactMaxPush, 100 * metres.physics.solver.contactMaxPush, 1e-4);
  metres.physics.dispose();
  centimetres.physics.dispose();
});

test('a length unit is a positive number, set before or after, and a later setSolver replaces what it set', () => {
  assert.throws(() => new Physics(null, { lengthUnit: 0 }), { name: 'RangeError', message: /lengthUnit.*above 0/ });
  const physics = new Physics(null);
  assert.throws(() => (physics.lengthUnit = -1), RangeError);
  assert.throws(() => (physics.lengthUnit = Number.NaN), RangeError);
  physics.lengthUnit = 0.001;
  near(physics.predictionDistance, 0.04 * 0.001, 1e-9);
  physics.lengthUnit = 1;
  near(physics.predictionDistance, 0.04, 1e-9, 'back to metres');
  physics.lengthUnit = 100;
  physics.setSolver({ allowedPenetration: 0.5 });
  near(physics.solver.allowedPenetration, 0.5, 1e-9);
  physics.dispose();
});

test('maxCcdSubsteps 0 turns continuous collision off for the world, whatever the bodies ask', () => {
  // 1,000 box bullets at 300 m/s, turning fast, at a wall 2 cm thick (the scene of next-ccd.test.js): how many pass it.
  const shoot = (substeps) => {
    let seed = 5;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    if (substeps !== undefined) physics.maxCcdSubsteps = substeps;
    physics.addBody(null, {
      type: 'fixed',
      position: [10, 0, 0],
      colliders: { shape: 'box', halfExtents: [0.01, 6, 6] },
    });
    const bodies = [];
    for (let i = 0; i < 1000; i++) {
      const q = [next() - 0.5, next() - 0.5, next() - 0.5, next() - 0.5],
        l = Math.hypot(...q);
      bodies.push(
        physics.addBody(null, {
          position: [next() * 4, next() * 8 - 4, next() * 8 - 4],
          rotation: q.map((v) => v / l),
          linearVelocity: [300, (next() - 0.5) * 30, (next() - 0.5) * 30],
          angularVelocity: [next() * 50, next() * 50, next() * 50],
          colliders: { shape: 'box', halfExtents: [0.02, 0.02, 0.06], density: 7800 },
          ccd: true,
        }),
      );
    }
    const was = bodies.map((body) => [...body.position]),
      through = new Set();
    for (let step = 0; step < 30; step++) {
      physics.step();
      bodies.forEach((body, i) => {
        const now = body.position,
          before = was[i];
        // Past the wall's far face, where it crossed the wall's 12 m square.
        if (before[0] < 10.01 && now[0] >= 10.01) {
          const t = (10.01 - before[0]) / (now[0] - before[0]);
          if (Math.abs(before[1] + t * (now[1] - before[1])) < 6 && Math.abs(before[2] + t * (now[2] - before[2])) < 6)
            through.add(i);
        }
        was[i] = [...now];
      });
    }
    physics.dispose();
    return through.size;
  };
  assert.equal(shoot(), 0, 'by default no bullet passes the thin wall');
  assert.equal(shoot(4), 0, 'more passes find nothing more');
  assert.ok(shoot(0) > 0, 'with CCD off for the world bullets that ask for it still pass');
  const physics = new Physics(null);
  assert.equal(physics.maxCcdSubsteps, 1);
  assert.throws(() => (physics.maxCcdSubsteps = -1), { name: 'RangeError', message: /use 0 to turn CCD off/ });
  assert.throws(() => (physics.maxCcdSubsteps = 1.5), RangeError);
  physics.maxCcdSubsteps = 0;
  const saved = physics.kernel.snapshot();
  physics.maxCcdSubsteps = 3;
  physics.kernel.restore(saved);
  assert.equal(physics.maxCcdSubsteps, 0, 'a snapshot holds it');
  physics.dispose();
});

test('the phases of a step are timed, add up to the step, and stay out of the hash', () => {
  const build = () => {
    const physics = new Physics(null);
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [30, 0.5, 30] },
    });
    for (let i = 0; i < 150; i++)
      physics.addBody(null, {
        position: [(i % 5) * 1.1, 0.5 + Math.floor(i / 25) * 1.05, (Math.floor(i / 5) % 5) * 1.1],
        colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
      });
    return physics;
  };
  const a = build(),
    b = build();
  assert.deepEqual(Object.values(a.timing), new Array(15).fill(0), 'nothing has run yet');
  steps(a, 30);
  steps(b, 30);
  const timing = a.timing,
    phases = ['begin', 'broad', 'narrow', 'islands', 'solver', 'ccd', 'events'],
    finer = ['assembly', 'resolution', 'update', 'writeback', 'ccdBroad', 'ccdToi', 'ccdSolver'];
  assert.deepEqual(Object.keys(timing), ['step', ...phases, ...finer]);
  for (const value of Object.values(timing)) assert.ok(Number.isFinite(value) && value >= 0);
  assert.ok(timing.step > 0, 'a step with a pile takes time');
  near(
    phases.reduce((sum, phase) => sum + timing[phase], 0),
    timing.step,
    timing.step * 1e-3 + 1e-6,
    'the phases tile the step',
  );
  assert.ok(timing.solver > timing.broad && timing.solver > timing.events, 'a pile is mostly solver');
  // The solver's own timers split the solver phase (what they leave out is the multibody and coupling bookkeeping between them).
  const inside = timing.assembly + timing.resolution + timing.update + timing.writeback;
  assert.ok(
    inside <= timing.solver * 1.001 + 1e-6 && inside >= timing.solver * 0.5,
    `the solver's parts: ${inside} of ${timing.solver}`,
  );
  assert.ok(timing.resolution > timing.assembly && timing.resolution > timing.writeback, 'a pile is mostly resolution');
  assert.ok(
    timing.ccdBroad + timing.ccdToi + timing.ccdSolver <= timing.ccd * 1.001 + 1e-6,
    'the sweep splits the ccd phase',
  );
  assert.equal(a.kernel.hash, b.kernel.hash, 'the same world hashes the same whatever the clock said');
  a.dispose();
  b.dispose();
});

test('forEachActiveBody visits what the last step worked on and leaves out sleepers and fixed bodies', () => {
  const physics = new Physics(null);
  const floor = physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [20, 0.5, 20] },
    }),
    falling = physics.addBody(null, { position: [0, 10, 0], colliders: { shape: 'sphere', radius: 0.5 } }),
    resting = physics.addBody(null, {
      position: [5, 0.5, 0],
      sleeping: true,
      colliders: { shape: 'sphere', radius: 0.5 },
    }),
    mover = physics.addBody(null, {
      type: 'kinematicVelocity',
      position: [-5, 5, 0],
      linearVelocity: [1, 0, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    });
  steps(physics, 2);
  const seen = [];
  physics.forEachActiveBody((body) => seen.push(body));
  assert.ok(seen.includes(falling), 'a falling body is active');
  assert.ok(seen.includes(mover), 'a moving kinematic body is active');
  assert.ok(!seen.includes(resting), 'a sleeper is not');
  assert.ok(!seen.includes(floor), 'a fixed body is not');
  assert.equal(seen.length, physics.kernel.awakeCount);
  // The list is taken first: a visitor may remove bodies.
  const visited = [];
  physics.forEachActiveBody((body) => {
    visited.push(body);
    if (body === falling) mover.remove();
  });
  assert.ok(visited.includes(falling));
  assert.ok(!visited.includes(mover) || visited.indexOf(mover) < visited.indexOf(falling), 'a removed body is skipped');
  steps(physics, 600);
  const later = [];
  physics.forEachActiveBody((body) => later.push(body));
  assert.deepEqual(later, [], 'when everything has settled and slept nothing is active');
  physics.dispose();
});

test('user data rides on bodies and colliders, as options and as properties', () => {
  const physics = new Physics(null),
    tag = { name: 'crate' },
    body = physics.addBody(null, {
      userData: tag,
      colliders: [
        { shape: 'sphere', radius: 0.5, userData: 'ball' },
        { shape: 'box', halfExtents: [0.1, 0.1, 0.1], offset: [2, 0, 0] },
      ],
    });
  assert.equal(body.userData, tag);
  assert.equal(body.colliders[0].userData, 'ball');
  assert.equal(body.colliders[1].userData, undefined, 'unset is undefined');
  body.colliders[1].userData = 42;
  body.userData = null;
  assert.equal(body.colliders[1].userData, 42);
  assert.equal(body.userData, null);
  const added = body.addCollider({ shape: 'sphere', radius: 0.2, userData: { added: true } });
  assert.deepEqual(added.userData, { added: true });
  // An event hands the same colliders back, so what was put on them is what an event handler finds.
  const other = physics.addBody(null, {
    position: [0, 0.9, 0],
    colliders: { shape: 'sphere', radius: 0.5, userData: 'other' },
  });
  const found = [];
  physics.on('contactstart', (event) => found.push([event.colliderA.userData, event.colliderB.userData]));
  steps(physics, 5);
  assert.ok(
    found.some((pair) => pair.includes('ball') && pair.includes('other')),
    `an event carries it (${found})`,
  );
  other.remove();
  physics.dispose();
});

test('the solver settings do what they say: stiffness, allowed depth, push-out speed, warm start, substeps and passes', () => {
  const rest = (setup) => {
    const physics = new Physics(null);
    setup?.(physics);
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [20, 0.5, 20] },
    });
    const box = physics.addBody(null, {
      position: [0, 0.6, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], density: 1000 },
    });
    steps(physics, 240);
    const depth = 0.5 - box.position[1];
    physics.dispose();
    return depth;
  };
  const normal = rest(),
    soft = rest((physics) => physics.setSolver({ contactHertz: 4, contactDamping: 1 })),
    loose = rest((physics) => physics.setSolver({ allowedPenetration: 0.03 })),
    cold = rest((physics) => physics.setSolver({ warmStart: 0 }));
  // A soft contact is a spring per kilogram of effective mass (Catto, "Soft Constraints", GDC 2011): at rest it gives by g over omega
  // squared past the allowed depth, whatever the mass, with omega = 2 pi f. The implicit scheme keeps the spring's own equilibrium, so
  // the resting depth is the allowed penetration plus that give: 0.0002 + 17.3 micrometres at the default 120 Hz.
  const give = (hertz) => 9.81 / (2 * Math.PI * hertz) ** 2;
  assert.ok(
    Math.abs(normal - (0.0002 + give(120))) < 0.02 * give(120),
    `a resting box sinks the allowed 0.0002 plus g / omega^2 = ${give(120)} (${normal})`,
  );
  assert.ok(soft > normal * 5 && soft > 0.005, `a soft contact lets it sink further (${soft} against ${normal})`);
  assert.ok(
    Math.abs(loose - (0.03 + give(120))) < 0.02 * give(120),
    `a depth left alone is not pushed out, and the box rests there plus g / omega^2 (${loose} against ${0.03 + give(120)})`,
  );
  // At the default damping ratio of 10 the depth falls 0.6 to 1.2 percent short of that value (KB-PHYS-SOFTGIVE1, open), so the two
  // checks above allow 2 percent of the give, which is under 0.4 micrometres.
  // At a damping ratio of 1 the resting depth meets the same value to float32 resolution of a position near 0.5 (a few 0.03
  // micrometres), at 60 Hz where the give is 69 micrometres.
  const unit = rest((physics) => physics.setSolver({ contactHertz: 60, contactDamping: 1, allowedPenetration: 0.03 }));
  assert.ok(
    Math.abs(unit - (0.03 + give(60))) < 2e-7,
    `at a damping ratio of 1 the box rests at the analytic depth (${unit} against ${0.03 + give(60)})`,
  );
  assert.ok(cold < 0.005, `a cold start still settles it (${cold})`);

  // How fast a depth is pushed out: two boxes started 0.5 m into each other leave no faster than the cap.
  const parting = (maxPush) => {
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    physics.setSolver({ contactMaxPush: maxPush });
    const a = physics.addBody(null, { position: [0, 0, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } }),
      b = physics.addBody(null, { position: [0.5, 0, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
    physics.step();
    const speed = (b.position[0] - a.position[0] - 0.5) * 60;
    physics.dispose();
    return speed;
  };
  near(parting(0.5), 0.5, 0.1, 'capped at 0.5 m/s');
  near(parting(3), 3, 0.5, 'and at 3 m/s');
  assert.throws(() => new Physics(null).setSolver({ contactHertz: -1 }), RangeError);
  assert.throws(() => new Physics(null).setSolver({ warmStart: 2 }), RangeError);

  // Substeps and passes: the world's name for Rapier's solver iterations and internal passes.
  const physics = new Physics(null);
  assert.equal(physics.substeps, 8);
  assert.equal(physics.iterations, 2);
  physics.substeps = 4;
  physics.iterations = 3;
  assert.equal(physics.kernel.substeps, 4);
  assert.equal(physics.kernel.iterations, 3);
  physics.dispose();
});

test('the work a step did is read as counts, the same for the same inputs, and a resting stack counts its contacts', async () => {
  const run = () => {
    const physics = new Physics(null);
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
    });
    for (let k = 0; k < 3; k++)
      physics.addBody(null, {
        position: [0, 0.5 + k * 1.0, 0],
        canSleep: false,
        colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
      });
    const before = physics.counts;
    for (let i = 0; i < 60; i++) physics.step();
    const counts = physics.counts;
    physics.dispose();
    return { before, counts };
  };
  const { before, counts } = run();
  assert.deepEqual(before.steps, 0);
  assert.equal(counts.steps, 60);
  assert.equal(counts.awake, 3, 'three boxes awake (the floor is fixed)');
  assert.equal(counts.pairsSolved, 3, 'floor and box, box and box twice');
  assert.equal(counts.contactsSolved, 12, 'four points each');
  assert.deepEqual(run().counts, counts, 'the same inputs, the same counts');
});
