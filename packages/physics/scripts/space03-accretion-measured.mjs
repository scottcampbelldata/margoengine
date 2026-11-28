// SPACE-03 observational scale comparison. Run from the repo root with
// node scripts/run-with-timeout.mjs --max=1 -- node packages/physics/scripts/space03-accretion-measured.mjs
//
// Inputs: GRAVITY Collaboration (2019), A&A 625 L10, Table 1 (noise-model fit).
// https://doi.org/10.1051/0004-6361/201935656
// Held-out observation: EHT Collaboration (2022), ApJL 930 L12, Paper I, 230 GHz emission ring.
// https://doi.org/10.3847/2041-8213/ac6674
// The emission ring includes the geometry and emissivity of the accreting plasma. Its diameter and the
// vacuum critical width are distinct observables. Paper IV explains the simulation-based mapping:
// https://doi.org/10.3847/2041-8213/ac6736
// No observed ring measurement or EHT-inferred mass enters the tracer. There is no observational pass threshold.

import assert from 'node:assert/strict';
import { KerrGeodesicSolver } from '../dist/accretion.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

const C = 299_792_458;
const G = 6.6743e-11;
const AU = 149_597_870_700;
const PARSEC = (648_000 * AU) / Math.PI;
const RAD_TO_MICROARCSECONDS = (648_000 / Math.PI) * 1e6;
const SOLAR_GM = 1.3271244e20; // IAU 2015 Resolution B3 nominal solar mass parameter.
const STELLAR = { solarMasses: 4_152_000, massStat: 14_000, parsecs: 8178, distanceStat: 13, distanceSys: 22 };
const EMISSION_RING = { diameter: 51.8, credibleHalfWidth68: 2.3 };
const RATE = { num: 60, den: 1 };

// Vacuum Kerr geodesics scale with M. Set one world tick to GM/c³ for the numerical experiment,
// then project the dimensionless asymptotic width using only the independently observed M/D.
const TRACER_MASS = C ** 3 / (G * RATE.num);
const TRACER_LENGTH = (G * TRACER_MASS) / C ** 2;
const INNER_OFFSET = 0.02; // Inside every sampled prograde photon radius; outside the coordinate horizon.
const LIMIT = 500;
const BISECTIONS = 24;

function angularUnit(solarMasses, parsecs) {
  return ((SOLAR_GM * solarMasses) / (C ** 2 * parsecs * PARSEC)) * RAD_TO_MICROARCSECONDS;
}

function plunges(spin, signedImpact, launch, maxPhaseStep) {
  const solver = new KerrGeodesicSolver({ maxPhaseStep });
  const world = new PhysicsWorld({ rate: RATE, memory: worldMemory(false) }).add(solver, {
    centralMass: TRACER_MASS,
    radius: launch,
    spin,
    energy: 1,
    axialAngularMomentum: signedImpact,
    carterConstant: 0,
    tracer: 'light',
    radialDirection: -1,
  });
  let entered = false;
  for (let tick = 1; tick <= LIMIT; tick++) {
    world.advance(tick);
    const { radius, horizonOffset, properTime } = solver.sample();
    assert.equal(properTime, 0);
    if (horizonOffset < INNER_OFFSET * TRACER_LENGTH) return true;
    if (radius < launch * TRACER_LENGTH) entered = true;
    else if (entered) return false;
  }
  throw new Error(`Unresolved Kerr ray at spin ${spin}, impact ${signedImpact}, launch radius ${launch}`);
}

function criticalImpact(spin, direction, launch, maxPhaseStep) {
  let capture = 0;
  let escape = 10;
  assert.equal(plunges(spin, direction * capture, launch, maxPhaseStep), true);
  assert.equal(plunges(spin, direction * escape, launch, maxPhaseStep), false);
  for (let pass = 0; pass < BISECTIONS; pass++) {
    const midpoint = (capture + escape) / 2;
    if (plunges(spin, direction * midpoint, launch, maxPhaseStep)) capture = midpoint;
    else escape = midpoint;
  }
  return { midpoint: (capture + escape) / 2, halfWidth: (escape - capture) / 2 };
}

// Edward Teo (2003), Gen. Relativ. Gravit. 35, 1909–1926, Eqs. (1) and (10).
// https://doi.org/10.1023/A:1026286607562
// At Q = 0 the double root of R/r requires |Lz/E|² = 3r² + a².
function exactCriticalImpact(spin, direction) {
  const r = 2 * (1 + Math.cos((2 / 3) * Math.acos(-direction * spin)));
  return Math.sqrt(3 * r * r + spin * spin);
}

const theta = angularUnit(STELLAR.solarMasses, STELLAR.parsecs);
const distanceAllowance = STELLAR.distanceStat + STELLAR.distanceSys;
const minTheta = angularUnit(STELLAR.solarMasses - STELLAR.massStat, STELLAR.parsecs + distanceAllowance);
const maxTheta = angularUnit(STELLAR.solarMasses + STELLAR.massStat, STELLAR.parsecs - distanceAllowance);
console.log(
  JSON.stringify({ measuredEmissionRingMicroarcseconds: EMISSION_RING, stellarAngularUnitMicroarcseconds: theta }),
);

for (const spin of [0, 0.5, 0.9]) {
  const sides = [1, -1].map((direction) => {
    const coarse = criticalImpact(spin, direction, 40, 1 / 1024);
    const fine = criticalImpact(spin, direction, 40, 1 / 2048);
    const far = criticalImpact(spin, direction, 80, 1 / 2048);
    const exact = exactCriticalImpact(spin, direction);
    return {
      direction,
      asymptoticBOverRg: exact,
      tracedBOverRg: fine.midpoint,
      analyticResidualOverRg: fine.midpoint - exact,
      bisectionHalfWidthOverRg: fine.halfWidth,
      phaseRefinementDeltaOverRg: fine.midpoint - coarse.midpoint,
      launchRefinementDeltaOverRg: far.midpoint - fine.midpoint,
    };
  });
  const width = sides.reduce((sum, side) => sum + side.tracedBOverRg, 0);
  const skyWidth = width * theta;
  console.log(
    JSON.stringify({
      equatorialSpin: spin,
      sides,
      vacuumCriticalWidthMicroarcseconds: skyWidth,
      // Rectangular sensitivity only. The mass and distance fits have covariance; these are no confidence limits.
      stellarInputCornerWidthsMicroarcseconds: [width * minTheta, width * maxTheta],
      emissionMinusVacuumWidthMicroarcseconds: EMISSION_RING.diameter - skyWidth,
    }),
  );
}
