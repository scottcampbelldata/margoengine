// The hull solver's coupling checks (docs/physics-framework.md, section 10): `HullSolver` before `RigidSolver`, a box hull on
// a regular wave, held to the harness (the same state at 24, 30 and 60 frames a second, a seek equal to a continuous run),
// the load reaching the hull it names, and a box let go above its draft heaving at the period its buoyancy gives it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { addedMassInfinite, GRAVITY, HullSolver, hullSections, SEA_WATER } from '../../dist/seakeeping.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { effectBothWays, frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();

/** A box hull of `size` (x, y, z), each face a 4 by 4 grid, wound outward. */
function boxMesh([sx, sy, sz]) {
  const h = [sx / 2, sy / 2, sz / 2],
    vertices = [],
    indices = [],
    n = 4;
  for (const [axis, sign] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [2, 1],
    [2, -1],
  ]) {
    const [u, v] = [0, 1, 2].filter((a) => a !== axis),
      first = vertices.length / 3;
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++) {
        const p = [0, 0, 0];
        p[axis] = sign * h[axis];
        p[u] = -h[u] + (2 * h[u] * i) / n;
        p[v] = -h[v] + (2 * h[v] * j) / n;
        vertices.push(...p);
      }
    const at = (i, j) => first + i * (n + 1) + j;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        for (const t of [
          [at(i, j), at(i + 1, j), at(i + 1, j + 1)],
          [at(i, j), at(i + 1, j + 1), at(i, j + 1)],
        ]) {
          const p = t.map((k) => vertices.slice(3 * k, 3 * k + 3)),
            e1 = [0, 1, 2].map((c) => p[1][c] - p[0][c]),
            e2 = [0, 1, 2].map((c) => p[2][c] - p[0][c]),
            nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          indices.push(...(nrm[axis] * sign > 0 ? t : [t[0], t[2], t[1]]));
        }
  }
  return { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
}

const [L, D, B, T] = [4, 1.5, 2, 0.5];
/** A 20 m wave of 0.2 m along x, in deep water. */
const k = (2 * Math.PI) / 20,
  w = Math.sqrt(GRAVITY * k),
  wave = {
    density: SEA_WATER,
    elevation: (x, _z, t) => 0.2 * Math.cos(k * x - w * t),
    pressure: (x, y, _z, t) => {
      const eta = 0.2 * Math.cos(k * x - w * t);
      return -SEA_WATER * GRAVITY * y + SEA_WATER * GRAVITY * 0.2 * Math.cos(k * x - w * t) * Math.exp(k * (y - eta));
    },
  };

/** Two box hulls of the mass that floats them at draft T, on `sea`; the solver loads hull `which` (both for 2, none for -1). */
function make(rate = { num: 24, den: 1 }, which = 2, sea = wave, options = {}) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
    mass = SEA_WATER * L * B * T,
    boxes = [0, 8].map((x) =>
      physics.addBody(null, {
        position: [x, D / 2 - T, 0],
        colliders: { shape: 'box', halfExtents: [L / 2, D / 2, B / 2], mass },
      }),
    ),
    mesh = boxMesh([L, D, B]),
    hulls = (which === 2 ? boxes : which < 0 ? [] : [boxes[which]]).map((b) => ({ row: b.row, mesh })),
    world = new PhysicsWorld({ rate }).add(new RigidSolver(), { physics });
  if (hulls.length) world.add(new HullSolver(), { hulls, sea, ...options }).couple(['hull', 'rigid'], 'staggered');
  return Object.assign(world, { boxes, physics });
}

test('HullSolver: the same state at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('HullSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
test('HullSolver: the load reaches the hull it names', () => {
  effectBothWays(
    (side) => make({ num: 24, den: 1 }, side),
    (world, side) => world.boxes[side].position[1],
  );
});

test('HullSolver: a box let go above its draft heaves at the period its buoyancy and the water it carries give it', () => {
  // A box of mass m on a waterplane of area A_wp: a restoring force rho g A_wp per metre of heave, and the water it carries,
  // its heave added mass a (from its sections, at infinite frequency), so a period of 2 pi sqrt((m + a) / (rho g A_wp))
  // (Journee and Massie, Offshore Hydromechanics, 2001, section 6.3). Without the added mass, 2 pi sqrt(m / (rho g A_wp)).
  // Let go 5 cm high, it oscillates about its draft.
  const still = { density: SEA_WATER, elevation: () => 0 },
    mass = SEA_WATER * L * B * T,
    added = addedMassInfinite(hullSections(boxMesh([L, D, B]), T - D / 2, 24), [0, 0, 0], SEA_WATER)[7];
  for (const [carry, expected] of [
    [true, 2 * Math.PI * Math.sqrt((mass + added) / (SEA_WATER * GRAVITY * L * B))],
    [false, 2 * Math.PI * Math.sqrt(mass / (SEA_WATER * GRAVITY * L * B))],
  ]) {
    const world = make({ num: 60, den: 1 }, 0, still, { addedMass: carry }),
      box = world.boxes[0];
    box.setPosition([0, D / 2 - T + 0.05, 0]);
    const rest = D / 2 - T,
      crossings = [];
    let last = box.position[1] - rest;
    for (let f = 1; f <= 600; f++) {
      world.advance(f);
      const now = box.position[1] - rest;
      if (last > 0 && now <= 0) crossings.push(f - now / (now - last));
      last = now;
    }
    const period = (crossings.at(-1) - crossings[0]) / (crossings.length - 1) / 60;
    assert.ok(crossings.length >= 3, `it oscillates: ${crossings.length} crossings`);
    assert.ok(
      Math.abs(period - expected) <= 0.02 * expected,
      `${carry ? 'with' : 'without'} its added mass: period ${period} s against ${expected} s`,
    );
  }
});
