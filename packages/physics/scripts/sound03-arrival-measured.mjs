// Compare flat-water ray arrival times with two primary measured records:
// Chitre (2007), https://doi.org/10.1121/1.2782884, Tables I–II.
// Viegas, Zabel & Silva (2023), https://doi.org/10.3390/s23104931, §3 and Figures 6 and 8.
// Run after building Physics: node packages/physics/scripts/sound03-arrival-measured.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { UnderwaterAcousticsSolver } from '../dist/underwater.js';
import { PhysicsWorld } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const milliseconds = 1000;
const sea = {
  source: 'https://doi.org/10.1121/1.2782884',
  inputLocation: 'Table I, measured rows marked a plus signal frequency and sample rate',
  measurementLocation: 'Table II, measurement column of mean excess delays and observed spreads',
  depth: 14.5,
  sourceDepth: 3,
  receiverDepth: 2,
  range: 100,
  speed: 1539,
  frequency: 40_000,
  sampleHz: 500_000,
  paths: [
    { kind: 'surface', excessMs: 0.09, roundingMs: 0.005, observedSpreadMs: 0.01 },
    { kind: 'bottom', excessMs: 1.9, roundingMs: 0.05, observedSpreadMs: 0.07 },
    { kind: 'bottom then surface', excessMs: 2.5, roundingMs: 0.05, observedSpreadMs: 0.07 },
    { kind: 'surface then bottom', excessMs: 3.0, roundingMs: 0.05, observedSpreadMs: 0.09 },
  ],
  qualification:
    'Only travel time is scored. Table I fitted reflection losses, seabed properties and motion from the measurements; none enters the timing prediction. Observed spread describes arrivals and is not a confidence interval for the reported mean.',
};
const tank = {
  source: 'https://doi.org/10.3390/s23104931',
  inputLocation: 'Section 3 and Figure 6, TC4033 tank geometry and nominal water sound speed',
  measurementLocation: 'Section 3 and Figure 8, TC4033 cross-correlation arrivals',
  depth: 1.72,
  sourceDepth: 0.84,
  receiverDepth: 0.84,
  range: 1,
  speed: 1500,
  frequency: 45_000, // Middle of the reported 40–50 kHz chirp. Travel time is frequency-independent here.
  sampleHz: 1_000_000,
  directMs: 0.68,
  paths: [
    { kind: 'surface', arrivalMs: 1.35, roundingMs: 0.01 },
    { kind: 'bottom', arrivalMs: 1.56, roundingMs: 0.01 },
  ],
  qualification:
    'The authors assume 1500 m/s; water sound speed and placement uncertainty were not separately reported. Rounding bounds on excess times include both printed timestamps, not a total laboratory uncertainty. The measured 2.46 ms sidewall arrival requires a different geometry and is excluded.',
};

function receiverImages({ depth, receiverDepth }) {
  return {
    direct: receiverDepth,
    surface: -receiverDepth,
    bottom: 2 * depth - receiverDepth,
    'bottom then surface': 2 * depth + receiverDepth,
    'surface then bottom': -2 * depth + receiverDepth,
  };
}

// Identical flats leave horizontal speed constant in homogeneous water. Unfold
// the accepted signed vertical motion for checks at crossings within a world tick.
function unfold(sample, depth, up) {
  const { reflections, depth: z } = sample;
  if (reflections % 2 === 0) return z + (up ? -1 : 1) * reflections * depth;
  return (up ? 1 - reflections : reflections + 1) * depth - z;
}

function measurePaths(scene) {
  const { range, sourceDepth, speed, depth, frequency } = scene;
  const kinds = ['direct', ...scene.paths.map(({ kind }) => kind)];
  const images = receiverImages(scene);
  const setup = kinds.map((kind) => {
    const rise = images[kind] - sourceDepth;
    return { kind, image: images[kind], angle: Math.atan2(rise, range), analyticS: Math.hypot(range, rise) / speed };
  });
  const acoustics = new UnderwaterAcousticsSolver();
  const world = new PhysicsWorld({ rate }).add(acoustics, {
    profile: [
      { depth: 0, speed },
      { depth, speed },
    ],
    rays: setup.map(({ angle }) => ({ depth: sourceDepth, declination: angle, frequency })),
    surfaceReflection: -1,
    bottomReflection: 1, // An unfitted placeholder for path timing, independent of the fitted losses.
  });
  const first = Math.floor(Math.min(...setup.map(({ analyticS }) => analyticS)) * rate.num);
  const last = Math.ceil(Math.max(...setup.map(({ analyticS }) => analyticS)) * rate.num);
  world.advance(first);
  const start = setup.map((_path, i) => acoustics.sample(i));
  const saved = world.takeSnapshot();
  world.advance(last);
  const end = setup.map((_path, i) => acoustics.sample(i));
  const exactHash = world.hash();
  world.restoreSnapshot(saved.bytes);
  world.advance(last);
  assert.equal(world.hash(), exactHash, 'The accepted ray states must replay exactly.');
  return {
    hash: exactHash,
    worldFrames: [first, last],
    arrivals: setup.map(({ kind, image, analyticS, angle }, i) => {
      const begin = start[i];
      const finish = end[i];
      assert.ok(
        begin.range <= range && finish.range >= range && finish.range > begin.range,
        'Accepted states must bracket the receiver.',
      );
      const fraction = (range - begin.range) / (finish.range - begin.range);
      const arrivalS = begin.travelTime + fraction * (finish.travelTime - begin.travelTime);
      const before = unfold(begin, depth, angle < 0);
      const after = unfold(finish, depth, angle < 0);
      const unfoldedAtReceiver = before + fraction * (after - before);
      // The continuous homogeneous segment formula uses a few transcendental
      // operations per tick and per reflection. This roundoff envelope scales
      // with traced steps, reflection count and the attained position.
      const operationMargin = 512 * (last + finish.reflections + 1) * Number.EPSILON;
      assert.ok(
        Math.abs(arrivalS - analyticS) <= operationMargin * analyticS,
        'Live rays miss the independent homogeneous image time.',
      );
      assert.ok(
        Math.abs(unfoldedAtReceiver - image) <= operationMargin * Math.max(depth, Math.abs(before), Math.abs(after)),
        'Live rays crossed the range at the wrong unfolded depth.',
      );
      return { kind, arrivalMs: arrivalS * milliseconds };
    }),
  };
}

function compare(scene) {
  const receipt = measurePaths(scene);
  const direct = receipt.arrivals[0].arrivalMs;
  // Acquisition sample period and printed rounding provide only a resolution
  // comparison. The optional empirical spread describes repeated observations.
  const oneSampleMs = milliseconds / scene.sampleHz;
  const comparisons = scene.paths.map((path, i) => {
    const measuredMs = path.excessMs ?? path.arrivalMs - scene.directMs;
    const predictedMs = receipt.arrivals[i + 1].arrivalMs - direct;
    const residualMs = predictedMs - measuredMs;
    const resolutionMs = path.roundingMs + oneSampleMs;
    const spreadMs = path.observedSpreadMs;
    return {
      kind: path.kind,
      measuredExcessMs: measuredMs,
      predictedExcessMs: predictedMs,
      residualMs,
      resolutionMs,
      withinReportedResolution: Math.abs(residualMs) <= resolutionMs,
      ...(spreadMs === undefined
        ? {}
        : {
            observedSpreadMs: spreadMs,
            withinObservedSpreadAndResolution: Math.abs(residualMs) <= resolutionMs + spreadMs,
          }),
    };
  });
  return {
    source: scene.source,
    inputLocation: scene.inputLocation,
    measurementLocation: scene.measurementLocation,
    qualification: scene.qualification,
    predictedDirectMs: direct,
    measuredDirectMs: scene.directMs,
    ...receipt,
    comparisons,
  };
}

const module = await readFile(new URL('../dist/underwater.js', import.meta.url));
console.log(
  JSON.stringify(
    {
      artifactSha256: createHash('sha256').update(module).digest('hex'),
      field: compare(sea),
      tank: compare(tank),
    },
    null,
    2,
  ),
);
