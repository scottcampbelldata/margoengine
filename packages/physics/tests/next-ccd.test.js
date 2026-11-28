// Continuous collision on the own solver: 1,000 bullets at 300 m/s, turning fast, at a wall 2 cm thick, a two-triangle
// mesh and a height field stood on end. With `ccd` no bullet's centre reaches the wall's middle plane, let alone its far
// face; without it some pass right through, so the scene can fail. Rapier 0.21 (the root entry, as a black box) runs the
// same shots for the record. The sweep itself is proved in kernel/tests/ccd.rs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RapierPhysics } from './oracle.js';
import { Physics } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const random = (seed) => () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const walls = {
  box: { shape: 'box', halfExtents: [0.01, 6, 6] },
  trimesh: {
    shape: 'trimesh',
    vertices: Float32Array.from([0, -6, -6, 0, 6, -6, 0, 6, 6, 0, -6, 6]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  },
  heightfield: { shape: 'heightfield', rows: 4, columns: 4, heights: new Float32Array(25), scale: [12, 1, 12] },
};
const bullets = {
  sphere: { shape: 'sphere', radius: 0.02 },
  box: { shape: 'box', halfExtents: [0.02, 0.02, 0.06] },
  capsule: { shape: 'capsule', radius: 0.02, halfHeight: 0.05 },
};
const s = Math.SQRT1_2;

/**
 * Of 1,000 bullets in 30 steps of 1/60 s, inside the wall's 12 m square: how many had their centre cross the wall's
 * middle plane x = 10 (`crossed`, deep in the wall), and how many had it past the wall's far face (`through`), where the
 * contacts push it out on the far side.
 */
const shoot = (World, wall, bullet, ccd) => {
  const physics = new World(null, { gravity: [0, 0, 0] }),
    next = random(5),
    bodies = [];
  // The height field's up axis is turned from y to -x, so it stands across x = 10 like the others.
  physics.addBody(null, {
    type: 'fixed',
    position: [10, 0, 0],
    rotation: wall.shape === 'heightfield' ? [0, 0, s, s] : [0, 0, 0, 1],
    colliders: wall,
  });
  for (let i = 0; i < 1000; i++) {
    const q = [next() - 0.5, next() - 0.5, next() - 0.5, next() - 0.5],
      l = Math.hypot(...q);
    bodies.push(
      physics.addBody(null, {
        position: [next() * 4, next() * 8 - 4, next() * 8 - 4],
        rotation: q.map((v) => v / l),
        linearVelocity: [300, (next() - 0.5) * 30, (next() - 0.5) * 30],
        angularVelocity: [next() * 50, next() * 50, next() * 50],
        colliders: { ...bullet, density: 7800 },
        ccd,
      }),
    );
  }
  const was = bodies.map((body) => [...body.position]),
    far = 10 + (wall.shape === 'box' ? wall.halfExtents[0] : 0),
    crossed = new Set(),
    through = new Set();
  for (let step = 0; step < 30; step++) {
    physics instanceof Physics ? physics.step() : physics.update(1 / 60);
    bodies.forEach((body, i) => {
      const now = body.position,
        before = was[i];
      for (const [plane, set] of [
        [10, crossed],
        [far, through],
      ])
        if (before[0] < plane && now[0] >= plane) {
          const t = (plane - before[0]) / (now[0] - before[0]);
          if (Math.abs(before[1] + t * (now[1] - before[1])) < 6 && Math.abs(before[2] + t * (now[2] - before[2])) < 6)
            set.add(i);
        }
      was[i] = [...now];
    });
  }
  physics.dispose();
  return { crossed: crossed.size, through: through.size };
};

test('1,000 bullets at 300 m/s never pass a thin wall, a mesh or a height field with ccd', () => {
  const record = [];
  for (const [wallName, wall] of Object.entries(walls))
    for (const [bulletName, bullet] of Object.entries(bullets)) {
      assert.deepEqual(
        shoot(Physics, wall, bullet, true),
        { crossed: 0, through: 0 },
        `${bulletName} through ${wallName}`,
      );
      const theirs = shoot(RapierPhysics, wall, bullet, true);
      record.push(`${bulletName} at ${wallName}: Rapier crossed ${theirs.crossed}, through ${theirs.through}`);
    }
  // Rapier's own count, for docs/rapier-parity.md CC-01; not a bar on the own solver.
  console.log(record.join('; '));
});

test('ccd stops bullets on a moving kinematic wall and on a free dynamic plate', () => {
  for (const type of ['kinematicVelocity', 'dynamic']) {
    const physics = new Physics(null, { gravity: [0, 0, 0] }),
      next = random(9),
      // A kinematic wall comes at the bullets at 20 m/s; a dynamic plate 2 cm thick floats free, heavy enough not to be
      // knocked aside before the last bullet arrives.
      wall = physics.addBody(null, {
        type,
        position: [10, 0, 0],
        linearVelocity: type === 'dynamic' ? [0, 0, 0] : [-20, 0, 0],
        colliders: { shape: 'box', halfExtents: [0.01, 6, 6], density: 1e7 },
      }),
      bodies = [];
    for (let i = 0; i < 200; i++)
      bodies.push(
        physics.addBody(null, {
          position: [next() * 4, next() * 8 - 4, next() * 8 - 4],
          linearVelocity: [300, 0, 0],
          angularVelocity: [next() * 50, next() * 50, next() * 50],
          colliders: { shape: 'box', halfExtents: [0.02, 0.02, 0.06], density: 7800 },
          ccd: true,
        }),
      );
    // A bullet fails when it crosses the wall's middle plane inside its face (6 m, plus the bullet's own reach). One that a
    // rebound sends round the wall's edge crosses the plane outside the face: no tunnel (at seed 9 one is knocked to 39 m/s
    // sideways and passes the dynamic plate's edge at 8.9 m).
    const reach = 6 + Math.hypot(0.02, 0.02, 0.06);
    let plane = wall.position[0],
      was = bodies.map((body) => [...body.position]);
    // Every bullet starts aimed at the face, so every one must strike it: be stopped (to under half its speed along the wall's
    // normal) in a step whose path, at the speed it came in with, reached the face, inside it. A bullet that strikes and
    // rebounds within the step is already back from the face when the step ends. Without this a test that missed the wall
    // would pass empty.
    const struck = new Set();
    let speeds = bodies.map((body) => body.linearVelocity[0] - wall.linearVelocity[0]);
    for (let step = 0; step < 20; step++) {
      physics.step();
      const now = wall.position[0];
      bodies.forEach((body, i) => {
        const p = body.position,
          before = was[i][0] - plane,
          after = p[0] - now;
        const v = body.linearVelocity[0] - wall.linearVelocity[0];
        if (
          v < 150 &&
          speeds[i] >= 150 &&
          before + speeds[i] * physics.fixedTimestep > -0.01 - Math.hypot(0.02, 0.02, 0.06) &&
          Math.abs(p[1] - wall.position[1]) < 6 &&
          Math.abs(p[2] - wall.position[2]) < 6
        )
          struck.add(i);
        if (after < 0) return;
        const t = before < 0 ? -before / (after - before) : 0,
          y = was[i][1] + (p[1] - was[i][1]) * t - wall.position[1],
          z = was[i][2] + (p[2] - was[i][2]) * t - wall.position[2];
        assert.ok(
          Math.abs(y) > reach || Math.abs(z) > reach,
          `${type} wall: bullet ${i} at step ${step} went through the wall's face at y ${y.toFixed(2)}, z ${z.toFixed(2)}`,
        );
      });
      plane = now;
      was = bodies.map((body) => [...body.position]);
      speeds = bodies.map((body) => body.linearVelocity[0] - wall.linearVelocity[0]);
    }
    assert.equal(struck.size, bodies.length, `${type} wall: only ${struck.size} of ${bodies.length} bullets struck its face`);
    physics.dispose();
  }
});

test('without ccd some bullets pass, so the scene can fail', () => {
  const passed = Object.values(walls).reduce((sum, wall) => sum + shoot(Physics, wall, bullets.box, false).through, 0);
  assert.ok(passed > 0, 'no bullet passed without ccd, so the ccd test proves nothing');
});

test('ccd on a slow body changes nothing, and ccdActive says when the pass checked a body', () => {
  const run = (ccd) => {
    const physics = new Physics(null);
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [50, 0.5, 50] },
    });
    const body = physics.addBody(null, {
        position: [0, 2, 0],
        rotation: [0.1, 0.2, 0.05, 0.97],
        linearVelocity: [2, 0, 0],
        colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
        ccd,
      }),
      poses = [];
    for (let i = 0; i < 240; i++) {
      physics.step();
      poses.push([...body.position, ...body.rotation]);
      assert.equal(body.ccdActive, false);
    }
    physics.dispose();
    return poses;
  };
  assert.deepEqual(run(true), run(false));
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    fast = physics.addBody(null, { linearVelocity: [300, 0, 0], colliders: { shape: 'sphere', radius: 0.05 } });
  assert.equal(fast.ccd, false);
  fast.ccd = true;
  assert.equal(fast.ccd, true);
  physics.step();
  assert.equal(fast.ccdActive, true);
  fast.setLinearVelocity([0, 0, 0]);
  physics.step();
  assert.equal(fast.ccdActive, false);
  fast.ccd = false;
  assert.equal(fast.ccd, false);
  physics.dispose();
});
