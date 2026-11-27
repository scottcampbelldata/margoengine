// The two solver tiers (PhysicsOptions.fidelity, DYN-01 point 1). A soft contact of frequency f under a load W on a body
// of mass m settles where its spring holds the load: a depth of W / (m (2 pi f)^2) past the allowed penetration. A light
// box under a heavy one carries the whole stack's weight on its own mass, so the depth grows with the mass ratio; the high
// tier's 480 Hz contacts (32 substeps) press it 16 times less than the standard tier's 120 Hz.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();
const G = 9.81;

/** A 0.5 m box on the floor under a 1 m box of `ratio` times its mass; how far the light box sinks after ten seconds. */
function sag(ratio, fidelity) {
  const physics = new Physics(null, { fidelity });
  physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [10, 0.5, 10] } });
  const light = physics.addBody(null, { position: [0, 0.25, 0], colliders: { shape: 'box', halfExtents: [0.25, 0.25, 0.25], density: 1 } });
  physics.addBody(null, { position: [0, 1, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], density: ratio / 8 } });
  for (let i = 0; i < 600; i++) physics.step();
  return { depth: 0.25 - light.position[1], physics };
}

test('each tier sinks a light box under a heavy one by the depth its contact frequency gives, the high tier 16 times less', () => {
  for (const [fidelity, hertz] of [
    ['standard', 120],
    ['high', 480],
  ])
    for (const ratio of [100, 1000]) {
      const { depth, physics } = sag(ratio, fidelity),
        slop = physics.kernel.solver.allowedPenetration,
        expected = slop + ((ratio + 1) * G) / (2 * Math.PI * hertz) ** 2;
      // The soft constraint is damped and solved in passes, so it rests within 10 percent of its spring's depth.
      assert.ok(Math.abs(depth - expected) <= 0.1 * expected, `${fidelity} 1:${ratio}: ${depth} m against ${expected} m`);
    }
  assert.ok(sag(1000, 'high').depth < 1.5e-3, 'a 1:1000 stack stands within 1.5 mm at the high tier');
});

test('the tier sets its substeps and contact frequency, leaves later settings alone, and refuses an unknown tier', () => {
  const high = new Physics(null, { fidelity: 'high' });
  assert.equal(high.fidelity, 'high');
  assert.equal(high.substeps, 32);
  assert.equal(high.kernel.solver.contactHertz, 480);
  assert.equal(new Physics(null, { fidelity: 'high', substeps: 16 }).substeps, 16);
  const standard = new Physics(null);
  assert.equal(standard.fidelity, 'standard');
  assert.equal(standard.substeps, 8);
  assert.throws(
    () => new Physics(null, { fidelity: 'ultra' }),
    (error) => error.name === 'MargoError' && error.code === 'unsupported' && /errors#physics-bodies/.test(error.message),
  );
});
