// After building Weather, run node packages/weather/scripts/atmo01-mosaic-measured.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BoundaryLayerWind } from '../dist/boundary-layer.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/atmo01-mosaic-heldout.json', import.meta.url), 'utf8'));
const windEntry = await readFile(new URL('../dist/boundary-layer.js', import.meta.url));
// An independent roughness prior from the earlier SHEBA campaign, not fit to MOSAiC.
const roughness = 0.00045;
const roughnessSource = 'https://doi.org/10.1029/2000JC000705';
const componentError = 0.3; // Cox et al. (2023), Table 1, Metek u-Sonic3 Cage MP.
const magnitudeError = Math.SQRT2 * componentError;

function score(values, predicted) {
  const differences = values.map((sample) => sample[predicted] - sample.measured);
  const average = (array) => array.reduce((sum, value) => sum + value, 0) / array.length;
  const stats = {
    count: differences.length,
    biasMPerS: average(differences),
    meanAbsoluteErrorMPerS: average(differences.map(Math.abs)),
    rmsErrorMPerS: Math.sqrt(average(differences.map((value) => value * value))),
    maximumAbsoluteErrorMPerS: Math.max(...differences.map(Math.abs)),
  };
  if (predicted === 'fluxAnchored') return stats;
  return {
    ...stats,
    // |dU_upper| <= |(dU_upper/dU_ref) dU_ref| + |dU_observed|.
    // Both measured horizontal speeds have Euclidean error <= sqrt(2)*0.3 m/s at fixed L and z0.
    withinComponentBound: differences.filter((difference, index) => {
      const scale = values[index][predicted] / values[index].referenceSpeed;
      return Math.abs(difference) <= magnitudeError * (1 + scale);
    }).length,
  };
}

function speedAt(wind, height) {
  const { velocity } = wind.sample(0, height, 0, 0);
  return Math.hypot(velocity[0], velocity[2]);
}

const results = [];
for (const { heightsM, cases } of fixture.files) {
  const [referenceHeight, middle, top] = heightsM;
  for (const [record, utc, regime, zetaRef, speed, observedMiddle, observedTop, observedFrictionVelocity] of cases) {
    const obukhovLength = zetaRef === 0 ? Infinity : referenceHeight / zetaRef;
    const options = { speed, referenceHeight, roughness, turbulence: false };
    const corrected = new BoundaryLayerWind({ ...options, obukhovLength });
    const neutral = new BoundaryLayerWind(options);
    assert.ok(Number.isFinite(observedFrictionVelocity) && observedFrictionVelocity >= 0.1);
    const shearScale = observedFrictionVelocity / corrected.frictionVelocity;
    const correctedReference = speedAt(corrected, referenceHeight);
    if (Number.isFinite(obukhovLength)) {
      // Catch a stale Weather package which otherwise ignores the new JS option.
      const ratio = top / obukhovLength;
      if (Math.abs(ratio) >= 0.05) {
        const sign = ratio > 0 ? 1 : -1;
        assert.equal(Math.sign(corrected.meanSpeed(top) - neutral.meanSpeed(top)), sign);
      }
    }
    for (const [level, height, measured] of [
      ['middle', middle, observedMiddle],
      ['top', top, observedTop],
    ]) {
      const correctedSpeed = speedAt(corrected, height);
      results.push({
        record,
        utc,
        regime,
        level,
        height,
        referenceHeight,
        referenceSpeed: speed,
        observedFrictionVelocity,
        modeledFrictionVelocity: corrected.frictionVelocity,
        obukhovLength: Number.isFinite(obukhovLength) ? obukhovLength : null,
        measured,
        corrected: correctedSpeed,
        neutral: speedAt(neutral, height),
        // The production profile increment is linear in u*. Its common roughness term cancels.
        fluxAnchored: speed + shearScale * (correctedSpeed - correctedReference),
      });
    }
  }
}

const summary = {};
for (const regime of ['stable', 'unstable', 'nearNeutral']) {
  const cases = results.filter((result) => result.regime === regime);
  assert.ok(cases.length, 'Expected held-out measurements in each signed stability regime.');
  summary[regime] = {};
  for (const level of ['middle', 'top']) {
    const layer = cases.filter((result) => result.level === level);
    summary[regime][level] = {
      corrected: score(layer, 'corrected'),
      neutral: score(layer, 'neutral'),
      fluxAnchored: score(layer, 'fluxAnchored'),
    };
  }
}

console.log(
  JSON.stringify(
    {
      dataset: fixture.doi,
      instrumentMethods: fixture.article,
      profile: [
        'Dyer and Hicks 1970: https://doi.org/10.1002/qj.49709641012',
        'Dyer 1974: https://doi.org/10.1007/BF00240838',
        'Paulson 1970: https://doi.org/10.1175/1520-0450(1970)009<0857:TMROWS>2.0.CO;2',
      ],
      roughness,
      roughnessSource,
      windEntrySha256: createHash('sha256').update(windEntry).digest('hex'),
      selection: fixture.selection,
      scope:
        'Score wind at the two higher sonic levels. The speed-anchored predictions use the lowest measured wind speed and an independent SHEBA snow and sea-ice roughness. The corrected prediction also uses the lowest sensor’s eddy-covariance stability. The published 0.3 m/s component error yields a conditional wind-only bound with L and roughness held fixed.',
      fluxObservation: fixture.frictionVelocity,
      fluxAnchoredMethod:
        'Anchor the production velocity increment at the lowest observed wind speed and scale the increment by the ratio of observed to modeled friction velocity. The common roughness term cancels, so shear depends on the lowest sensor’s eddy-covariance u* and L. Both upper speeds are held out. The archive provides no per-record uncertainty for u* or L, and the wind component error alone cannot bound this prediction.',
      summary,
      results,
    },
    null,
    2,
  ),
);
