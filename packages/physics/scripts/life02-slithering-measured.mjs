import { TerrainBed } from '@margoengine/physics/earth';
import { GroundLocomotion } from '@margoengine/physics/locomotion';
import { PhysicsWorld } from '@margoengine/physics/world';

// Hu, Nirody, Scott & Shelley, "The mechanics of slithering locomotion", PNAS 106, 10081–10085 (2009).
// https://doi.org/10.1073/pnas.0812533106
// https://hoogle.gatech.edu/Publications/Hu09.pdf
// Inputs come from the motion protocol, the observed curvature ansatz, and the separate cloth friction
// measurements. The experiment measures static friction and treats dynamic friction as comparable.
// Use the directly reported cardinal means, without the paper's separately fitted incline curves.
const length = 0.3;
const period = 2;
const mass = 0.0152;
const radius = Math.sqrt(mass / (Math.PI * length * 1000)); // Mean cohort mass and assumed waterlike tissue density.
const friction = { friction: 0.11, reverseFriction: 0.14, lateralFriction: 0.2 };
// Integrate curvature 7 cos(2π(s+t)) over normalized arclength to get tangent angle. Native phase advances
// from tail toward head in the argument; the pattern travels tailward as time increases.
const bend = 7 / (2 * Math.PI);
const bedShape = { width: 4, depth: 6, columns: 1, rows: 1, centre: [0, 0] };
const plank = { width: 0.3, length: 1.2 };
const gravity = [0, -9.81, 0];

// Observations excluded from all setup. Flat is the text's steady mean and reported spread.
// The six values are approximate Fig. 2D open-circle readings; the last column is the visual half extent
// of the plotted bars. On the 210 dpi author PDF page 3, the graph axes are about 9.67 px/degree
// and 86.9 px per normalized speed unit. Use ±2 px (0.21° and 0.024 in speed) for reading resolution.
// The meaning of the Fig. 2D bars is not stated separately, so they are reported as plotted.
const observations = [
  { angle: -7.6, speed: 0.38, spread: 0.11 },
  { angle: -2, speed: 0.24, spread: 0.11 },
  { angle: 0, speed: 0.22, spread: 0.08 },
  { angle: 1.9, speed: 0.14, spread: 0.11 },
  { angle: 5, speed: 0.13, spread: 0.1 },
  { angle: 8, speed: -0.14, spread: 0.11 },
  { angle: 12.9, speed: -0.29, spread: 0.11 },
];
const transition = [5, 9]; // Reported 7 ± 2 degrees.
const intermediateAngles = [3, 4, 6, 7, 9];

async function measure(angle, links, rate, slipSpeed) {
  const radians = (angle * Math.PI) / 180;
  const slope = Math.tan(radians);
  const locomotion = await GroundLocomotion.load({ bedShape });
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity })
    .add(new TerrainBed(), { ...bedShape, elevations: (_, z) => z * slope })
    .add(locomotion, {
      bodies: [
        {
          kind: 'snake',
          mass,
          length,
          radius,
          bend,
          waves: 1,
          frequency: 1 / period,
          links,
          ...friction,
          ...(slipSpeed === undefined ? {} : { slipSpeed }),
        },
      ],
    });
  const along = 1 / Math.cos(radians);
  const samples = [];
  let firstOverrunS = null;
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  // Use 0.1 s accepted samples to check the minimum plank dimensions that could enclose the trajectory
  // for any initial placement. The source gives plank dimensions but no per-trial starting position.
  // Stop before a mismatched extrapolation reaches even the numerical bed edge.
  for (let frame = 0; frame <= 4 * period * rate; frame += rate / 10) {
    world.advance(frame);
    for (let link = 0; link < links; link++) {
      const { position } = locomotion.readContact(0, link);
      const across = position[0];
      const distance = position[2] * along;
      minAcross = Math.min(minAcross, across - radius);
      maxAcross = Math.max(maxAcross, across + radius);
      minAlong = Math.min(minAlong, distance - radius);
      maxAlong = Math.max(maxAlong, distance + radius);
    }
    if (maxAcross - minAcross > plank.width || maxAlong - minAlong > plank.length) {
      firstOverrunS = frame / rate;
      break;
    }
    if (frame >= 2 * period * rate && frame % (period * rate) === 0)
      samples.push(locomotion.read(0).position[2] * along);
  }
  world.remove(locomotion.id);
  locomotion[Symbol.dispose]?.();
  const firstCycle = samples.length > 1 ? (samples[1] - samples[0]) / length : null;
  const secondCycle = samples.length > 2 ? (samples[2] - samples[1]) / length : null;
  const complete = firstCycle !== null && secondCycle !== null;
  return {
    speed: complete ? (firstCycle + secondCycle) / 2 : null,
    cycles: [firstCycle, secondCycle],
    cycleDifference: complete ? Math.abs(secondCycle - firstCycle) : null,
    sampledFootprintM: [maxAcross - minAcross, maxAlong - minAlong],
    firstOverrunS,
  };
}

function reversalBracket(rows, key) {
  const sorted = rows.filter((row) => row[key].speed !== null).sort((a, b) => a.angle - b.angle);
  const index = sorted.findIndex((row) => row.angle >= 0 && row[key].speed <= 0);
  if (index <= 0 || sorted[index - 1][key].speed <= 0) return null;
  return [sorted[index - 1].angle, sorted[index].angle];
}

const results = [];
for (const angle of [...observations.map(({ angle }) => angle), ...intermediateAngles]) {
  const reference = await measure(angle, 32, 120);
  const refined = await measure(angle, 64, 240);
  const lowSlip = await measure(angle, 64, 240, 0.015);
  const observed = observations.find((row) => row.angle === angle);
  const comparison = observed && {
    observedSpeed: observed.speed,
    reportedSpread: observed.spread,
    predictionMinusObservation: refined.speed === null ? null : refined.speed - observed.speed,
    reportedBandWithReadout: observed.spread + (angle === 0 ? 0 : 0.024),
    numericalDifference:
      refined.speed === null || reference.speed === null ? null : Math.abs(refined.speed - reference.speed),
  };
  results.push({ angle, reference, refined, lowSlip, comparison });
}

console.log(
  JSON.stringify(
    {
      units: { angle: 'degrees, positive uphill', speed: 'body lengths per gait cycle', footprint: '[cross, along] m' },
      setup: {
        length,
        period,
        mass,
        radius,
        bend,
        ...friction,
        plank,
        run: 'from rest; two gait cycles to settle, then two complete cycles when the motion fits the reported plank',
        reference: { links: 32, worldHz: 120, defaultSlipSpeedMps: 0.06 },
        refined: { links: 64, worldHz: 240, defaultSlipSpeedMps: 0.06 },
        lowSlip: { links: 64, worldHz: 240, slipSpeedMps: 0.015 },
      },
      transition: {
        reported: transition,
        referenceBracket: reversalBracket(results, 'reference'),
        refinedBracket: reversalBracket(results, 'refined'),
        lowSlipBracket: reversalBracket(results, 'lowSlip'),
      },
      results,
    },
    null,
    2,
  ),
);
