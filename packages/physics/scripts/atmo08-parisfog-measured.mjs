// Run with built Physics: node packages/physics/scripts/atmo08-parisfog-measured.mjs
// Mazoyer, Burnet & Denjean (2022), Fig. 7 and §2.1, https://doi.org/10.5194/acp-22-11305-2022
// Time-matched independent measurements of liquid water content and effective droplet diameter (WELAS-2000/FM-100,
// about 2.5 m above ground), and the held-out visibility (Degreanne, 4 m above ground). F9 had a single
// droplet mode, and F32 had two. The model receives observed condensate and radius, not observed visibility.
// Fig. 7 source CC BY 4.0, https://acp.copernicus.org/articles/22/11305/2022/acp-22-11305-2022-f07.png
// PNG SHA-256 a536abae553f32cb81da8920f2190bfe8bbcd0ad3e2065cdb108c14c9c1f1178.
// Elias et al. (2009), §§2.2 and 3.2, https://doi.org/10.1016/j.atmosres.2009.01.006:
// ParisFog's same diffusometer models report 5% contrast at 550 nm with 10–25% uncertainty.
import assert from 'node:assert/strict';
import { DrainageFog } from '../dist/drainage-fog.js';
import { PhysicsWorld } from '../dist/world.js';

// Each triplet is the y pixel at the selected UTC time, then the inclusive readout bounds. Read the
// solid colored observations, excluding the black phase regressions and dashed diameter percentiles.
// Bounds cover the colored line extent over the nearest x coordinate ±1 pixel and half a y pixel.
const traces = [
  {
    event: 'F9',
    mode: 'single peak',
    visibilityAxis: [244, 149],
    liquidAxis: [520, 431.5],
    diameterAxis: [642, 564],
    points: [
      ['02:30', [223, 221.5, 224.5], [476.5, 472.5, 478.5], [607, 606.5, 607.5]],
      ['03:30', [225, 222.5, 227.5], [475.1, 466.5, 486.5], [608, 607.5, 608.5]],
      ['05:30', [227, 222.5, 233.5], [477, 472.5, 479.5], [609.5, 608.5, 610.5]],
      ['07:30', [215, 211.5, 217.5], [491.5, 489.5, 494.5], [605, 604.5, 605.5]],
      ['09:30', [226, 223.5, 228.5], [478, 476.5, 479.5], [609, 608.5, 610.5]],
      ['10:30', [214, 211.5, 224.5], [496, 490.5, 501.5], [605.5, 604.5, 606.5]],
    ],
  },
  {
    event: 'F32',
    mode: 'double peak',
    visibilityAxis: [246, 152],
    liquidAxis: [521, 433],
    diameterAxis: [643, 564.5],
    points: [
      ['04:00', [213, 211.5, 214.5], [498, 497.5, 499.5], [603, 600.5, 604.5]],
      ['04:30', [220.5, 217.5, 221.5], [488.5, 486.5, 491.5], [597.5, 595.5, 598.5]],
      ['05:30', [210.5, 198.5, 216.5], [499.5, 497.5, 501.5], [608, 606.5, 609.5]],
      ['06:30', [210, 208.5, 215.5], [493.5, 492.5, 494.5], [595.5, 594.5, 596.5]],
      ['07:30', [198.5, 192.5, 204.5], [505, 503.5, 507.5], [593.5, 592.5, 595.5]],
      ['08:00', [213.5, 208.5, 216.5], [504, 503.5, 504.5], [600, 599.5, 600.5]],
    ],
  },
];

const contrastPath = -Math.log(0.05);
const rate = { num: 60, den: 1 };
const airDensity = 1.225;
const visibilityInstrumentFraction = 0.25;
const fog = await DrainageFog.load();

function unitFraction(y, [bottom, top]) {
  return (bottom - y) / (bottom - top);
}

function fromPlot([centre, top, bottom], convert) {
  return { centre: convert(centre), min: convert(bottom), max: convert(top) };
}

function mor(liquidGramPerCubicMetre, radius) {
  const world = new PhysicsWorld({ rate });
  try {
    world.add(fog, {
      width: 1,
      depth: 1,
      initialDepth: 10,
      initialHumidity: 1,
      airHumidity: 1,
      airDensity,
      initialLiquid: (1e-3 * liquidGramPerCubicMetre) / airDensity,
      radius,
      emissivity: 0,
      settling: 0,
    });
    const before = fog.read(0, 0).extinction;
    world.advance(1);
    const extinction = fog.read(0, 0).extinction;
    assert.ok(extinction > 0 && Number.isFinite(extinction), 'Expected a finite positive native fog extinction.');
    assert.ok(Math.abs(extinction - before) < 1e-12, 'Unexpected extinction drift in a held column.');
    return contrastPath / extinction;
  } finally {
    world.remove(fog.id);
  }
}

function compare(traces) {
  const { event, mode, visibilityAxis, liquidAxis, diameterAxis, points } = traces;
  return points.map(([utc, visibilityPixels, liquidPixels, diameterPixels]) => {
    const observed = fromPlot(visibilityPixels, (y) => 10 ** (2 + unitFraction(y, visibilityAxis)));
    const liquid = fromPlot(liquidPixels, (y) => 0.15 * unitFraction(y, liquidAxis));
    const diameter = fromPlot(diameterPixels, (y) => 30 * unitFraction(y, diameterAxis));
    const radius = (diameter.centre * 1e-6) / 2;
    const predicted = mor(liquid.centre, radius);
    const defaultRadius = mor(liquid.centre, undefined);
    const predictedMin = mor(liquid.max, (diameter.min * 1e-6) / 2);
    const predictedMax = mor(liquid.min, (diameter.max * 1e-6) / 2);
    const observedMin = observed.min * (1 - visibilityInstrumentFraction);
    const observedMax = observed.max * (1 + visibilityInstrumentFraction);
    return {
      event,
      mode,
      utc,
      liquidGramPerCubicMetre: liquid.centre,
      effectiveDiameterMicrometres: diameter.centre,
      measuredVisibilityMetres: observed.centre,
      predictedVisibilityMetres: predicted,
      defaultRadiusVisibilityMetres: defaultRadius,
      residualMetres: predicted - observed.centre,
      relativeError: predicted / observed.centre - 1,
      observedVisibilityReadoutAndInstrumentBandMetres: [observedMin, observedMax],
      predictedVisibilityInputReadoutBandMetres: [predictedMin, predictedMax],
      bandsOverlap: predictedMin <= observedMax && predictedMax >= observedMin,
    };
  });
}

console.log(
  JSON.stringify(
    {
      source: 'Mazoyer, Burnet and Denjean (2022), DOI 10.5194/acp-22-11305-2022, Figure 7',
      signal: 'Optical range of the accepted liquid column at 5% contrast.',
      uncertainty:
        'Intervals cover Fig. 7 readout and a 25% visibility-instrument allowance. Field input calibration and sampling differences between 2.5 m and 4 m are unquantified. The column represents the measured droplet fraction only; diffusometers also see aerosol extinction.',
      scope:
        'The optical calculation uses observed local liquid concentration and effective droplet diameter in a uniform 10 m test column with heat exchange and settling disabled. Cooling, onset, layer growth and condensation remain untested here.',
      results: traces.flatMap(compare),
    },
    null,
    2,
  ),
);
