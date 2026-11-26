// The bubble plume of air escaping a hull under water and the boil it makes at the surface (`@margoengine/physics/foam`
// plume.ts): the integral plume against Morton, Taylor and Turner's exact far field, the surface flow against the
// conservation laws Fannelop and Sjoen built it on.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bubblePlume, PLUME_ENTRAINMENT, SURFACE_ENTRAINMENT, surfaceCurrent } from '../dist/foam.js';

const G = 9.81;

test('bubblePlume: with no slip and no expansion it grows into the pure plume of its buoyancy flux', () => {
  // Bubbles carried at the plume's speed with a constant volume flux Q_g make a pure plume of buoyancy flux F = g Q_g,
  // whose far field is b = beta (z + z0) and u = c (z + z0)^(-1/3), beta = 6 alpha / 5 and c = (3 F / (4 pi beta^2))^(1/3)
  // for top-hat profiles (Morton, Taylor and Turner 1956), whatever its source. So db/dz tends to beta and
  // u (b / beta)^(1/3) to c. Measured from 400 to 800 m over a 0.05 m source: within 1e-10 of both; a bound of 1e-8.
  const gas = 0.05,
    alpha = PLUME_ENTRAINMENT,
    beta = (6 * alpha) / 5,
    c = Math.cbrt((3 * G * gas) / (4 * Math.PI * beta * beta)),
    at = new Map();
  bubblePlume(800, gas, {
    slip: 0,
    expands: false,
    g: G,
    steps: 8000,
    visit: (z, b, u) => {
      if (Math.abs(z - 400) < 1e-6 || Math.abs(z - 800) < 1e-6) at.set(Math.round(z), [b, u]);
    },
  });
  const [b4, u4] = at.get(400),
    [b8, u8] = at.get(800),
    slope = (b8 - b4) / 400;
  assert.ok(Math.abs(slope / beta - 1) < 1e-8, `db/dz ${slope} against ${beta}`);
  for (const [b, u] of [
    [b4, u4],
    [b8, u8],
  ])
    assert.ok(
      Math.abs((u * Math.cbrt(b / beta)) / c - 1) < 1e-8,
      `u (b / beta)^(1/3) ${u * Math.cbrt(b / beta)} against ${c}`,
    );
});

test('bubblePlume: the gas is squeezed at depth, so its plume is weaker than one with its surface volume throughout', () => {
  // The same flow at the atmosphere's pressure let out at 50 m takes a sixth of the volume at the source and grows as it
  // rises: less buoyancy below than a plume holding the surface volume all the way, so it surfaces slower, though not
  // by half.
  const kept = bubblePlume(50, 0.1, { expands: false }),
    grown = bubblePlume(50, 0.1);
  assert.ok(grown.speed < kept.speed && grown.speed > 0.5 * kept.speed);
  assert.throws(() => bubblePlume(0, 0.1), /depth/);
  assert.throws(() => bubblePlume(10, -1), /gas rate/);
});

test('surfaceCurrent: the boil keeps the surfacing plume momentum and entrains beta V a unit area', () => {
  // Fannelop and Sjoen's radial flow V(r) exp(-z^2 / h^2): its mass flux m = pi^(3/2) rho h V r grows as
  // dm/dr = 2 pi rho beta V r and its momentum flux pi^(3/2) rho h V^2 r / sqrt(2) stays the plume's; at r_i = 2 b its
  // mass and momentum fluxes are the plume's.
  const plume = bubblePlume(20, 0.2),
    ri = 2 * plume.radius,
    mass = (r) => {
      const { speed, depth } = surfaceCurrent(plume, r);
      return Math.PI ** 1.5 * depth * speed * r;
    },
    momentum = (r) => {
      const { speed, depth } = surfaceCurrent(plume, r);
      return (Math.PI ** 1.5 * depth * speed * speed * r) / Math.SQRT2;
    };
  assert.ok(Math.abs(mass(ri) / plume.flux - 1) < 1e-12, 'the plume flux turns outward');
  assert.ok(Math.abs(momentum(ri) / (plume.flux * plume.speed) - 1) < 1e-12, "and the plume's momentum");
  for (const r of [ri * 1.5, ri * 4, ri * 20]) {
    const e = 1e-4 * r,
      grow = (mass(r + e) - mass(r - e)) / (2 * e),
      { speed } = surfaceCurrent(plume, r);
    assert.ok(Math.abs(grow / (2 * Math.PI * SURFACE_ENTRAINMENT * speed * r) - 1) < 1e-6, `entrainment at ${r} m`);
    assert.ok(Math.abs(momentum(r) / momentum(ri) - 1) < 1e-12, `momentum at ${r} m`);
  }
  // Far out it falls as 1 / r.
  const far = surfaceCurrent(plume, 1000 * ri).speed * 1000 * ri,
    farther = surfaceCurrent(plume, 2000 * ri).speed * 2000 * ri;
  assert.ok(Math.abs(far / farther - 1) < 1e-5);
});
