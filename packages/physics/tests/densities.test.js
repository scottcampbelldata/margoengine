// Material densities by name (DYN-06): a collider's density may be a material of `densities`, and a body's mass is that
// density times the shape's volume, the same as the number.
import assert from 'node:assert/strict';
import test from 'node:test';
import { densities, densityOf, Physics } from '../dist/index.js';

await Physics.load();

test('a named material gives the density of its number, at creation and through setDensity', () => {
  const physics = new Physics(null),
    r = 0.1,
    volume = (4 / 3) * Math.PI * r ** 3,
    ball = physics.addBody(null, { colliders: { shape: 'sphere', radius: r, density: 'steel' } });
  assert.equal(densities.steel, 7850);
  assert.ok(Math.abs(ball.mass - 7850 * volume) < 1e-6 * 7850 * volume, `steel ball ${ball.mass}`);
  ball.colliders[0].setDensity('oak');
  assert.ok(Math.abs(ball.mass - densities.oak * volume) < 1e-6 * densities.oak * volume, `oak ball ${ball.mass}`);
  assert.equal(densityOf(12), 12);
  assert.ok(Object.isFrozen(densities));
});

test('a material name that is not in densities is refused with a coded error that lists them', () => {
  const physics = new Physics(null),
    coded = (error) =>
      error.name === 'MargoError' &&
      error.code === 'unsupported' &&
      /steel/.test(error.message) &&
      /errors#physics-bodies/.test(error.message);
  assert.throws(
    () => physics.addBody(null, { colliders: { shape: 'sphere', radius: 1, density: 'unobtainium' } }),
    coded,
  );
  assert.throws(() => densityOf('toString'), coded);
  assert.equal(physics.bodyCount, 0, 'a refused body leaves nothing behind');
});
