import assert from 'node:assert/strict';
import test from 'node:test';
import { coupledRadiationProfile } from '../dist/loads.js';
import { bakeHullPanels, hullMemory, lateralSection, lewisForm } from '../dist/seakeeping.js';

const density = 1000;
const gravity = 9.81;
const axes = 6;
const words = axes * axes;

function box(length, height, beam) {
  const x = length / 2;
  const y = height / 2;
  const z = beam / 2;
  return {
    vertices: [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z],
    indices: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ],
  };
}

function matrix(entry) {
  return Array.from({ length: words }, (_, word) => entry(Math.floor(word / axes), word % axes));
}

function channel(profile, w, row, column) {
  let real = 0;
  let imaginary = 0;
  for (const { direction, frequency, decayRate, strength } of profile.resonances) {
    const x = frequency * frequency - w * w;
    const y = decayRate * w;
    const weight = (strength * w * (direction[row] * direction[column])) / (x * x + y * y);
    real += y * weight;
    imaginary += x * weight;
  }
  return [real, profile.infiniteMass[axes * row + column] + imaginary / w];
}

function close(actual, expected, bound, label) {
  assert.ok(Math.abs(actual - expected) <= bound, `${label}: ${actual} vs ${expected} ± ${bound}`);
}

function bakedReference(frequencies, infiniteMass, samples, centre = [0, 0, 0]) {
  return {
    frequencies,
    infiniteMass,
    samples,
    centre,
    density,
    gravity,
    headings: 0,
    panelCount: 0,
    depth: 3,
    waterline: 0,
  };
}

async function checkSinglePole(frequency, decayRate) {
  const centre = [0, 0, 0];
  const frequencies = [1, 2, 3];
  const strength = 17;
  const direction = [0, 0.1, 1, -0.3, 0.2, 0];
  const infiniteMass = matrix((i, j) => 2 * direction[i] * direction[j] + (i === j ? 3 : 0));
  const samples = frequencies.map((w) => {
    const x = frequency * frequency - w * w;
    const y = decayRate * w;
    const scale = strength / (x * x + y * y);
    return {
      addedMass: matrix((i, j) => infiniteMass[axes * i + j] + direction[i] * direction[j] * x * scale),
      damping: matrix((i, j) => direction[i] * direction[j] * w * y * scale),
      diffraction: [],
    };
  });
  const profile = await coupledRadiationProfile(box(2, 1, 1), {
    mass: 1000,
    centre,
    density,
    panels: bakedReference(frequencies, infiniteMass, samples, centre),
    poles: 1,
  });
  assert.equal(profile.resonances.length, 1);
  assert.equal(profile.resonances[0].frequency, frequency);
  assert.equal(profile.resonances[0].decayRate, decayRate);
  assert.ok(profile.fit.normalizedRmsError < 128 * Number.EPSILON);
  for (const [index, w] of frequencies.entries()) {
    const [damping, added] = channel(profile, w, 3, 2);
    const expected = samples[index];
    assert.ok(damping < 0);
    close(damping, expected.damping[20], 128 * Number.EPSILON * strength, 'signed damping');
    close(added, expected.addedMass[20], 128 * Number.EPSILON * strength, 'dispersive added inertia');
    assert.deepEqual(channel(profile, w, 2, 3), channel(profile, w, 3, 2));
  }
}

test('one coupled passive pole recovers exact signed off-diagonal damping and frequency-dependent inertia', async () => {
  await checkSinglePole(2, 2);
});

test('samples below a passive pole still recover its out-of-band dispersive inertia', async () => {
  await checkSinglePole(12, 1.5);
});

test('a native finite-depth panel response retains physical cross inertia and gives a passive reciprocal profile', async (context) => {
  const mesh = box(2, 1, 0.8);
  const centre = [0, 0.17, 0.13];
  const frequencies = [0.35, 0.55, 0.75, 0.9, 1.05, 1.2];
  const panels = await bakeHullPanels(mesh, { centre, density, depth: 2, frequencies, headings: 0 });
  const profile = await coupledRadiationProfile(mesh, { mass: 800, density, panels });
  close(profile.draft, 0.5, 64 * Number.EPSILON, 'computed draft');
  close(profile.immersion, 0.5, 64 * Number.EPSILON, 'computed immersion');
  assert.deepEqual(profile.centre, centre);
  assert.deepEqual(profile.fit.range, [0.35, 1.2]);
  assert.ok(Math.abs(panels.infiniteMass[axes * 2 + 3]) > 1, 'offset centre has coupled sway and roll inertia');
  for (const [i, expected] of panels.infiniteMass.entries())
    close(
      profile.infiniteMass[i],
      expected,
      Math.abs(expected) * 128 * Number.EPSILON + 1e-12,
      `added inertia at ${i}`,
    );
  const radiatingCoupling = profile.resonances.some(
    ({ direction, strength }) => direction[2] * direction[3] * strength !== 0,
  );
  assert.ok(radiatingCoupling);
  for (const w of [0.01, ...frequencies, 5, 25, 80]) {
    // Arbitrary six-axis twists, including opposition of the two measured cross directions.
    for (const v of [
      [0, 0, 1, -1, 0, 0],
      [0, 0, 1, 1, 0, 0],
      [0.8, 0.3, -0.4, -1.3, 0.2, 0.7],
    ]) {
      const power = profile.resonances.reduce((sum, { direction, frequency, decayRate, strength }) => {
        const x = frequency * frequency - w * w;
        const y = decayRate * w;
        const speed = direction.reduce((dot, value, i) => dot + value * v[i], 0);
        return sum + (strength * w * y * speed * speed) / (x * x + y * y);
      }, 0);
      assert.ok(power >= 0 && Number.isFinite(power));
    }
    const direct = channel(profile, w, 2, 3);
    const reverse = channel(profile, w, 3, 2);
    for (let i = 0; i < direct.length; i++)
      close(direct[i], reverse[i], Math.abs(direct[i]) * 128 * Number.EPSILON, 'cross reciprocity');
  }
  context.diagnostic(
    JSON.stringify({ fit: profile.fit, crossInfinite: profile.infiniteMass[15], modes: profile.resonances.length }),
  );
});

test('the reused panel response refuses a wrong draft and non-passive instantaneous inertia', async () => {
  const mesh = box(2, 1, 1);
  const frequencies = [1, 2];
  const identity = matrix((i, j) => Number(i === j));
  const samples = frequencies.map(() => ({ addedMass: identity, damping: identity, diffraction: [] }));
  const panels = bakedReference(frequencies, identity, samples);
  await assert.rejects(coupledRadiationProfile(mesh, { mass: 750, panels }), {
    name: 'MargoError',
    code: 'unsupported',
    message: /Bake the panel response.+floating draft.+#hydrodynamic-loads/,
  });
  const indefinite = matrix((i, j) => (i === j ? 1 : i + j === 1 ? 2 : 0));
  await assert.rejects(coupledRadiationProfile(mesh, { mass: 1000, panels: { ...panels, infiniteMass: indefinite } }), {
    name: 'MargoError',
    code: 'unsupported',
    message: /positive semidefinite.+#hydrodynamic-loads/,
  });
});

test('a width-confined Vugts strip response resolves where the measured sway-roll damping is strongest', async (context) => {
  // Vugts (1968), Report 194, Table 5.1 and Figs. 6.9/6.23, DOI 10.3233/ISP-1968-1516702.
  // The B/T=2 section spans a 4.20 m tank with 5 mm end gaps. Use the two-dimensional section solve
  // for this comparison. The open-water panel test above has a different lateral boundary.
  const beam = 0.4;
  const length = 4.19;
  const draft = 0.2;
  const mass = 335.2;
  const area = 0.9992 * beam * draft;
  const mesh = box(length, 2 * draft, beam);
  const centre = [0, 0, 0];
  const form = lewisForm(beam, draft, area);
  const scale = Math.sqrt((2 * gravity) / beam);
  const frequencies = Array.from({ length: 48 }, (_, i) => (0.12 + 0.05 * i) * scale);
  const radiation = frequencies.map((w) => lateralSection(form, w, density, 0));
  const memory = hullMemory(mesh, mass, centre, density, 1, { stations: 6, count: 4, window: 2 });
  // Only the sway/roll block of the independently calculated strip reference enters this transfer fit.
  const keep = (i, j) => (i === 2 || i === 3) && (j === 2 || j === 3);
  const infiniteMass = matrix((i, j) => (keep(i, j) ? memory.lateralInfinite[axes * i + j] : 0));
  const samples = radiation.map((sample) => {
    const inPhase = (i, j) => {
      if (!keep(i, j)) return 0;
      if (i === j) return (i === 2 ? sample.sway.addedMass : sample.roll.addedMass) * length;
      return ((sample.swayOfRoll.addedMass + sample.rollOfSway.addedMass) * length) / 2;
    };
    const quadrature = (i, j) => {
      if (!keep(i, j)) return 0;
      if (i === j) return (i === 2 ? sample.sway.damping : sample.roll.damping) * length;
      return ((sample.swayOfRoll.damping + sample.rollOfSway.damping) * length) / 2;
    };
    return { addedMass: matrix(inPhase), damping: matrix(quadrature), diffraction: [] };
  });
  const profile = await coupledRadiationProfile(mesh, {
    mass,
    centre,
    density,
    panels: bakedReference(frequencies, infiniteMass, samples, centre),
  });
  const normalize = density * area * length * beam * scale;
  // The reciprocal experiments peak around x=0.78 (sway into roll) and x=0.86 (roll into sway).
  // Includes half the observed 0.07 frequency sampling interval and half the 0.01 digitization.
  const observed = [0.78, 0.86];
  const reference = [-0.184, -0.142];
  let peak = { x: 0, coefficient: 0 };
  for (let i = 0; i <= 240; i++) {
    const x = 0.4 + (1.2 * i) / 240;
    const coefficient = channel(profile, x * scale, 3, 2)[0] / normalize;
    if (coefficient < peak.coefficient) peak = { x, coefficient };
  }
  assert.ok(peak.x >= observed[0] - 0.04 && peak.x <= observed[1] + 0.04);
  // Compare against the independent prescribed-roll experiment using the discrepancy between
  // the two reciprocal experiments as its uncertainty scale, plus half the ordinate digitization.
  close(peak.coefficient, reference[1], Math.abs(reference[1] - reference[0]) + 0.0005, 'measured coupling crest');
  const massScale = density * area * length * beam;
  // Every shared frequency from x=1 to the last sway experiment point. The two distinct
  // imposed motions give a repeatability scale for the signed cross inertia at each frequency.
  const measuredInertia = [
    [1, -0.03, -0.046],
    [1.07, -0.023, -0.041],
    [1.14, -0.018, -0.041],
    [1.21, -0.017, -0.044],
    [1.28, -0.015, -0.052],
    [1.35, -0.018, -0.06],
  ];
  const compared = measuredInertia.map(([x, roll, sway]) => {
    const predicted = channel(profile, x * scale, 3, 2)[1] / massScale;
    close(predicted, roll, Math.abs(roll - sway) + 0.0005, `measured signed cross inertia at x=${x}`);
    return [x, predicted];
  });
  context.diagnostic(JSON.stringify({ peak, observed, reference, compared, fit: profile.fit }));
});
