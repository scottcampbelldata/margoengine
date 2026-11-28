// The clouds' rain shafts (`@margoengine/sky/volumetric-clouds` `rain`) and `PrecipitationField` agree: the shafts'
// rain source is the field's, in still air the rate down the shaft is the field's sample, and in wind the shaft's
// trail is the field's drift law read at the median drop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrecipitationField } from '@margoengine/weather/precipitation';
import { VolumetricClouds, cloudRainRate, cloudRainFall } from '@margoengine/sky/volumetric-clouds';

const cells = [
  { x: 0, z: 0, radius: 700, rate: 25 },
  { x: 1500, z: -400, radius: 400, rate: 8 },
];

test('in still air the shaft rate is the PrecipitationField sample at every height', () => {
  const clouds = new VolumetricClouds({ bottom: 800, top: 1500, coverage: 0.9, wind: [0, 0], rain: { cells } }),
    field = new PrecipitationField({ source: clouds.rainSource(), base: 800, seaLevelTemperature: 300 });
  for (const [x, z] of [
    [0, 0],
    [600, 200],
    [1500, -400],
    [-2000, 900],
  ])
    for (const y of [0, 200, 700]) {
      const ours = cloudRainRate(clouds.options, x, y, z, 0),
        theirs = field.sample(x, y, z, 0).rate;
      assert.ok(Math.abs(ours - theirs) <= 1e-9 * Math.max(1, theirs), `${x},${y},${z}: ${ours} vs ${theirs}`);
    }
});

test('in wind the trail is the field source read (base - y) / fall seconds back and upwind', () => {
  const moving = cells.map((c) => ({ ...c, velocity: [6, 2] })),
    clouds = new VolumetricClouds({ bottom: 800, top: 1500, coverage: 0.9, wind: [15, -3], rain: { cells: moving } }),
    field = new PrecipitationField({
      cells: moving.map((c) => ({ centre: [c.x, c.z], radius: c.radius, rate: c.rate, velocity: c.velocity })),
      base: 800,
    }),
    fall = cloudRainFall(clouds.options);
  for (const [x, y, z, t] of [
    [400, 0, 100, 0],
    [900, 300, -200, 45],
    [-300, 650, 50, 120],
  ]) {
    const tau = (800 - y) / fall,
      theirs = field.sourceRate(x - 15 * tau, z + 3 * tau, t - tau),
      ours = cloudRainRate(clouds.options, x, y, z, t);
    assert.ok(Math.abs(ours - theirs) <= 1e-9 * Math.max(1, theirs), `${x},${y},${z},${t}: ${ours} vs ${theirs}`);
  }
});
