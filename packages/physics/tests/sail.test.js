// Sails and flags (AERO-02): a vortex lattice on the cloth's own grid gives a flat sail the lift slope of a wing of its
// aspect ratio, nothing at no incidence, the flat plate's force once stalled, and its thrust reaches what holds it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { FABRICS, SailForce, SoftBodies, SoftBodyDesc } from '../dist/soft.js';

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
  // (A sail lashed to a hull hands the load on through the soft body's attachments, whose own conservation is the
  // KB-SOFT-ATTACHKICK1 test in soft.test.js; here the sail is free.)
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

test('a sail of real sailcloth weight stays whole in the wind and gains exactly the impulse of its load', async () => {
  // The same free sail of 1 m by 6 m, now of sailcloth as measured (FABRICS.sailcloth, a few hundred grams a square metre)
  // for a second. The lattice's load leans on the cloth's own speed through the air (an aerodynamic damping whose time,
  // mass over rho A U times the lift slope, is a few milliseconds here, under a step); given whole at the start of each step
  // it was an explicit damping that the sail outran, and the sail flew apart within ten steps. Taken implicitly, the sail
  // stays a number and the load still goes in whole.
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
      ).setFabric(FABRICS.sailcloth),
    ),
    sail = new SailForce(physics, body, { wind: [SPEED, 0, 0], grid: [chords, spans], density: RHO }),
    impulse = [0, 0, 0],
    dt = physics.fixedTimestep;
  for (let i = 0; i < 60; i++) {
    physics.step();
    for (let k = 0; k < 3; k++) impulse[k] += sail.force[k] * dt;
    assert.ok(body.particlePositions().every(Number.isFinite), `step ${i}: the sail stays a number`);
  }
  const v = body.particleVelocities(),
    momentum = [0, 0, 0];
  for (let i = 0; i < body.numParticles(); i++)
    for (let k = 0; k < 3; k++) momentum[k] += body.masses[i] * v[3 * i + k];
  for (let k = 0; k < 3; k++)
    assert.ok(
      Math.abs(momentum[k] - impulse[k]) <= 1e-3 * Math.hypot(...impulse),
      `momentum ${momentum} against impulse ${impulse}`,
    );
});

/**
 * No gravity and no water: a 200 kg hull (a rigid box, the mast between left out) at `hullY` with a 1 m by 6 m sail of
 * sailcloth lashed to it by its leading column (the luff, seven particles tied to the hull by soft.attachParticle, two way),
 * 60 steps in a 10 m/s wind: the hull's and the sail's linear momentum and the summed impulse of the sail's load.
 */
async function lashedSail(hullY) {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const soft = await SoftBodies.attach(physics),
    chords = 4,
    spans = 7,
    alpha = (10 * Math.PI) / 180,
    hullMass = 200,
    body = soft.create(
      SoftBodyDesc.cloth(
        [0, 1, 0],
        [(1 / (chords - 1)) * Math.cos(alpha), (-1 / (chords - 1)) * Math.sin(alpha), 0],
        [0, 0, 1],
        chords,
        spans,
      ).setFabric(FABRICS.sailcloth),
    ),
    hull = physics.addBody(null, {
      position: [0, hullY, 3],
      colliders: { shape: 'box', halfExtents: [0.5, 0.25, 3.5], mass: hullMass },
    }),
    sail = new SailForce(physics, body, { wind: [SPEED, 0, 0], grid: [chords, spans], density: RHO }),
    impulse = [0, 0, 0],
    dt = physics.fixedTimestep;
  for (let j = 0; j < spans; j++) body.attachParticle(j, hull); // particle (0, j): the luff
  for (let i = 0; i < 60; i++) {
    physics.step();
    for (let k = 0; k < 3; k++) impulse[k] += sail.force[k] * dt;
  }
  const v = body.particleVelocities(),
    momentum = [0, 1, 2].map((k) => {
      let sum = hullMass * hull.linearVelocity[k];
      for (let p = 0; p < body.numParticles(); p++) sum += body.masses[p] * v[3 * p + k];
      return sum;
    });
  return { momentum, impulse, hull: hullMass * hull.linearVelocity[0] };
}

test('a sail lashed along its luff to a free hull drives the hull: hull and sail gain exactly the impulse of the load (PA-29)', async () => {
  // Whatever the lattice puts on the sail goes through the lashings into the hull, so the hull moves downwind and the hull's
  // momentum plus the sail's equals the summed impulse of the sail's load (the attachments and edges are solved with the hull
  // as an unknown). The hull is below the sail, clear of its particles' contact radius.
  const { momentum, impulse, hull } = await lashedSail(-1);
  assert.ok(hull > 0, `the hull is driven downwind: ${hull}`);
  assert.ok(hull > 0.9 * momentum[0], 'the hull, not the sail, carries the momentum');
  // f32 velocities over 60 steps, as the free sail's bound.
  for (let k = 0; k < 3; k++)
    assert.ok(
      Math.abs(momentum[k] - impulse[k]) <= 1e-3 * Math.hypot(...impulse),
      `momentum ${momentum} against impulse ${impulse}`,
    );
});

test('a sail lashed to its hull and pressing on it keeps the momentum its contacts trade with the hull (KB-SOFT-LASHCONTACT1)', async () => {
  // The hull's top face 0.08 m under the sail's leech, inside the particles' contact radius: the sail lies on and is thrown
  // off the hull it is lashed to, so contacts, their friction and the lashings act on the hull in the same pieces. The
  // contact passes' friction used to move the particles alone (the hull never took its reaction), and a solve that took many
  // small steps lost the particles' moves below their f32 spacing while the hull was booked the whole of them: 1.3 percent
  // of the momentum went. Now both sides take every push, and the same f32 bound as the clear hull holds.
  const { momentum, impulse } = await lashedSail(0.5);
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

test("a sail's cloth takes its air loads from the sail alone: the cloths' default drag leaves a sail-equipped cloth, and returns when the sail is removed", async () => {
  // A free sail (pinned along its luff) in a wind, with SoftBodies.wind the same wind: with a SailForce attached, the cloth
  // steps to the same bits whether its default drag is on or off, so the air is counted once (the sail's). Once the sail is
  // removed, the default drag acts again.
  const run = async (airDrag, removeAt = Infinity) => {
    const physics = new Physics(null);
    physics.gravity = [0, 0, 0];
    const soft = await SoftBodies.attach(physics),
      chords = 5,
      spans = 7;
    soft.wind = [SPEED, 0, 0];
    const body = soft.create(
      SoftBodyDesc.cloth([0, 0, 0], [0.25 * Math.cos(0.2), -0.25 * Math.sin(0.2), 0], [0, 0, 0.5], chords, spans)
        .setPinnedParticles(Array.from({ length: spans }, (_, j) => j))
        .setAirDrag(airDrag),
    );
    const sail = new SailForce(physics, body, { wind: [SPEED, 0, 0], grid: [chords, spans], density: RHO });
    for (let i = 0; i < 30; i++) {
      if (i === removeAt) sail.remove();
      physics.step();
    }
    return body.particlePositions();
  };
  assert.deepEqual(await run(true), await run(false), 'the same bits with the default drag on or off');
  assert.notDeepEqual(await run(true, 10), await run(false, 10), 'without the sail the default drag acts');
});
