// Run after building Physics: node packages/physics/scripts/sea14-entry-measured.mjs
// Optional independent rigid-nose CSV: pass the local path to V4_rigid_R2223.csv.
//
// N. B. Speirs, J. Belden, Z. Pan, S. Holekamp, G. Badlissi, M. Jones and
// T. T. Truscott (2019), The water entry of a sphere in a jet, JFM 863,
// 956–968, https://doi.org/10.1017/jfm.2018.931, author draft
// https://arxiv.org/abs/1806.11453. We use only the plain sphere dropped
// into the quiescent pool. §2 and Fig. 3(a,c) give D=50 mm, specific gravity
// 2.253±.007, contact angle 80±8 degrees and U=4.39 m/s. Fresh-water
// density 1000 kg/m³, surface tension .072 N/m and viscosity .001 Pa·s
// are nominal laboratory-water assumptions; the source gives no exact values.
//
// §3 integrates the accelerometer magnitude from geometric contact to
// the descending half-maximum of the early peak. Divide by initial
// momentum m U, giving integral of proper acceleration divided by U.
// Free-fall accelerometer baseline is zero (Fig. 3c). The .067±.003
// impulse and .29±.09 FWHM in units D/U summarize the paper's quiescent
// cases. The paper gives no individual 4.39 m/s impulse, and §2.1's 95%
// convention explicitly applies to the uncertainty bands in its figures.
// Treat the aggregate printed ± values descriptively. The 1 kHz phase
// sweep is a forward sampling sensitivity, with 25 μs phase spacing and
// a 500 Hz Nyquist frequency. The IMU's reported rise time is <1 μs.
// The paper does not specify the filter transfer function or timing phase.
// Author-draft Fig. 3(c), p. 5, gives an independent coarse time read:
// the black curve peaks near 1.9 ms and crosses 5g on descent near 4.3 ms.
// At 150 dpi the 0–50 ms ticks are ~105 px apart. Allow about two pixels
// horizontally; the resulting ±1 ms resolution is separate from the
// publication's impulse uncertainty.
//
// The production trajectory runs the actual EntrySolver bodyForces
// through RigidSolver. Deltas of accepted rigid velocity check the
// applied force. The second trajectory uses the sphere's exact section
// radius and cap volume in the same exported Wagner/Logvinovich slam
// law, with a separate one-dimensional midpoint step. This is a mesh
// sensitivity control, distinct from independent model validation.
//
// J. T. Antolik, J. L. Belden, N. B. Speirs and D. M. Harris (2023),
// Slamming forces during water entry of a simple harmonic oscillator,
// https://doi.org/10.1017/jfm.2023.820 and https://arxiv.org/abs/2304.08672.
// Figure 3(b) identifies the optional genuinely measured rigid nose
// R=22.23 mm and total mass .578 kg. Its lower hemisphere matches our
// sphere until the center crosses the pool plane. Test the early
// interval t U/R ≤ 1. The source provides 20 kHz trial-mean acceleration
// and replicate standard deviation. Section 2.2 subtracts the free-fall
// baseline, aligns peaks across trials and defines time zero at departure
// from that baseline. We use geometric contact on the solver time axis
// and compare to the archived time axis. The paper's maximum nominal
// speed uncertainty is 2.5%. Vary that input at fixed evaluation times.
// https://raw.githubusercontent.com/harrislab-brown/WaterEntrySHO/2334a0effd2a035de13272a1c9b0b82a3102b862/V4_rigid_R2223.csv

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { EntrySolver, slam } from '../dist/entry.js';
import { Physics } from '../dist/index.js';
import { BODY_FORCES_FIELD, FORCE_WORDS, PhysicsWorld, regionWords, RigidSolver } from '../dist/world.js';

const gravity = 9.81;
const waterDensity = 1000;
const speirsRadius = 0.025;
const volumeOf = (radius) => (4 / 3) * Math.PI * radius ** 3;
const speirs = {
  radius: speirsRadius,
  mass: 2.253 * waterDensity * volumeOf(speirsRadius),
  speed: 4.39,
  contactAngle: 80,
  peakWindowSeconds: 0.01,
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sphereMesh(radius, sectors, rings) {
  const vertices = [];
  const indices = [];
  const at = (i, j) => j * (sectors + 1) + i;
  for (let j = 0; j <= rings; j++) {
    const angle = (Math.PI * j) / rings;
    const y = radius * Math.cos(angle);
    const r = radius * Math.sin(angle);
    for (let i = 0; i <= sectors; i++) {
      const azimuth = (2 * Math.PI * i) / sectors;
      vertices.push(r * Math.cos(azimuth), y, r * Math.sin(azimuth));
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < sectors; i++) {
      if (j > 0) indices.push(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      if (j < rings - 1) indices.push(at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  return { vertices: new Float64Array(vertices), indices: new Uint32Array(indices) };
}

await Physics.load();

function rigidTrace(setup, rate, sectors) {
  const { radius, mass, speed, contactAngle } = setup;
  const dt = 1 / rate;
  const down = [0, -gravity, 0];
  const physics = new Physics(null, { fixedTimestep: dt, gravity: down });
  try {
    const ball = physics.addBody(null, {
      position: [0, radius, 0],
      linearVelocity: [0, -speed, 0],
      colliders: { shape: 'sphere', radius, mass },
    });
    const entry = new EntrySolver();
    const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity: down });
    world.add(new RigidSolver(), { physics });
    world.add(entry, {
      sea: { elevation: () => 0, density: waterDensity },
      bodies: [{ row: ball.row, mesh: sphereMesh(radius, sectors, sectors / 2), contactAngle }],
      level: Math.log2(rate / 60),
    });
    world.couple(['entry', 'rigid'], 'staggered');
    const port = entry.exportPorts(0).find(({ field }) => field === BODY_FORCES_FIELD.name);
    assert.ok(port, 'The production entry solver must publish its held body force.');
    const samples = [[0, 0]];
    let velocity = ball.linearVelocity[1];
    let maxForceApplicationError = 0;
    const duration = (2.7 * radius) / speed;
    for (let step = 1; step <= Math.ceil(rate * duration); step++) {
      world.advance(step);
      const words = regionWords(world.memory, port.region);
      const normal = words[ball.row * FORCE_WORDS + 1] / mass;
      const next = ball.linearVelocity[1];
      const applied = (next - velocity) / dt + gravity;
      maxForceApplicationError = Math.max(maxForceApplicationError, Math.abs(applied - normal));
      velocity = next;
      samples.push([(step - 0.5) * dt, Math.abs(normal)]);
    }
    assert.ok(
      entry.splashes().some(({ kind }) => kind === 'entry'),
      'The sphere should contact the pool.',
    );
    return { samples, maxForceApplicationError };
  } finally {
    physics.dispose();
  }
}

function analyticSphereTrace(setup, rate, profilePoints) {
  const { radius, mass, speed } = setup;
  const heights = Float64Array.from({ length: profilePoints + 1 }, (_, i) => (radius * i) / profilePoints);
  const radii = heights.map((h) => Math.sqrt(h * (2 * radius - h)));
  const profile = { heights, radii };
  const dt = 1 / rate;
  const proper = (h, v) => {
    const wetDepth = Math.min(2 * radius, Math.max(0, h));
    const wetVolume = Math.PI * wetDepth ** 2 * (radius - wetDepth / 3);
    const capCosine = Math.max(0, 1 - wetDepth / radius);
    // Integrate .5 rho v² cos³(theta) on the forward, wetted spherical cap.
    const form = (Math.PI / 4) * waterDensity * v ** 2 * radius ** 2 * (1 - capCosine ** 4);
    const hit = slam(profile, wetDepth, v, waterDensity);
    const slamming = hit.c < radius * (1 - 1e-6);
    const fluidMass = waterDensity * wetVolume;
    const added = Math.max(fluidMass / 2, slamming ? hit.addedMass : 0);
    const force = Math.max(form, slamming ? hit.force : 0) + fluidMass * gravity;
    return (force + added * gravity) / (mass + added);
  };
  const samples = [[0, 0]];
  let depth = 0;
  let velocity = speed;
  for (let step = 1; step <= Math.ceil((rate * 2.7 * radius) / speed); step++) {
    const midpointVelocity = velocity + ((gravity - proper(depth, velocity)) * dt) / 2;
    const acceleration = proper(depth + (velocity * dt) / 2, midpointVelocity);
    depth += midpointVelocity * dt;
    velocity += (gravity - acceleration) * dt;
    samples.push([(step - 0.5) * dt, acceleration]);
  }
  return samples;
}

function valueAt(samples, time) {
  const hi = samples.findIndex(([t]) => t >= time);
  assert.ok(hi >= 0, 'The requested sample must be bracketed.');
  if (hi === 0) return samples[0][1];
  const [a, va] = samples[hi - 1];
  const [b, vb] = samples[hi];
  return va + ((vb - va) * (time - a)) / (b - a);
}

function integral(samples, endTime) {
  let sum = 0;
  for (let i = 1; i < samples.length; i++) {
    const [a, va] = samples[i - 1];
    const [b, vb] = samples[i];
    const end = Math.min(b, endTime);
    const final = va + ((vb - va) * (end - a)) / (b - a);
    sum += ((va + final) * (end - a)) / 2;
    if (end === endTime) return sum;
  }
  throw new Error('The integration window must end within the trace.');
}

function pulse(samples, setup) {
  const { radius, speed, peakWindowSeconds = (2 * radius) / speed } = setup;
  // For Speirs use the first ten milliseconds highlighted in Fig. 3(c).
  let peak = 0;
  for (let i = 1; i < samples.length && samples[i][0] <= peakWindowSeconds; i++) {
    if (samples[i][1] > samples[peak][1]) peak = i;
  }
  const half = samples[peak][1] / 2;
  let lower = peak;
  while (lower > 0 && samples[lower][1] > half) lower--;
  const upper = samples.findIndex(([, a], i) => i > peak && a <= half);
  assert.ok(peak > lower && upper > peak, 'The slam pulse must have two half-height crossings.');
  function crossing(lo, hi) {
    const [ta, a] = samples[lo];
    const [tb, b] = samples[hi];
    return ta + ((half - a) * (tb - ta)) / (b - a);
  }
  const start = crossing(lower, lower + 1);
  const end = crossing(upper - 1, upper);
  return {
    peakG: samples[peak][1] / gravity,
    peakMilliseconds: samples[peak][0] * 1000,
    descendingHalfHeightMilliseconds: end * 1000,
    relativeFwhm: ((end - start) * speed) / (2 * radius),
    relativeImpulse: integral(samples, end) / speed,
  };
}

function samplingPhaseRanges(samples, setup) {
  const phases = 40;
  const values = [];
  for (let j = 0; j < phases; j++) {
    const subsampled = [[0, 0]];
    const end = samples.at(-1)[0];
    for (let t = (j / phases) * 0.001; t < end; t += 0.001) {
      if (t > 0) subsampled.push([t, valueAt(samples, t)]);
    }
    values.push(pulse(subsampled, setup));
  }
  return Object.fromEntries(
    Object.keys(values[0]).map((key) => {
      const x = values.map((v) => v[key]);
      return [key, [Math.min(...x), Math.max(...x)]];
    }),
  );
}

const rigid = [];
let sensor;
let fixedFigureWindowImpulses;
const figureHalfHeightMilliseconds = [3.3, 4.3, 5.3];
for (const [rate, sectors] of [
  [1920, 48],
  [3840, 48],
  [7680, 48],
  [7680, 96],
]) {
  const trace = rigidTrace(speirs, rate, sectors);
  rigid.push({
    rate,
    sectors,
    ...pulse(trace.samples, speirs),
    maxForceApplicationError: trace.maxForceApplicationError,
  });
  if (rate === 7680 && sectors === 96) {
    sensor = samplingPhaseRanges(trace.samples, speirs);
    fixedFigureWindowImpulses = figureHalfHeightMilliseconds.map(
      (milliseconds) => integral(trace.samples, milliseconds / 1000) / speirs.speed,
    );
  }
}
const exactGeometry = [
  [15360, 1024],
  [30720, 2048],
].map(([rate, profilePoints]) => ({
  rate,
  profilePoints,
  ...pulse(analyticSphereTrace(speirs, rate, profilePoints), speirs),
}));

let antolik;
if (process.argv[2]) {
  const csv = await readFile(process.argv[2]);
  assert.equal(
    sha256(csv),
    '80b4144a22df56c3831cb440fe9f2e4b1c43e829e314389bcf8c7196597a085d',
    'Verified Antolik CSV revision',
  );
  const [header, ...rows] = csv.toString().trim().split(/\r?\n/);
  assert.equal(header, 'time (s),accel mean (g),accel std (g)');
  const setup = { radius: 0.02223, mass: 0.578, speed: 4 };
  // The archive does not give a contact angle. The selected window ends
  // before the trailing geometry wets; the angle is not a fitted input.
  const published = rows.map((row) => row.split(',').map(Number));
  const measured = published.map(([t, mean]) => [t, mean * gravity]);
  const cutoff = setup.radius / setup.speed;
  const modeled = rigidTrace(setup, 7680, 96);
  const measuredImpulse = integral(measured, cutoff) / setup.speed;
  const predictedImpulse = integral(modeled.samples, cutoff) / setup.speed;
  const speedSensitivity = [0.975, 1.025].map((scale) => {
    const speed = setup.speed * scale;
    const { samples } = rigidTrace({ ...setup, speed }, 7680, 96);
    return { speed, relativeImpulseAtNominalCutoff: integral(samples, cutoff) / speed };
  });
  const evaluation = published.filter(([t]) => t <= cutoff);
  const pairs = evaluation.map(([t, mean, sd]) => ({
    measured: mean,
    predicted: valueAt(modeled.samples, t) / gravity,
    std: sd,
  }));
  antolik = {
    setup,
    cutoff,
    measuredImpulse,
    predictedImpulse,
    speedSensitivity,
    points: pairs.length,
    measuredPeakG: Math.max(...pairs.map(({ measured: a }) => a)),
    modeledSampledPeakG: Math.max(...pairs.map(({ predicted: a }) => a)),
    rmseG: Math.sqrt(pairs.reduce((sum, { measured: m, predicted: p }) => sum + (p - m) ** 2, 0) / pairs.length),
    withinMeasuredOneStd: pairs.filter(({ measured: m, predicted: p, std }) => Math.abs(p - m) <= std).length,
  };
}

const entryPath = new URL('../dist/entry.js', import.meta.url);
const entryBytes = await readFile(entryPath);
const linkedName = /from ["'](\.\/entry-[^"']+\.js)["']/.exec(entryBytes.toString())?.[1];
console.log(
  JSON.stringify(
    {
      entrySha256: sha256(entryBytes),
      ...(linkedName && { linkedSha256: sha256(await readFile(new URL(linkedName, entryPath))) }),
      speirs: {
        setup: speirs,
        reportedRelativeImpulse: [0.067, 0.003],
        reportedRelativeFwhm: [0.29, 0.09],
        figureHalfHeightMilliseconds,
        fixedFigureWindowImpulses,
        rigid,
        oneKilohertzPhaseRanges: sensor,
        exactGeometry,
      },
      ...(antolik && { antolik }),
    },
    null,
    2,
  ),
);
