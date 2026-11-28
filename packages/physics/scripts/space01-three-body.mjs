// Independent controls for the live OrbitSolver. The Lagrange equilateral
// orbit is exact; the Burrau observations below are a published numerical
// reference from Szebehely & Peters (1967), https://doi.org/10.1086/110355.
// Run after building Physics: node packages/physics/scripts/space01-three-body.mjs
import assert from 'node:assert/strict';
import { OrbitSolver } from '../dist/orbit.js';
import { PhysicsWorld } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const diff = (p, q) => p.map((value, i) => value - q[i]);
const norm = (p) => Math.hypot(...p);
const dot = (p, q) => p.reduce((sum, value, i) => sum + value * q[i], 0);
const elapsed = 2;

async function integrate(bodies, options) {
  const orbit = await OrbitSolver.load();
  const world = new PhysicsWorld({ rate }).add(orbit, { bodies, gravitationalConstant: 1, ...options });
  return { world, orbit };
}

function energy(bodies) {
  let total = 0;
  for (const [i, body] of bodies.entries()) {
    total += 0.5 * body.mass * dot(body.velocity, body.velocity);
    for (const other of bodies.slice(i + 1))
      total -= (body.mass * other.mass) / norm(diff(body.position, other.position));
  }
  return total;
}

async function triangle(substeps) {
  const edge = 4;
  const masses = [3, 4, 5];
  const mass = masses.reduce((a, b) => a + b);
  const vertices = [
    [0, 0, 0],
    [edge, 0, 0],
    [edge / 2, (edge * Math.sqrt(3)) / 2, 0],
  ];
  const centre = vertices[0].map((_value, j) => vertices.reduce((acc, v, i) => acc + v[j] * masses[i], 0) / mass);
  // For equal pair separations r, sum_j m_j(x_j-x_i)/r³ = -M x_i/r³
  // in the barycentric frame. Every vertex rotates at the same angular speed.
  const omega = Math.sqrt(mass / edge ** 3);
  const bodies = vertices.map((vertex, i) => {
    const position = diff(vertex, centre);
    return { position, velocity: [-omega * position[1], omega * position[0], 0], mass: masses[i] };
  });
  const { orbit, world } = await integrate(bodies, { substeps });
  world.advance(rate.num * elapsed);
  const phase = omega * elapsed;
  const exact = bodies.map(({ position: [x, y] }) => [
    x * Math.cos(phase) - y * Math.sin(phase),
    x * Math.sin(phase) + y * Math.cos(phase),
    0,
  ]);
  const accepted = bodies.map((_body, i) => orbit.sample(i));
  const maxPositionError = Math.max(...accepted.map(({ position }, i) => norm(diff(position, exact[i]))));
  const barycentreError = norm(
    centre.map((_value, i) => accepted.reduce((sum, body) => sum + body.mass * body.position[i], 0) / mass),
  );
  const roundoff = 32 * elapsed * rate.num * substeps * Number.EPSILON * edge;
  assert.ok(barycentreError <= roundoff, 'The unequal-mass barycentre must remain fixed.');
  return { substeps, maxPositionError, barycentreError, energyError: energy(accepted) - energy(bodies) };
}

const bodyCoordinates = [
  [1, 3, 0],
  [-2, -1, 0],
  [1, -1, 0],
];
const burrau = bodyCoordinates.map((position, i) => ({ position, velocity: [0, 0, 0], mass: i + 3 }));
const burrauApproaches = [
  // Table I prints time to .001 and marks these separations approximate.
  { time: 1.879, distance: 0.01, rounding: 0.005 },
  { time: 3.801, distance: 0.06, rounding: 0.005 },
  { time: 8.76, distance: 0.008, rounding: 0.0005 },
];

function pair(orbit) {
  const a = orbit.sample(1);
  const b = orbit.sample(2);
  return { position: diff(a.position, b.position), velocity: diff(a.velocity, b.velocity) };
}

function segment(a, b, interval, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return a.position.map(
    (value, i) =>
      (2 * t3 - 3 * t2 + 1) * value +
      (t3 - 2 * t2 + t) * interval * a.velocity[i] +
      (-2 * t3 + 3 * t2) * b.position[i] +
      (t3 - t2) * interval * b.velocity[i],
  );
}

async function firstApproaches(substeps) {
  const timeScale = 1 / 64;
  const interval = timeScale / rate.num;
  const { orbit, world } = await integrate(burrau, { timeScale, substeps });
  const comparisons = [];
  for (const observation of burrauApproaches) {
    const first = Math.floor((observation.time - 0.05) / interval);
    const last = Math.ceil((observation.time + 0.05) / interval);
    world.advance(first);
    let previous = pair(orbit);
    let predicted;
    for (let frame = first + 1; frame <= last; frame++) {
      world.advance(frame);
      const current = pair(orbit);
      if (dot(previous.position, previous.velocity) < 0 && dot(current.position, current.velocity) >= 0) {
        // The first radial turning point in this printed event window. Refine
        // the sampled positions with Hermite interpolation using accepted velocities.
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 40; i++) {
          const left = (2 * lo + hi) / 3;
          const right = (lo + 2 * hi) / 3;
          if (norm(segment(previous, current, interval, left)) < norm(segment(previous, current, interval, right)))
            hi = right;
          else lo = left;
        }
        const t = (lo + hi) / 2;
        predicted = { time: (frame - 1 + t) * interval, distance: norm(segment(previous, current, interval, t)) };
        break;
      }
      previous = current;
    }
    comparisons.push({
      observation,
      predicted: predicted ?? null,
      withinPrintedTime: predicted !== undefined && Math.abs(predicted.time - observation.time) <= 0.0005,
      withinPrintedDistance:
        predicted !== undefined && Math.abs(predicted.distance - observation.distance) <= observation.rounding,
    });
  }
  return {
    step: interval / substeps,
    energy: energy(burrau.map((_body, i) => orbit.sample(i))),
    comparisons,
  };
}

const lagrange = [await triangle(1), await triangle(2)];
const reduction = lagrange[0].maxPositionError / lagrange[1].maxPositionError;
// Fourth-order truncation dominates this short, regular trajectory.
assert.ok(reduction > 14 && reduction < 18, 'An exact step-halving check must recover fourth order.');
console.log(
  JSON.stringify(
    {
      lagrange: { runs: lagrange, reduction },
      burrau: {
        source: 'https://doi.org/10.1086/110355',
        scope:
          'Published numerical comparison through the first three close encounters of masses 4 and 5. The much closer encounter at t=15.83 and eventual escape remain open.',
        initialEnergy: energy(burrau),
        runs: [await firstApproaches(1), await firstApproaches(32)],
      },
    },
    null,
    2,
  ),
);
