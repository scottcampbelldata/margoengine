// Long range attachments for cloth and ropes (`SoftBodyDesc.setTethers`, Kim, Chentanez and Mueller 2012): each free particle
// is tied to its nearest pin by its distance through the body's structural edges, and is pulled back onto that sphere when it
// strays outside it. A sheet solved with one pass a step stretches under its own weight; with tethers it does not, a particle
// inside its sphere moves exactly as it would without one, and a tear or a pin change ties the particles again.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc } from '../dist/soft.js';

await Physics.load();

const NU = 11,
  NV = 51,
  SPACING = 0.2;
/** A sheet 2 m wide and 10 m long held flat along its top row, dropped to swing down: its worst stretch along the middle. */
async function swing(tethers) {
  const physics = new Physics(null),
    soft = await SoftBodies.attach(physics, { iterations: 1, substeps: 1 }),
    desc = SoftBodyDesc.cloth([0, 10, 0], [SPACING, 0, 0], [0, 0, SPACING], NU, NV)
      .setPinnedParticles([...Array(NU).keys()].map((i) => i * NV))
      .setAirDrag(false);
  if (tethers !== undefined) desc.setTethers(tethers);
  const body = soft.create(desc),
    top = body.particlePosition(5 * NV),
    length = (NV - 1) * SPACING;
  let worst = 0;
  for (let i = 0; i < 300; i++) {
    physics.step();
    const p = body.particlePosition(5 * NV + NV - 1);
    worst = Math.max(worst, Math.hypot(p[0] - top[0], p[1] - top[1], p[2] - top[2]) / length);
  }
  return { worst, body };
}

test('tethers hold a sheet solved with one pass a step to its length', async () => {
  const loose = await swing(undefined),
    tied = await swing(1),
    stretchy = await swing(1.05);
  assert.ok(loose.worst > 1.004, `without tethers the sheet stretches: ${loose.worst}`);
  assert.ok(tied.worst <= 1 + 1e-5, `tied, the far edge stays within its length: ${tied.worst}`);
  assert.ok(stretchy.worst <= 1.05 + 1e-5, `a 5% tether lets it stretch at most 5%: ${stretchy.worst}`);
  // Every free particle is tied; the pins are not.
  assert.equal(tied.body.tetheredParticles, NU * NV - NU);
  assert.equal(tied.body.tethers, 1);
  assert.equal(loose.body.tethers, null);
  assert.equal(loose.body.tetheredParticles, 0);
});

test('a particle inside its tether moves exactly as it would without one', async () => {
  const run = async (tethers) => {
    const physics = new Physics(null),
      soft = await SoftBodies.attach(physics),
      desc = SoftBodyDesc.rope([0, 10, 0], [6, 10, 0], 31).setParticleMass(0.05).setPinnedParticles([0]);
    if (tethers) desc.setTethers(1.2);
    const body = soft.create(desc);
    for (let i = 0; i < 240; i++) physics.step();
    return [...body.particlePositions()];
  };
  assert.deepEqual(await run(true), await run(false));
});

test('a tear and a pin change tie the particles again', async () => {
  const physics = new Physics(null),
    soft = await SoftBodies.attach(physics),
    body = soft.create(SoftBodyDesc.rope([0, 10, 0], [10, 10, 0], 11).setPinnedParticles([0]).setTethers());
  physics.step();
  assert.equal(body.tetheredParticles, 10);
  // Torn at its fifth edge: the five particles past the tear hang from nothing.
  body.tearEdge(4);
  physics.step();
  assert.equal(body.tetheredParticles, 4);
  // A second pin at the far end ties them to it.
  body.setParticlePinned(10, true);
  physics.step();
  assert.equal(body.tetheredParticles, 9);
  body.setTethers(null);
  physics.step();
  assert.equal(body.tetheredParticles, 0);
  body.setTethers(1.1);
  physics.step();
  assert.equal(body.tethers, 1.1);
  assert.equal(body.tetheredParticles, 9);
});

test('a tether must allow the rest distance at least', () => {
  assert.throws(() => SoftBodyDesc.rope([0, 0, 0], [1, 0, 0], 3).setTethers(0.9), RangeError);
  assert.throws(() => SoftBodyDesc.rope([0, 0, 0], [1, 0, 0], 3).setTethers(Number.NaN), RangeError);
});
