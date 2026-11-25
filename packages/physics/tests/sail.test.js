// Sails and flags (AERO-02): a vortex lattice on the cloth's own grid gives a flat sail the lift slope of a wing of its
// aspect ratio, nothing at no incidence, the flat plate's force once stalled, and its thrust reaches what holds it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { SailForce, SoftBodies, SoftBodyDesc } from '../dist/soft.js';

await Physics.load();

const RHO = 1.2,
  SPEED = 10,
  CHORD = 1,
  SPAN = 6;

/**
 * A rigid flat sail (every particle pinned) of CHORD by SPAN metres in a wind along +x, its chord at `alpha` to the wind:
 * the load the lattice puts on it in one step.
 */
async function flatSail(alpha, chords = 5, spans = 13, options = {}) {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const soft = await SoftBodies.attach(physics),
    du = [(CHORD / (chords - 1)) * Math.cos(alpha), (-CHORD / (chords - 1)) * Math.sin(alpha), 0],
    dv = [0, 0, SPAN / (spans - 1)],
    body = soft.create(
      SoftBodyDesc.cloth([0, 0, 0], du, dv, chords, spans).setPinnedParticles(
        Array.from({ length: chords * spans }, (_, i) => i),
      ),
    );
  const sail = new SailForce(physics, body, { wind: [SPEED, 0, 0], grid: [chords, spans], density: RHO, ...options });
  physics.step();
  return { force: sail.force, sail, physics };
}

test("a flat sail's lift slope is that of a wing of its aspect ratio (Helmbold), and lift is across the wind", async () => {
  const alpha = (5 * Math.PI) / 180,
    { force } = await flatSail(alpha),
    q = 0.5 * RHO * SPEED * SPEED,
    cl = force[1] / (q * CHORD * SPAN),
    ar = SPAN / CHORD,
    helmbold = (2 * Math.PI * ar) / (2 + Math.sqrt(ar * ar + 4));
  assert.ok(
    Math.abs(cl / alpha - helmbold) / helmbold < 0.05,
    `lift slope ${cl / alpha} per radian against ${helmbold}`,
  );
  // Induced drag only: far smaller than the lift, and downwind.
  assert.ok(force[0] > 0 && force[0] < 0.2 * force[1], `drag ${force[0]} against lift ${force[1]}`);
  assert.ok(Math.abs(force[2]) < 1e-6 * force[1], 'no load along the span of a symmetric sail');
});

test('a sail edge on to the wind takes no load; twice the incidence nearly twice the lift', async () => {
  const zero = await flatSail(0);
  for (const f of zero.force) assert.ok(Math.abs(f) < 1e-9, `force ${zero.force}`);
  const small = await flatSail((3 * Math.PI) / 180),
    double = await flatSail((6 * Math.PI) / 180);
  assert.ok(Math.abs(double.force[1] / small.force[1] - 2) < 0.02, `ratio ${double.force[1] / small.force[1]}`);
});

test('past the stall angle a panel takes the flat-plate normal force', async () => {
  const alpha = Math.PI / 3,
    { force } = await flatSail(alpha),
    q = 0.5 * RHO * SPEED * SPEED,
    expected = 1.17 * Math.sin(alpha) * q * CHORD * SPAN,
    magnitude = Math.hypot(...force);
  assert.ok(Math.abs(magnitude - expected) / expected < 0.01, `force ${magnitude} against ${expected}`);
  // Along the sail's normal (sin a, cos a, 0), downwind.
  assert.ok(
    Math.abs(force[0] / magnitude - Math.sin(alpha)) < 1e-6 && Math.abs(force[1] / magnitude - Math.cos(alpha)) < 1e-6,
  );
});

test("a sail's load goes into the cloth whole: a free sail gains exactly the impulse of its load", async () => {
  // (A sail lashed to a hull hands the load on through the soft body's attachments; that coupling is
  // KB-SOFT-ATTACHKICK1 in docs/known-bugs.md, so the conservation is checked on a free sail.)
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const soft = await SoftBodies.attach(physics),
    chords = 4,
    spans = 7,
    alpha = (10 * Math.PI) / 180,
    body = soft.create(
      SoftBodyDesc.cloth(
        [0, 1, 0],
        [(1 / (chords - 1)) * Math.cos(alpha), (-1 / (chords - 1)) * Math.sin(alpha), 0],
        [0, 0, 1],
        chords,
        spans,
      ),
    ),
    sail = new SailForce(physics, body, { wind: [SPEED, 0, 0], grid: [chords, spans], density: RHO }),
    impulse = [0, 0, 0],
    dt = physics.fixedTimestep;
  for (let i = 0; i < 30; i++) {
    physics.step();
    for (let k = 0; k < 3; k++) impulse[k] += sail.force[k] * dt;
  }
  // Each step's load is applied as that step runs; the last one is counted above and landed in the velocities.
  const v = body.particleVelocities(),
    momentum = [0, 0, 0];
  for (let i = 0; i < body.numParticles(); i++)
    for (let k = 0; k < 3; k++) momentum[k] += body.masses[i] * v[3 * i + k];
  assert.ok(momentum[0] > 0, `the sail is pushed downwind: ${momentum}`);
  for (let k = 0; k < 3; k++)
    assert.ok(
      Math.abs(momentum[k] - impulse[k]) <= 1e-3 * Math.hypot(...impulse),
      `momentum ${momentum} against impulse ${impulse}`,
    );
});

test('the same wind and the same sail give the same bits', async () => {
  const a = await flatSail((7 * Math.PI) / 180),
    b = await flatSail((7 * Math.PI) / 180);
  assert.deepEqual(a.force, b.force);
  assert.deepEqual(Array.from(a.sail.circulation), Array.from(b.sail.circulation));
});
