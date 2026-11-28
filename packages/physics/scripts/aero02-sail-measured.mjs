// Reproduce after building Physics:
// node scripts/run-with-timeout.mjs --max=1 -- node packages/physics/scripts/aero02-sail-measured.mjs
//
// A. Arredondo-Galeana, H. Babinsky and I. M. Viola, "Vortex flow of downwind sails",
// Flow 3 E8 (2023), https://doi.org/10.1017/flo.2023.1 (CC BY 4.0).
// Rigid printed S3, zero twist. Sections 2.3–2.5 give a 0.30 m span, 0.045 m² reference area and
// 0.14 m/s freestream (water flume, Re ≈ 21,000). Table 1 gives independently imaged
// chord incidence 30 degrees at the lab's eta = 0 datum, ±1 at A–C and ±2 at D/E.
// Apply the published trim rotation from that datum; no search for the model's optimum.
// Figure 4(a), red solid CL and red dashed CD, provides held-out load-cell results.
//
// CAD source: A. Arredondo Galeana and I. M. Viola, "Vortex flow of downwind sails" dataset,
// University of Edinburgh DataShare (2020), https://doi.org/10.7488/ds/2857 (CC BY 4.0,
// https://creativecommons.org/licenses/by/4.0/). This reduced midsurface changes the solid,
// and the held-out curve rows below transcribe only factual figure readings. No original file
// is distributed. Geometries.zip SHA-256 545c2b8c59c853bf9923f4b8f39070a1ae16f36abddcbe1a9bddb2126c534867,
// Geometries/IGS_format/Spinnaker_low_twist_0deg.igs. The IGES parser used the archive's
// nonplanar curve geometry after padding unused trailing normal parameters with zero.
// The 59,014-triangle tessellation (0.08645 mm deflection) was cut in 25 equally spaced span planes
// 0.05 mm inside both tips. Rotate into the longest midspan chord, then sample the midpoint
// between both faces at 9 equal chord fractions. The section table rounds to 0.01 mm.
// Each row is [leading X, trailing X, cross-chord Y at fractions 0, 1/8, …, 1], all in mm.

import assert from 'node:assert/strict';
import { Physics } from '../dist/index.js';
import { SailForce, SoftBodies, SoftBodyDesc } from '../dist/soft.js';

const SHAPE_MM = [
  [-45.24, -37.5, 27.27, 26.25, 26.47, 26.64, 26.81, 26.94, 27.07, 27.12, 25.94],
  [-93.68, 19.69, 3.02, 14.21, 23.46, 29.28, 32.46, 33.27, 31.67, 27.59, 22.86],
  [-96.45, 44.16, 0.42, 17.35, 29.07, 35.6, 38.16, 36.9, 31.73, 23.03, 13.06],
  [-94.78, 62.58, 2.25, 22.54, 34.9, 41.1, 42.33, 38.51, 29.97, 17.66, 3.46],
  [-92.79, 71.7, 3.78, 26.23, 38.98, 45.0, 45.49, 40.34, 30.24, 16.52, 2.53],
  [-90.55, 75.04, 5.09, 28.6, 41.56, 47.61, 47.97, 42.62, 32.34, 18.45, 4.79],
  [-88.1, 78.13, 6.19, 30.19, 43.21, 49.24, 49.56, 44.25, 34.08, 20.21, 6.2],
  [-85.46, 81.12, 7.13, 31.03, 43.93, 49.9, 50.31, 45.28, 35.49, 21.81, 7.28],
  [-82.62, 83.89, 7.91, 31.25, 43.89, 49.79, 50.35, 45.78, 36.56, 23.22, 8.1],
  [-79.55, 86.48, 8.53, 31.04, 43.35, 49.13, 49.86, 45.78, 37.21, 24.3, 8.74],
  [-76.13, 88.62, 8.94, 30.47, 42.34, 47.96, 48.83, 45.24, 37.37, 24.99, 9.07],
  [-72.34, 90.23, 9.13, 29.51, 40.87, 46.28, 47.25, 44.15, 36.99, 25.24, 9.16],
  [-68.11, 91.23, 9.08, 28.12, 38.86, 44.0, 45.05, 42.4, 35.95, 24.95, 9.08],
  [-63.41, 91.56, 8.75, 26.28, 36.29, 41.12, 42.21, 39.98, 34.23, 24.06, 8.77],
  [-58.14, 91.03, 8.08, 23.91, 33.13, 37.59, 38.68, 36.82, 31.76, 22.49, 8.09],
  [-52.18, 89.65, 6.95, 21.01, 29.35, 33.39, 34.43, 32.88, 28.46, 20.09, 6.98],
  [-45.45, 87.28, 5.25, 17.57, 24.94, 28.52, 29.47, 28.21, 24.39, 17.0, 5.27],
  [-37.99, 84.06, 2.94, 13.49, 19.88, 22.96, 23.8, 22.78, 19.55, 13.13, 2.96],
  [-29.71, 79.84, -0.13, 8.71, 14.11, 16.69, 17.39, 16.59, 13.93, 8.48, -0.14],
  [-20.58, 74.73, -4.03, 3.16, 7.56, 9.62, 10.2, 9.59, 7.45, 2.95, -4.02],
  [-10.66, 68.67, -8.79, -3.27, 0.19, 1.75, 2.18, 1.75, 0.11, -3.49, -8.79],
  [0.01, 61.74, -14.42, -10.49, -7.96, -6.86, -6.56, -6.85, -8.03, -10.74, -14.43],
  [11.3, 54.02, -20.87, -18.4, -16.74, -16.07, -15.88, -16.05, -16.81, -18.63, -20.86],
  [23.19, 45.45, -28.14, -27.0, -26.19, -25.87, -25.79, -25.86, -26.22, -27.13, -28.1],
  [35.85, 35.94, -36.41, -36.41, -36.41, -36.41, -36.4, -36.41, -36.41, -36.41, -36.41],
];
const SPAN_M = 0.299895;
// Use the published coefficient denominator. The reduced projected chord planform is about 0.03760 m².
const AREA_M2 = 0.045;
const FLOW_M_S = 0.14;
// Placeholder density cancels exactly in force coefficient normalization for the fixed shape.
const WATER_DENSITY_KG_M3 = 1000;
const CAMERA_DEGREES = 30;
const ANGLE_ALLOWANCE_DEGREES = 2;
const FIGURE_ALLOWANCE = 0.005;
const COARSE = [5, 13];
const FINE = [9, 25];

// Figure 4(a) vector polyline vertices at the fixed trims below. Linear calibration of frame
// x = 98.058…236.778 pt (−30…30 degrees), y = 199.063…62.742 pt (0…1.5).
// Include ±0.005 for tracing/rounding, in addition to the paper's ±5% CL / ±1% CD
// load uncertainties (coverage factor 2, §2.5). Figure bars are displayed only for S1.
const OBSERVATIONS = [
  [-26, 0.405, 0.188],
  [-20, 0.69, 0.253],
  [-12, 0.952, 0.349],
  [0, 1.309, 0.601],
  [12, 1.309, 0.888],
];

function pinnedSail([chords, spans], alphaDegrees) {
  const angle = (alphaDegrees * Math.PI) / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const positions = [];
  for (let i = 0; i < chords; i++) {
    const fraction = i / (chords - 1);
    for (let j = 0; j < spans; j++) {
      const row = SHAPE_MM[(j * (SHAPE_MM.length - 1)) / (spans - 1)];
      const [leading, trailing] = row;
      const x = (leading + (trailing - leading) * fraction) / 1000;
      const y = row[2 + fraction * 8] / 1000;
      positions.push(x * cosine + y * sine, -x * sine + y * cosine, (SPAN_M * j) / (spans - 1));
    }
  }
  return new SoftBodyDesc(positions).setPinnedParticles(Array.from({ length: chords * spans }, (_, i) => i));
}

async function coefficients(grid, alphaDegrees) {
  const physics = new Physics(null);
  try {
    physics.gravity = [0, 0, 0];
    const soft = await SoftBodies.attach(physics);
    const body = soft.create(pinnedSail(grid, alphaDegrees));
    const sail = new SailForce(physics, body, {
      wind: [FLOW_M_S, 0, 0],
      grid,
      density: WATER_DENSITY_KG_M3,
    });
    physics.step();
    assert.ok(sail.force.every(Number.isFinite), 'SailForce returns a finite force on the measured shape.');
    const qA = 0.5 * WATER_DENSITY_KG_M3 * FLOW_M_S ** 2 * AREA_M2;
    return [sail.force[1] / qA, sail.force[0] / qA];
  } finally {
    physics.dispose();
  }
}

function comparison(index, measured, fraction, coarse, fine, lowAngle, highAngle) {
  const estimate = fine[index];
  const measurementAllowance = Math.abs(measured) * fraction + FIGURE_ALLOWANCE;
  const gridChange = Math.abs(estimate - coarse[index]);
  const angleSamples = [lowAngle[index], estimate, highAngle[index]];
  const modelSensitivity = [Math.min(...angleSamples) - gridChange, Math.max(...angleSamples) + gridChange];
  return {
    measured,
    measurementAllowance,
    estimate,
    error: estimate - measured,
    gridChange,
    modelSensitivity,
    intervalsOverlap:
      modelSensitivity[0] <= measured + measurementAllowance && modelSensitivity[1] >= measured - measurementAllowance,
  };
}

await Physics.load();
const result = [];
for (const [trim, lift, drag] of OBSERVATIONS) {
  const incidence = CAMERA_DEGREES + trim;
  const coarse = await coefficients(COARSE, incidence);
  const fine = await coefficients(FINE, incidence);
  const low = await coefficients(FINE, incidence - ANGLE_ALLOWANCE_DEGREES);
  const high = await coefficients(FINE, incidence + ANGLE_ALLOWANCE_DEGREES);
  result.push({
    trimDegrees: trim,
    incidenceDegrees: incidence,
    lift: comparison(0, lift, 0.05, coarse, fine, low, high),
    drag: comparison(1, drag, 0.01, coarse, fine, low, high),
  });
}
console.log(
  JSON.stringify(
    {
      source: 'Arredondo-Galeana, Babinsky and Viola (2023), S3 Figure 4(a), doi:10.1017/flo.2023.1',
      geometry: 'Mid-surface independently reduced from doi:10.7488/ds/2857',
      coarse: COARSE,
      fine: FINE,
      angleSensitivityDegrees: ANGLE_ALLOWANCE_DEGREES,
      scope:
        'Pinned three-dimensional cambered sail in uniform flow. Missing flume walls, mount, thickness and measured turbulence/recirculation. Sensitivity ranges are diagnostic and are not model confidence intervals.',
      result,
    },
    null,
    2,
  ),
);
