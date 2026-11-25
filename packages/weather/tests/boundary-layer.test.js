// The boundary-layer wind (ATMO-01): the log-law mean profile, Mann gusts carried along by the mean wind, still air under the
// roughness, the standard atmosphere's density and temperature, and the Wind contract every solver samples.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryLayerWind, VON_KARMAN } from '../dist/boundary-layer.js';
import { MannBox } from '../dist/turbulence.js';

const small = () => new MannBox({ cells: [64, 16, 16], size: [1024, 256, 256] });

test('the mean wind follows the log law from the speed at the reference height', () => {
  const wind = new BoundaryLayerWind({ speed: 12, roughness: 0.03, turbulence: false });
  assert.ok(Math.abs(wind.meanSpeed(10) - 12) < 1e-12);
  assert.ok(Math.abs(wind.frictionVelocity - (VON_KARMAN * 12) / Math.log(10 / 0.03)) < 1e-12);
  assert.ok(Math.abs(wind.meanSpeed(80) / wind.meanSpeed(10) - Math.log(80 / 0.03) / Math.log(10 / 0.03)) < 1e-12);
  assert.equal(wind.meanSpeed(0.02), 0, 'still air under the roughness');
  // Over a smooth sea the same speed at 10 m gives a smaller friction velocity than over grass.
  assert.ok(new BoundaryLayerWind({ speed: 12, turbulence: false }).frictionVelocity < wind.frictionVelocity);
});

test('a sample is the Wind contract: velocity along the direction, the standard atmosphere, pure in place and time', () => {
  const wind = new BoundaryLayerWind({ speed: 10, direction: Math.PI / 2, turbulence: false, altitude: 1000 }),
    s = wind.sample(4, 10, -7, 3);
  assert.equal(wind.medium, 'air');
  assert.deepEqual(wind.cell, [0, 0, 0]);
  assert.ok(Math.abs(s.velocity[0]) < 1e-12 && Math.abs(s.velocity[2] - 10) < 1e-12 && s.velocity[1] === 0);
  // 1,010 m above sea level: the standard atmosphere's 281.585 K and 1.1106 kg/m^3.
  assert.ok(Math.abs(s.temperature - 281.585) < 1e-9 && Math.abs(s.density - 1.1106) < 1e-3);
  const out = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  assert.equal(wind.sample(1, 2, 3, 4, out), out, 'writes into out');
  assert.deepEqual(
    new BoundaryLayerWind({ turbulence: small() }).sample(30, 12, 8, 5),
    new BoundaryLayerWind({ turbulence: small() }).sample(30, 12, 8, 5),
  );
});

test('gusts are carried by the mean wind (frozen turbulence) and have the asked strength', () => {
  const box = small(),
    wind = new BoundaryLayerWind({ speed: 8, direction: 0.4, turbulence: box }),
    along = [Math.cos(0.4), Math.sin(0.4)],
    at = (s, t) => wind.sample(s * along[0], 12, s * along[1], t).velocity;
  // The gust at a point now reaches the point 20 m downwind 2.5 s later (8 m/s): the same bits.
  const a = at(0, 1),
    b = at(8 * 2.5, 3.5);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-12);
  // A box made by the wind takes the neutral surface layer's sigma_u = 2.5 u*.
  const gusty = new BoundaryLayerWind({ speed: 8, turbulence: { cells: [64, 16, 16], size: [1024, 256, 256] } });
  assert.ok(Math.abs(gusty.turbulence.sigma - 2.5 * gusty.frictionVelocity) < 1e-12);
  assert.equal(
    new BoundaryLayerWind({ turbulence: box }).sample(0, 0.0001, 0, 0).velocity.join(),
    '0,0,0',
    'still at the ground',
  );
  assert.throws(() => new BoundaryLayerWind({ roughness: 20 }), RangeError);
  assert.throws(() => new BoundaryLayerWind({ speed: -1 }), RangeError);
});
