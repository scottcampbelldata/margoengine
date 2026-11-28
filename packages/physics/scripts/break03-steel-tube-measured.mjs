// Run after building Physics: node packages/physics/scripts/break03-steel-tube-measured.mjs
// Jung, J.Y. (1997), On the Collision Strength of Ship’s Bow, Pusan National University.
// Measurements republished by Park, Cho & Kim (2022), Materials 15, 2107,
// https://doi.org/10.3390/ma15062107, §2, Tables 1, 2 and 4, Figs. 5 and 29.
// © 2022 Park, Cho & Kim, CC BY 4.0, https://creativecommons.org/licenses/by/4.0/.
// Only transcribed and digitized experimental values are used. The paper's calibrated FE outputs
// do not enter the model or the comparisons. No reported crush stroke or force is a model input.
import assert from 'node:assert/strict';
import { resolveCrushStroke, squareTubeCrushMaterial } from '../dist/crush.js';

// [width mm, wall mm, Young's modulus GPa, 0.2% proof MPa, ultimate tensile MPa].
const tubes = [
  [100, 2.2, 199.2, 286.1, 351.9],
  [100, 2.8, 205.8, 310.8, 363.3],
  [100, 3.0, 207.8, 299.3, 351.2],
  [100, 4.2, 199.9, 366.8, 450.8],
  [75, 2.1, 200.1, 328.5, 399.4],
  [75, 3.2, 209.7, 427.6, 477.2],
];
const lengthMM = 450;
const pressSpeed = 0.05e-3; // Experimental crosshead rate in m/s. The reduced model is rate independent.

// [Table 4 experimental peak and mean kN, Fig. 29 experimental compaction stroke mm].
// Stroke is read at the center of the red bar top in the 3483×2097 publication image.
// y=1847→0 mm and y=45→500 mm; bar centers y=609.5,613,602.5,669,616.5,672.5.
// The top strokes span ten pixels. Half their width gives about 1.4 mm; use 2 mm with
// axis placement and 0.1 mm reporting roundoff. The paper has no repeatability or gauge uncertainty.
const observations = [
  [231.3, 60.6, 343.4],
  [337.1, 101.0, 342.4],
  [361.6, 106.2, 345.3],
  [626.0, 271.6, 326.9],
  [193.1, 59.0, 341.4],
  [404.7, 148.4, 325.9],
];
const forceResolutionKN = 0.05;
const strokeResolutionMM = 2;

function materialFor(specimen, sign = 0) {
  const [width, thickness, young, yieldStress, tensileStrength] = specimen;
  // Perturb half the last published digit. These are input-rounding sensitivities.
  return squareTubeCrushMaterial({
    width: (width + sign * 0.5) * 1e-3,
    thickness: (thickness + sign * 0.05) * 1e-3,
    length: (lengthMM + sign * 0.5) * 1e-3,
    young: (young + sign * 0.05) * 1e9,
    yieldStress: (yieldStress + sign * 0.05) * 1e6,
    tensileStrength: (tensileStrength + sign * 0.05) * 1e6,
  });
}

function compression(material, divisions) {
  // Advance from virgin material to the production model's own end of plastic travel. The
  // total model stroke includes elastic spring deflection. Use the contract's exact incremental
  // plastic work and current elastic energy, matching experimental work to maximum stroke.
  const capForce = material.yieldForce + material.hardening * material.stroke;
  const modelStroke = material.stroke + capForce / material.stiffness;
  const dx = modelStroke / divisions;
  let permanentStroke = 0;
  let absorbed = 0;
  let elastic = 0;
  let maximumForce = 0;
  for (let step = 1; step <= divisions; step++) {
    const state = resolveCrushStroke(material, (step * modelStroke) / divisions, permanentStroke);
    permanentStroke = state.permanentStroke;
    absorbed += state.absorbedEnergy;
    elastic = state.elasticEnergy;
    maximumForce = Math.max(maximumForce, state.force);
  }
  const endpoint = resolveCrushStroke(material, modelStroke);
  assert.ok(Math.abs(absorbed + elastic - endpoint.absorbedEnergy - endpoint.elasticEnergy) < 1e-9 * absorbed);
  return {
    compactMM: modelStroke * 1e3,
    workKJ: (absorbed + elastic) / 1e3,
    averageKN: (absorbed + elastic) / modelStroke / 1e3,
    maximumKN: maximumForce / 1e3,
    secondsPerDisplacementStep: dx / pressSpeed,
  };
}

function comparison(prediction, observation, readoutAllowance, modelAllowance) {
  const residual = prediction - observation;
  return {
    prediction,
    observation,
    residual,
    fraction: residual / observation,
    readoutAllowance,
    modelAllowance,
    overlapsReadoutBand: Math.abs(residual) <= readoutAllowance + modelAllowance,
  };
}

for (const [index, specimen] of tubes.entries()) {
  const nominal = materialFor(specimen);
  const coarse = compression(nominal, 128);
  const fine = compression(nominal, 256);
  const rounding = [-1, 1].map((sign) => compression(materialFor(specimen, sign), 256));
  const modelAllowance = (name) =>
    Math.abs(fine[name] - coarse[name]) + Math.max(...rounding.map((result) => Math.abs(fine[name] - result[name])));
  const [peakKN, meanKN, compactMM] = observations[index];
  const workKJ = (meanKN * compactMM) / 1e3;
  const workReadoutKJ = ((meanKN + forceResolutionKN) * (compactMM + strokeResolutionMM)) / 1e3 - workKJ;
  console.log(
    JSON.stringify({
      specimen: `US-${index + 1}`,
      compactMM: comparison(fine.compactMM, compactMM, strokeResolutionMM, modelAllowance('compactMM')),
      averageKN: comparison(fine.averageKN, meanKN, forceResolutionKN, modelAllowance('averageKN')),
      workKJ: comparison(fine.workKJ, workKJ, workReadoutKJ, modelAllowance('workKJ')),
      // The reduced fold mean omits the instability that produces the first measured peak.
      maximumKN: comparison(fine.maximumKN, peakKN, forceResolutionKN, modelAllowance('maximumKN')),
      displacementStepWorkDifferenceJ: 1e3 * Math.abs(fine.workKJ - coarse.workKJ),
      secondsPerDisplacementStep: [coarse.secondsPerDisplacementStep, fine.secondsPerDisplacementStep],
    }),
  );
}

// US-4 Fig. 5 measured yellow trace, selected well after the initial peak. Stroke positions are
// fixed readouts along the test trace. At each x the interval envelopes the visible line/marker,
// calibrated from the published axes and rounded outward to the nearest kN. The curve's initial
// peak visually differs from Table 4, so no initial peak is digitized from this figure.
const thickestTube = materialFor(tubes[3]);
for (const [strokeMM, lowKN, highKN] of [
  [60, 148, 163],
  [95, 345, 361],
]) {
  const forceKN = resolveCrushStroke(thickestTube, strokeMM * 1e-3).force / 1e3;
  console.log(
    JSON.stringify({
      specimen: 'US-4',
      commonStrokeMM: strokeMM,
      measuredTraceKN: [lowKN, highKN],
      predictedForceKN: forceKN,
      overlapsTraceBand: forceKN >= lowKN && forceKN <= highKN,
    }),
  );
}
