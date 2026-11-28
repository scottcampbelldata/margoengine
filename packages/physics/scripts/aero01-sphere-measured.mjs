// Run with built Physics: node packages/physics/scripts/aero01-sphere-measured.mjs
// Independent smooth-sphere strain-gauge measurements:
// E. Achenbach (1972), J. Fluid Mech. 54, pp. 565–575, §§2–4 and Fig. 4.
// https://doi.org/10.1017/S0022112072000874
// Selected hollow marker centres were digitized in the original plot reproduced in Dupeux et al. (2011),
// Fig. 4(c), using the 1051×407 embedded grayscale image on printed p. 662 (PDF page 4):
// https://yakari.polytechnique.fr/Django-pub/documents/dupeux2011rp-3pp.pdf
// The heavy overlaid soccer-ball curve and Fig. 6's pressure/skin-friction integrations are excluded.
// The final reported Cd = 0.19 at Re = 6×10^6 is from Achenbach §3, p. 570, as a text cross-check.
// Hoerner, Fluid-Dynamic Drag (1965), Ch. II §6 and Ch. III §4, documents the conditions for using
// smooth-sphere data: transition changes with surface roughness and free-stream turbulence, and
// pressure drag changes with boundary-layer separation. Those controls are absent from WindForce.
// https://home.hvl.no/ansatte/gste/ftp/MarinLab_files/Litteratur/Hoerner_1965_Fluid-dynamic_drag.pdf
import assert from 'node:assert/strict';
import { Physics, WindForce } from '../dist/index.js';

const diameter = 0.2;
const referenceArea = Math.PI * (diameter / 2) ** 2;
const pressureSeriesBar = [1, 2.5, 5, 11, 21, 41];
const ambientK = 293.15;
const airGasConstant = 287.05;
const dynamicViscosity = 1.81e-5;
const instrumentMass = 10;
const plotErrorPixels = 3;
const pixelsPerCd = 321;
const markers = [
  ['subcritical', 713, 191.5],
  ['subcritical', 729, 181],
  ['subcritical', 771, 178],
  ['subcritical', 798, 182],
  ['transition', 827.5, 205],
  ['transition', 831.5, 253.5],
  ['transition', 835.5, 297.5],
  ['transition', 841.5, 325.5],
  ['supercritical', 867, 321.5],
  ['supercritical', 893, 313],
  ['supercritical', 904, 310.5],
  ['supercritical', 927, 296],
  ['high-Re recovery', 951.5, 291.5],
  ['high-Re recovery', 984, 287],
];

function readReynoldsNumber(x) {
  return 10 ** (4 + (3 * (x - 609)) / (1040.5 - 609));
}

function digitize([regime, x, y]) {
  const zeroY = 346.5 - (x - 609) / (1040.5 - 609);
  return {
    regime,
    re: readReynoldsNumber(x),
    reReadoutRange: [readReynoldsNumber(x - plotErrorPixels), readReynoldsNumber(x + plotErrorPixels)],
    observedCd: (zeroY - y) / pixelsPerCd,
    readBound: plotErrorPixels / pixelsPerCd,
  };
}

// The figure does not report the density, gas temperature or speed for each marker. Use the published pressure
// levels and a fixed room-temperature ideal-air approximation to find a representative speed at the observed Re.
// Choose the lowest pressure whose jet limit permits that speed (atmospheric 33 m/s, pressurized 15 m/s).
// These reproducible similarity inputs use plotted Re and geometry, with the force and Cd held out.
function tunnelCondition(re) {
  for (const pressureBar of pressureSeriesBar) {
    const density = (pressureBar * 1e5) / (airGasConstant * ambientK);
    const speed = (re * dynamicViscosity) / (density * diameter);
    if (speed <= (pressureBar === 1 ? 33 : 15)) return { pressureBar, density, speed };
  }
  throw new Error(`Re ${re} exceeds the published jet speed bounds; use one of the measured runs.`);
}

function windDrag({ density, speed }, fixedTimestep) {
  const physics = new Physics(null, { fixedTimestep });
  try {
    physics.gravity = [0, 0, 0];
    const body = physics.addBody(null, { colliders: { shape: 'sphere', radius: diameter / 2, mass: instrumentMass } });
    new WindForce(physics, { density, velocity: [speed, 0, 0] });
    physics.step();
    const [vx, vy, vz] = body.linearVelocity;
    assert.ok(
      vx > 0 && vx < speed && Number.isFinite(vy) && Number.isFinite(vz),
      'Expected a finite downwind impulse.',
    );
    const forceScale = (0.5 * density * speed ** 2 * referenceArea * fixedTimestep) / instrumentMass;
    return { cd: vx / forceScale, transverseCd: Math.hypot(vy, vz) / forceScale, speedFraction: vx / speed };
  } finally {
    physics.dispose();
  }
}

await Physics.load();
const observations = markers.map(digitize);
observations.push({ regime: 'high-Re recovery (paper text)', re: 6e6, observedCd: 0.19, readBound: 0.005 });
const results = observations.map(({ regime, re, reReadoutRange, observedCd, readBound }) => {
  const condition = tunnelCondition(re);
  const coarse = windDrag(condition, 1 / 12000);
  const fine = windDrag(condition, 1 / 120000);
  const stepDifference = Math.abs(fine.cd - coarse.cd);
  assert.ok(
    stepDifference < 1e-4 && fine.speedFraction < 1e-4,
    `Use a finer instrument step at Re=${re} (Cd step difference ${stepDifference}, speed share ${fine.speedFraction}).`,
  );
  const residual = fine.cd - observedCd;
  return {
    regime,
    re,
    reReadoutRange,
    ...condition,
    observedCd,
    predictedCd: fine.cd,
    residualCd: residual,
    relativeError: residual / observedCd,
    transverseCd: fine.transverseCd,
    stepDifference,
    digitizationOrRoundingBoundCd: readBound,
    comparison: Math.abs(residual) <= readBound + stepDifference ? 'within readout band' : 'outside readout band',
  };
});
console.log(
  JSON.stringify(
    {
      source: 'Achenbach (1972), DOI 10.1017/S0022112072000874, Fig. 4 and p. 570',
      measuredSetup: { diameterMetres: diameter, nominalTurbulenceIntensity: 0.0045, rearStingDiameterRatio: 0.1 },
      readout:
        'Marker readout is ±3 source pixels in each dimension; text rounded to 0.01 Cd. No total drag measurement uncertainty was specified.',
      comparison:
        'WindForce defaults on a rigid sphere; nominal Re-matched air inputs from pressure series and assumed room-temperature state. Transition rows show sensitivity and are diagnostic.',
      results,
    },
    null,
    2,
  ),
);
