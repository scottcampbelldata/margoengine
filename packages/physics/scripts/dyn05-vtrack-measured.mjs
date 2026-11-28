// Run with built Physics: node packages/physics/scripts/dyn05-vtrack-measured.mjs
// Krishnan, Moraal, Li & Yang (2025), An Experimental Study of Wheel–Rail Creep Curves Under Dry
// Contact Conditions Using V-Track, §§2.1–3.1 and Fig. 9(b), Fig. 11(a,c), CC BY 4.0.
// https://doi.org/10.3390/lubricants13070287
// Digitization uses the full-size publisher PNGs, not the web thumbnails:
// https://mdpi-res.com/lubricants/lubricants-13-00287/article_deploy/html/images/lubricants-13-00287-g009.png
// https://mdpi-res.com/lubricants/lubricants-13-00287/article_deploy/html/images/lubricants-13-00287-g011.png
// Transcribed colored measurements only. Fig. 11's black fitted CONTACT lines, each observed
// maximum CoA and all measured tangential forces are excluded from the model inputs.
// Kalker (1967), §4.3 Table 3 for C22, and §3.221 for Hertz load scaling:
// https://resolver.tudelft.nl/uuid:aa44829b-c75c-4abd-9a03-fec17e121132
import assert from 'node:assert/strict';
import { railCreepForce } from '../dist/rail.js';

// Pixel anchors from the publisher's original PNGs. x spans 0..0.9% and y spans 0..0.45 CoA.
// Rows are [x, y centre, y high-CoA bound, y low-CoA bound]. Fig. 9(b) shows a single
// division's green centres. The outer two panels of Fig. 11 show the colored dots for all
// five divisions. Their center is reported as the ink median and bounds cover the visible dots.
const cases = [
  {
    speedKph: 4,
    plot: 'Fig. 11(a), all five divisions',
    xAxis: [241.5, 1359.5],
    yAxis: [984.5, 135],
    points: [
      [423, 691, 655, 704],
      [604, 489, 442, 519],
      [786, 353, 300, 395],
      [968, 275, 218, 321],
      [1148, 268, 210, 313],
      [1331, 240, 194, 275],
    ],
  },
  {
    speedKph: 8,
    plot: 'Fig. 9(b), division 2',
    xAxis: [2240, 3996.5],
    yAxis: [1170.5, 58.5],
    points: [
      [2526, 778.5, 778.5, 778.5],
      [2810, 525, 525, 525],
      [3096, 364.5, 364.5, 364.5],
      [3380, 285, 285, 285],
      [3522, 255, 255, 255],
      [3666, 260, 260, 260],
      [3950, 209, 209, 209],
    ],
  },
  {
    speedKph: 16,
    plot: 'Fig. 11(c), all five divisions',
    xAxis: [3072.5, 4189],
    yAxis: [984.5, 133],
    points: [
      [3254, 713.5, 683, 737],
      [3436, 525.5, 486, 565],
      [3616, 399, 352, 453],
      [3798, 337, 289, 395],
      [3979, 315.5, 268, 363],
      [4160, 274, 226, 311],
    ],
  },
];

const normalNominal = 2600;
const a = 1.068e-3;
const b = 1.012e-3;
const shearModulus = 82.7e9;
const poissonRatio = 0.27;
const standardCreepUncertainty = 0.00422 / 100;
const standardAdhesionUncertainty = 0.006;
const readoutPixels = 2;
// Same dry adhesion constants as the unmodified RailCar default, independent of this experiment.
const adhesion = { friction: 0.32, highSlipRatio: 0.58, decay: 0.4, adhesionFactor: 0.86, slipFactor: 0.58 };
const defaultStiffness = 600000;

const interpolate = (left, right, fraction) => left + fraction * (right - left);
const interpolatePoisson = (left, right) => interpolate(left, right, (poissonRatio - 0.25) / 0.25);
const circularC22 = interpolatePoisson(3.67, 3.98);
const aspectOffset = (1 - b / a) / 0.1;
// The paper gives semiaxis lengths without assigning their directions. Interpolate both branches
// of Kalker Table 3, from b/a=a/b=1 towards 0.9 in each orientation. Use the circular reference
// for the central comparison and include both asymmetric values in the geometry sensitivity range.
const c22Range = [
  interpolate(circularC22, interpolatePoisson(3.54, 3.82), aspectOffset),
  interpolate(circularC22, interpolatePoisson(3.81, 4.16), aspectOffset),
];

function measuredGeometryStiffness(normal, c22) {
  // Both Hertz contact semiaxes scale with the cube root of load at fixed curvatures and steel properties.
  return shearModulus * a * b * c22 * (normal / normalNominal) ** (2 / 3);
}

function coefficient(rollingSpeed, slipRatio, normal, creepStiffness) {
  const force = railCreepForce({ slip: [0, rollingSpeed * slipRatio], rollingSpeed, normal, creepStiffness, adhesion });
  assert.ok(force[0] === 0 && force[1] < 0 && Number.isFinite(force[1]), 'Expected a finite resisting lateral force.');
  return -force[1] / normal;
}

function bounds(values) {
  return [Math.min(...values), Math.max(...values)];
}

function comparison(test, [x, yCentre, yHigh, yLow]) {
  const {
    speedKph,
    plot,
    xAxis: [xZero, xMax],
    yAxis: [yZero, yMax],
  } = test;
  const rollingSpeed = speedKph / 3.6;
  const creepScale = 0.009 / (xMax - xZero);
  const coaScale = 0.45 / (yZero - yMax);
  const creep = (x - xZero) * creepScale;
  const c = (y) => (yZero - y) * coaScale;
  const observed = c(yCentre);
  const observedBand = [
    c(yLow + readoutPixels) - 2 * standardAdhesionUncertainty,
    c(yHigh - readoutPixels) + 2 * standardAdhesionUncertainty,
  ];
  const creepAllowance = 2 * standardCreepUncertainty + readoutPixels * creepScale;
  const normals = speedKph === 8 ? [2641.7, 2661.7, 2681.7] : [normalNominal];
  const normal = normals[speedKph === 8 ? 1 : 0];
  const regimes = [
    { name: 'stock 600 kN stiffness', coefficients: [0], stiffness: () => defaultStiffness, centre: 0 },
    {
      name: 'Kalker-scaled contact input',
      coefficients: c22Range,
      stiffness: measuredGeometryStiffness,
      centre: circularC22,
    },
  ];
  const predictions = regimes.map(({ name, coefficients, stiffness, centre }) => {
    const predict = (s, n, k) => coefficient(rollingSpeed, s, n, stiffness(n, k));
    const predicted = predict(creep, normal, centre);
    const sampledBand = bounds(
      normals
        .flatMap((n) =>
          [creep - creepAllowance, creep, creep + creepAllowance].flatMap((s) =>
            coefficients.map((k) => predict(s, n, k)),
          ),
        )
        .concat(predicted),
    );
    return {
      name,
      stiffnessN: stiffness(normal, centre),
      predictedCoa: predicted,
      residualCoa: predicted - observed,
      inputSensitivityBandCoa: sampledBand,
      bandsOverlap: sampledBand[0] <= observedBand[1] && sampledBand[1] >= observedBand[0],
    };
  });
  return {
    speedKph,
    plot,
    normalN: normal,
    creepage: creep,
    observedCoa: observed,
    observedBandCoa: observedBand,
    predictions,
  };
}

console.log(
  JSON.stringify(
    {
      source: 'Krishnan, Moraal, Li and Yang (2025), DOI 10.3390/lubricants13070287, Figs. 9(b) and 11(a,c)',
      setup: 'Clean dry steel, loaded scaled W1 on the S7 V-Track ring, imposed angle of attack and pure lateral slip.',
      approximation:
        'Observed CoA is the resultant tangential force divided by normal load. The model uses nominally pure lateral slip, without spin, rail flexibility or third-body dynamics. The reported zero-creep setup offset is outside the sample. The v4/v16 load is nominal; v8 uses the reported measured mean and span. The authors tested the three speeds in sequence on the same rig.',
      uncertainty:
        'Readout bands cover ±2 figure pixels, all visible division dot extents where shown, and two times the reported global maximum standard CoA uncertainty. Model bands sample the estimated creepage readout and measurement range, the stated v8 normal-load range, and both ellipse orientations for the scaled input. Raw repeat data are unavailable.',
      results: cases.flatMap((test) => test.points.map((point) => comparison(test, point))),
    },
    null,
    2,
  ),
);
