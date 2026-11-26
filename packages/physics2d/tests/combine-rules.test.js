// How a contact combines two colliders' friction and restitution (C2-12, Rapier's `CoefficientCombineRule`): the average by
// default, or the smaller, the product, the larger, the clamped sum or the geometric mean, set on a collider when it is made or after, the later rule of a pair
// winning; a rule that is not one of the six is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CoefficientCombineRule2D, Physics2D } from '../dist/index.js';

await Physics2D.load();

/** The rebound of a ball of restitution 0.8 dropped 2 m onto a floor of restitution 0, as a fraction of the drop. */
function rebound(rule, setAfter = false) {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 9.81] });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, 0.5],
    colliders: { shape: 'box', width: 20, height: 1, restitution: 0 },
  });
  const sprite = { x: 0, y: -2.25, rotation: 0 },
    ball = physics.addBody(sprite, {
      colliders: {
        shape: 'circle',
        radius: 0.25,
        restitution: 0.8,
        ...(setAfter || rule === undefined ? {} : { restitutionCombineRule: rule }),
      },
    });
  if (setAfter) ball.colliders[0].setRestitutionCombineRule(rule);
  let hit = false,
    peak = -Infinity;
  for (let i = 0; i < 240; i++) {
    physics.step();
    physics.sync(1);
    if (!hit && ball.linearVelocity[1] < 0) hit = true;
    if (hit) peak = Math.max(peak, -(sprite.y + 0.25));
  }
  physics.dispose();
  return peak / 2;
}

test('a ball bounces by the pair rule: the average by default, the larger by Max, none by Min or Multiply', () => {
  // e^2 of the drop comes back, e the pair's restitution: 0.4 by the average, 0.8 by the larger (within 0.85 to 1.05 of e^2).
  const average = rebound(undefined);
  assert.ok(average >= 0.85 * 0.16 && average <= 1.05 * 0.16, `average ${average}`);
  for (const after of [false, true]) {
    const max = rebound(CoefficientCombineRule2D.Max, after);
    assert.ok(max >= 0.85 * 0.64 && max <= 1.05 * 0.64, `max ${max}`);
    for (const rule of [CoefficientCombineRule2D.Min, CoefficientCombineRule2D.Multiply])
      assert.ok(rebound(rule, after) < 0.01, `rule ${rule}: no bounce`);
  }
});

test('the rules read back, and a rule that is not one of the six is refused', () => {
  const physics = new Physics2D(null, { pixelsPerMeter: 1 });
  const [c] = physics.addBody(null, {
    colliders: { shape: 'circle', radius: 0.5, frictionCombineRule: CoefficientCombineRule2D.Multiply },
  }).colliders;
  assert.equal(c.frictionCombineRule(), CoefficientCombineRule2D.Multiply);
  assert.equal(c.restitutionCombineRule(), CoefficientCombineRule2D.Average);
  c.setRestitutionCombineRule(CoefficientCombineRule2D.Min);
  assert.equal(c.restitutionCombineRule(), CoefficientCombineRule2D.Min);
  c.setFrictionCombineRule(CoefficientCombineRule2D.GeometricMean);
  assert.equal(c.frictionCombineRule(), CoefficientCombineRule2D.GeometricMean);
  assert.throws(() => c.setFrictionCombineRule(6), /combine rule/);
  assert.throws(
    () => physics.addBody(null, { colliders: { shape: 'circle', radius: 0.5, restitutionCombineRule: -1 } }),
    RangeError,
  );
  physics.dispose();
});
