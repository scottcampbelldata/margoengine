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
  // The gust reaches the point downwind after 2.5 s at the local speed at 12 m.
  const a = at(0, 1),
    b = at(wind.meanSpeed(12) * 2.5, 3.5);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-12);
  // A box made by the wind takes the neutral surface layer's sigma_u = 2.5 u*.
  const gusty = new BoundaryLayerWind({ speed: 8, turbulence: { cells: [64, 16, 16], size: [1024, 256, 256] } });
  assert.ok(Math.abs(gusty.turbulence.sigma - 2.5 * gusty.frictionVelocity) < 1e-12);
  assert.equal(
    new BoundaryLayerWind({ turbulence: box }).sample(0, 0.0001, 0, 0).velocity.join(),
    '0,0,0',
    'still at the ground',
  );
  assert.throws(() => new BoundaryLayerWind({ roughness: 20 }), {
    name: 'MargoError',
    code: 'state',
    message: /above the roughness length/,
  });
  assert.throws(() => new BoundaryLayerWind({ speed: -1 }), {
    name: 'MargoError',
    code: 'state',
    message: /pass a finite speed/,
  });
});

test('stable momentum and unstable similarity integrals agree with independent profiles', () => {
  const roughness = 0.03;
  const referenceHeight = 10;
  const speed = 10;
  const at = 80;
  const stableLength = 120;
  const stable = new BoundaryLayerWind({
    speed,
    referenceHeight,
    roughness,
    turbulence: false,
    obukhovLength: stableLength,
  });
  const stabilityEnergy = (z) => Math.log(z / roughness) + (5 * (z - roughness)) / stableLength;
  assert.ok(
    Math.abs(stable.meanSpeed(at) - (speed * stabilityEnergy(at)) / stabilityEnergy(referenceHeight)) <
      100 * Number.EPSILON,
  );

  const unstableLength = -30;
  const unstable = new BoundaryLayerWind({
    speed,
    referenceHeight,
    roughness,
    turbulence: false,
    obukhovLength: unstableLength,
  });
  // Simpson's rule in log-height coordinates, integrating Dyer's flux-gradient relation directly.
  function integrate(height) {
    const left = Math.log(roughness);
    const span = Math.log(height) - left;
    const cells = 4096;
    const cell = span / cells;
    const phi = (logHeight) => Math.pow(1 - (16 * Math.exp(logHeight)) / unstableLength, -0.25);
    let sum = phi(left) + phi(left + span);
    for (let i = 1; i < cells; i++) sum += (i % 2 ? 4 : 2) * phi(left + i * cell);
    // The absolute fourth derivative in log height is bounded by
    // sum(k=1..4) S(4,k) (1/4)_k < 12. Ordinary rounding is bounded by the positive reduction.
    return { value: (cell * sum) / 3, error: (12 * span * cell ** 4) / 180 + 2 * cells * Number.EPSILON * span };
  }
  const upper = integrate(at);
  const reference = integrate(referenceHeight);
  const predicted = (speed * upper.value) / reference.value;
  const bound = (speed * upper.error + predicted * reference.error) / (reference.value - reference.error);
  assert.ok(Math.abs(unstable.meanSpeed(at) - predicted) <= bound);
  assert.ok(unstable.meanSpeed(at) < stable.meanSpeed(at));
});

test('gusts taper to the roughness height and the top of the physical box without vertical repetition', () => {
  const roughness = 0.03;
  const wind = new BoundaryLayerWind({ roughness, turbulence: small() });
  const still = new BoundaryLayerWind({ roughness, turbulence: false });
  const sample = (height, time = 0) => wind.sample(3, height, 9, time);
  const near = roughness + 0.0001;
  assert.equal(sample(roughness).velocity[1], 0);
  const maxVertical = wind.turbulence.w.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
  const step = wind.turbulence.size[2] / wind.turbulence.cells[2];
  assert.ok(Math.abs(sample(near).velocity[1]) <= (maxVertical * (near - roughness)) / step);
  assert.ok(Math.abs(sample(256 - 0.001).velocity[1]) <= (maxVertical * 0.0010000001) / step);
  assert.deepEqual(sample(256), still.sample(3, 256, 9, 0));
  assert.deepEqual(sample(260, -3), still.sample(3, 260, 9, -3));
  assert.notEqual(sample(4).velocity[1], 0);
});

test('heading convention matches north at zero and finite malformed inputs leave a reusable sample intact', () => {
  const wind = new BoundaryLayerWind({
    directionConvention: 'heading',
    speed: 10,
    turbulence: false,
  });
  assert.deepEqual(wind.sample(3, 10, 9, -1).velocity, [0, 0, 10]);
  assert.deepEqual(wind.cell, [0, 0, 0]);
  const sample = wind.sample(3, 10, 9, 0);
  const previous = structuredClone(sample);
  assert.throws(() => wind.sample(NaN, 10, 9, 0, sample), {
    name: 'MargoError',
    code: 'state',
    message: /finite local metres/,
  });
  assert.deepEqual(sample, previous);
  assert.throws(() => new BoundaryLayerWind({ obukhovLength: 0 }), {
    name: 'MargoError',
    code: 'state',
    message: /signed nonzero metres/,
  });
  assert.throws(() => new BoundaryLayerWind({ turbulence: { cells: [0, 4, 4] } }), {
    name: 'MargoError',
    code: 'state',
    message: /supported cell counts/,
  });
  assert.throws(() => new BoundaryLayerWind({ seaLevelTemperature: 1 }), {
    name: 'MargoError',
    code: 'state',
    message: /kelvin above/,
  });
});
