// Run with built Physics: node packages/physics/scripts/aero03-rotor-measured.mjs
//
// F. X. Caradonna and C. Tung, Experimental and Analytical Studies of a Model
// Helicopter Rotor in Hover, NASA TM-81232, 1981.
// https://ntrs.nasa.gov/citations/19820004169 (public NASA/US Army report).
// PDF SHA256 16c14789a5f65892b4ffb4e3628872723195c930f96680068ead7375e57208d2.
// §2 and Fig. 1 describe two cantilevered, untapered, untwisted NACA 0012
// blades, 0.5 degrees precone, aspect ratio 6 and a 2.286 m rotor diameter,
// in a chamber ducted to suppress recirculation. These imply R=1.143 m and
// chord=R/6. The original report does not dimension the exposed root.
// The production 0.1R cutout is the baseline. R/6 is a separately published
// setup (Cambria 2023, Table 1) and is tested only for geometric sensitivity.
// https://www.politesi.polimi.it/retrieve/dc20e6c7-cd67-463c-9b97-47e94fa746a3/2023_05_Cambria_02.pdf
//
// The figure legends give integrated thrust coefficients from independent
// blade-pressure measurements. §2 names three 4888 Scanivalves with
// Statham PA 856-15 transducers and five span stations, including a common
// .80R station to compare both blades. It does not quantify a thrust
// instrument or pressure-integration error for these observations.
// Half a printed CT unit is transcription precision; repeated conditions
// in Figs. 4 and 6 give a separate observed between-figure spread. Neither
// is a confidence band. Fig. 3 explicitly prints .0200 for the 2268 rpm
// row, about ten times both adjacent measurements despite similar plotted
// pressures. Retain it as printed, with no inferred correction or pass/fail.
//
// Full-disk helicopter convention CT = T / (rho pi R² (Omega R)²).
// See W. Z. Stepniewski (1979), Rotary-Wing Aerodynamics, Vol. 1, §Blade Element Theory
// for the convention (report metadata: https://ntrs.nasa.gov/citations/19790013868).
// UIUC Brandt and Selig (2011), https://doi.org/10.2514/6.2011-1255,
// measures propeller thrust using a load cell but its usual static rotor
// geometry still requires a separate section pitch/chord definition and a
// distinct normalisation. NASA is the directly traceable fixed-pitch case.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { RotorForce } from '../dist/flight.js';
import { Physics } from '../dist/index.js';

// Figure, collective (deg), RPM, tip Mach, CT from the printed legends.
// Figure 6 does not print Mach. Figure 3's last CT has four decimal places.
const references = [
  [3, 5, 1250, 0.434, 0.00213],
  [3, 5, 1750, 0.607, 0.00218],
  [3, 5, 2268, 0.794, 0.02],
  [4, 8, 1250, 0.439, 0.00459],
  [4, 8, 1750, 0.612, 0.00455],
  [4, 8, 2250, 0.794, 0.00462],
  [4, 8, 2500, 0.877, 0.00473],
  [5, 12, 1250, 0.433, 0.00796],
  [5, 12, 1750, 0.61, 0.00807],
  [5, 12, 2279, 0.794, 0.00792],
  [6, 8, 1250, null, 0.0046],
  [6, 8, 2050, null, 0.00461],
  [6, 8, 2500, null, 0.00464],
];

const radius = 1.143;
const chord = radius / 6;
const density = 1.225; // Arbitrary SI reference: thrust and the CT denominator are both proportional to rho.
const diskArea = Math.PI * radius ** 2;
const refineStations = [128, 256];

await Physics.load();

const physics = new Physics(null);
physics.gravity = [0, 0, 0];
const body = physics.addBody(null, {
  type: 'kinematicVelocity',
  colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.1] },
});

function predict(collectiveDeg, rpm, options = {}) {
  const speed = (rpm * 2 * Math.PI) / 60;
  const rotor = new RotorForce(physics, body, {
    radius,
    chord,
    blades: 2,
    pitch: (collectiveDeg * Math.PI) / 180,
    speed,
    density,
    ...options,
  });
  try {
    physics.step();
    const steady = rotor.evaluate(speed, 0, density);
    assert.equal(rotor.thrust, steady.thrust, 'The immobile mount must give the same thrust as the zero-inflow hook.');
    assert.ok(Number.isFinite(rotor.thrust) && rotor.thrust > 0);
    return rotor.thrust / (density * diskArea * (radius * speed) ** 2);
  } finally {
    rotor.remove();
  }
}

const results = [];
try {
  for (const [figure, collectiveDeg, rpm, tipMach, measuredCT] of references) {
    const predictedCT = predict(collectiveDeg, rpm);
    const refinedCT = refineStations.map((stations) => predict(collectiveDeg, rpm, { stations }));
    const cutoutCT = predict(collectiveDeg, rpm, { hubRadius: chord });
    const unusualPrintedValue = figure === 3 && rpm === 2268;
    const printedHalfUnitCT = unusualPrintedValue ? 0.00005 : 0.000005;
    const errorCT = predictedCT - measuredCT;
    results.push({
      figure,
      collectiveDeg,
      rpm,
      tipMach,
      measuredCT,
      predictedCT,
      errorCT,
      errorPercent: (100 * errorCT) / measuredCT,
      refinedCT,
      refinementChangeCT: refinedCT[1] - refinedCT[0],
      chordRadiusCutoutCT: cutoutCT,
      cutoutChangeCT: cutoutCT - predictedCT,
      printedHalfUnitCT,
      beyondPrintResolution: unusualPrintedValue ? null : Math.abs(errorCT) > printedHalfUnitCT,
      ...(unusualPrintedValue && {
        sourceCaveat: 'The original figure prints 0.0200; physical measurement is uncertain.',
      }),
    });
  }
} finally {
  physics.dispose();
}

const entry = new URL('../dist/flight.js', import.meta.url);
const entryBytes = await readFile(entry);
const linkedName = /from ["'](\.\/flight-[^"']+\.js)["']/.exec(entryBytes.toString())?.[1];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
console.log(
  JSON.stringify(
    {
      radius,
      chord,
      defaultRootCutout: radius / 10,
      referenceDensity: density,
      defaultStations: 16,
      refineStations,
      setupLimit:
        'The symmetric thin-section run omits the measured 0.5° precone and any tip-loss or compressibility correction.',
      entrySha256: hash(entryBytes),
      ...(linkedName && { linkedSha256: hash(await readFile(new URL(linkedName, entry))) }),
      figure4To6SameConditionSpreadCT: [1250, 2500].map((rpm) => {
        const readings = results
          .filter((sample) => sample.rpm === rpm && sample.collectiveDeg === 8 && [4, 6].includes(sample.figure))
          .map((sample) => sample.measuredCT);
        return { rpm, spread: Math.max(...readings) - Math.min(...readings) };
      }),
      results,
    },
    null,
    2,
  ),
);
