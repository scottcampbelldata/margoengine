import { FallingSolver } from '@margoengine/physics/falling';
import { PhysicsWorld } from '@margoengine/physics/world';

// Ortega-Jimenez, Kim & Dudley, J. R. Soc. Interface 16, 20180456 (2019), §2, §3 and Table 1.
// https://doi.org/10.1098/rsif.2018.0456
// Only the morphology and the separately reported outcomes of the five by-hand natural drops are used.
// Nave et al., Biomimetics 6, 23 (2021), CC BY 4.0, §3.1, §4.2 and Table 1.
// https://doi.org/10.3390/biomimetics6020023
// Only natural Norway maple in still air. Uses published cohort means/spreads and center of mass, no video.
// Rezgui, Hernández Arroyo & Theunissen, Aeronautical Journal 124, 1236–1261 (2020).
// https://doi.org/10.1017/aer.2020.25
// The production polar and default pitch come from the separately studied sycamore-seed model.
const gravity = 9.81;
const centerOfMassFraction = 0.285;
const turn = 2 * Math.PI;
const cohorts = [
  {
    label: 'Ortega-Jimenez et al. 2019',
    specimens: 5,
    input: { mass: 130e-6, length: 0.043, area: 5.3e-4 },
    loading: [2.5, 0.2],
    measured: { descent: [1, 0.1], rotationHz: [16, 5], coneDegrees: [12, 5] },
  },
  {
    label: 'Nave et al. 2021',
    specimens: 30,
    // Estimate area of this representative specimen using the cohort mean wing loading and mean mass.
    input: { mass: 102.4e-6, length: 0.0565, area: (102.4e-6 * gravity) / 2.09 },
    loading: [2.09, 0.5],
    measured: { descent: [1.1, 0.24], rotationHz: [81.4 / turn, 27.6 / turn] },
  },
];

function makeBody({ mass, length, area }, fraction, count) {
  // Replace the measured planform by an area-preserving rectangle. Each portion lies on its own
  // radial half-ray from the spin axis, with physical radius positive and azimuth shifted by π.
  const chord = area / length;
  const beforeCenter = fraction * length;
  const afterCenter = (1 - fraction) * length;
  const sections = [
    [afterCenter, 0],
    [beforeCenter, Math.PI],
  ].flatMap(([radius, azimuth]) =>
    radius > 0
      ? Array.from({ length: count }, (_, i) => ({
          start: (i * radius) / count,
          end: ((i + 1) * radius) / count,
          chord,
          azimuth,
        }))
      : [],
  );
  return {
    kind: 'samara',
    mass,
    // Root-weighted inertia estimate used independently of the fall results. No per-seed inertia is reported.
    spinInertia: (mass * length * length) / 10,
    sections,
  };
}

async function run(fraction, count, level, loadingOffset = 0) {
  const displayHz = 120;
  const falling = await FallingSolver.load({ rate: level });
  const world = new PhysicsWorld({ rate: { num: displayHz, den: 1 }, gravity: [0, -gravity, 0] }).add(falling, {
    bodies: cohorts.map(({ input, loading: [mean, deviation] }) => {
      const area = loadingOffset === 0 ? input.area : (input.mass * gravity) / (mean + loadingOffset * deviation);
      return makeBody({ ...input, area }, fraction, count);
    }),
  });
  // The fixed-axis model has no initial attitude recovery. Integrate from rest in unbounded still air
  // and observe two fixed one-second windows only to check the asymptotic state for the terminal comparison.
  const sums = cohorts.map(() => [
    { descent: 0, rotationHz: 0 },
    { descent: 0, rotationHz: 0 },
  ]);
  world.advance(5 * displayHz);
  for (let frame = 5 * displayHz + 1; frame <= 7 * displayHz; frame++) {
    world.advance(frame);
    for (let i = 0; i < cohorts.length; i++) {
      const pose = falling.pose(i);
      const window = sums[i][frame <= 6 * displayHz ? 0 : 1];
      window.descent -= pose.velocity[1] / displayHz;
      window.rotationHz += Math.abs(pose.angularVelocity[1]) / (turn * displayHz);
    }
  }
  world.remove(falling.id);
  falling[Symbol.dispose]?.();
  return sums.map(([first, last]) => ({
    ...last,
    windowDifference: {
      descent: Math.abs(last.descent - first.descent),
      rotationHz: Math.abs(last.rotationHz - first.rotationHz),
    },
  }));
}

function compare(predicted, observed, numerical) {
  const [mean, reportedSD] = observed;
  const difference = predicted - mean;
  return {
    mean,
    reportedSD,
    predicted,
    difference,
    numerical,
    insideReportedSpread: Math.abs(difference) <= reportedSD,
  };
}

const reference = await run(centerOfMassFraction, 8, 2);
const refined = await run(centerOfMassFraction, 16, 3);
const axisAtHeavyEnd = await run(0, 16, 3);
const lowLoading = await run(centerOfMassFraction, 16, 3, -1);
const highLoading = await run(centerOfMassFraction, 16, 3, 1);
const results = cohorts.map(({ label, specimens, input, loading, measured }, i) => ({
  label,
  specimens,
  input,
  descent: compare(refined[i].descent, measured.descent, Math.abs(refined[i].descent - reference[i].descent)),
  rotationHz: compare(
    refined[i].rotationHz,
    measured.rotationHz,
    Math.abs(refined[i].rotationHz - reference[i].rotationHz),
  ),
  observedConeDegrees: measured.coneDegrees ?? null,
  computedConeDegrees: null,
  windowDifference: refined[i].windowDifference,
  axisAtHeavyEnd: axisAtHeavyEnd[i],
  loadingSensitivity: { reportedMeanAndSDNPerM2: loading, lowLoading: lowLoading[i], highLoading: highLoading[i] },
}));

console.log(
  JSON.stringify(
    {
      units: {
        descent: 'm/s',
        rotationHz: 'revolutions/s',
        coneDegrees: 'degrees',
        mass: 'kg',
        length: 'm',
        area: 'm²',
      },
      centerOfMassFraction,
      setup: 'rest, quiescent standard air, fixed vertical axis, production pitch and polar',
      comparison: 'the reported standard deviation describes the spread of observed drops',
      refinement: '8 to 16 sections per half-ray, 240 to 480 solver Hz',
      sensitivity: 'axis at the heavy end or area changed to one reported loading SD on either side of its mean',
      cone: 'unsupported in fixed-axis solver',
      results,
    },
    null,
    2,
  ),
);
