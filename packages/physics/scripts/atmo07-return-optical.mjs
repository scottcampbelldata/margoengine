// Normalized early return-stroke optical diagnostic. Run this file directly with Node.
// Quick & Krider (2017), https://doi.org/10.1002/2017JD027363, Figures 1–2 and
// black current curves in the lower-right panels of Figures 5, 6 and 8.
// Figure 2 is separate detector calibration. Optical targets are the published
// timings in sections 3.1–3.2 and are not used by the forward model.
// Source PDF SHA-256: 73ef4deb4cbee1423dda2aa09b004f1e512f9fb94b7969c8071e86f67e95d08e.
import assert from 'node:assert/strict';

const start = -0.9;
const spacing = 0.1; // Microseconds, matching the reported 10 MHz acquisition.
const end = 4.9;
const records = [
  {
    event: 'UF11-15 stroke 10, Figure 5',
    peakKA: 10.4,
    currentRise: 0.5,
    current: [
      0.007,
      0.007,
      0.009,
      0.009,
      0.011,
      0.014,
      0.018,
      0.031,
      0.036,
      0.043,
      0.051,
      0.054,
      0.065,
      0.094,
      0.221,
      0.399,
      0.551,
      0.764,
      0.958,
      0.998,
      0.993,
      0.929,
      0.906,
      0.877,
      0.835,
      null,
      0.793,
      0.772,
      0.754,
      0.736,
      0.732,
      null,
      0.721,
      0.707,
      0.696,
      0.687,
      0.674,
      0.667,
      0.656,
      0.645,
      0.634,
      0.623,
      0.614,
      0.603,
      0.594,
      0.583,
      0.574,
      0.567,
      0.56,
      0.554,
      0.551,
      0.547,
      0.543,
      0.54,
      0.536,
      0.533,
      0.529,
      0.522,
      0.518,
    ],
    heldOut: { lower: [1.0, 1.3], upper: [1.7, 2.4] },
  },
  {
    event: 'UF11-28 stroke 1, Figure 6',
    peakKA: 19.3,
    currentRise: 0.3,
    current: [
      0.002,
      0.002,
      0.0,
      0.002,
      0.004,
      0.004,
      0.008,
      0.015,
      0.025,
      0.042,
      0.117,
      0.336,
      0.651,
      0.894,
      0.974,
      0.996,
      0.983,
      0.977,
      0.972,
      0.96,
      0.949,
      0.942,
      0.932,
      0.919,
      0.908,
      0.902,
      0.889,
      0.883,
      0.877,
      null,
      0.862,
      0.849,
      0.843,
      0.84,
      0.832,
      0.828,
      0.819,
      0.809,
      0.806,
      0.794,
      0.791,
      0.783,
      0.775,
      0.774,
      0.76,
      0.753,
      0.742,
      0.734,
      0.726,
      0.728,
      0.73,
      0.728,
      0.725,
      0.719,
      0.713,
      0.715,
      0.711,
      0.704,
      0.708,
    ],
    heldOut: { lower: [1.0, 1.2], upper: [1.7, 2.2] },
  },
  {
    event: 'UF12-42 stroke 3, Figure 8',
    peakKA: 12.2,
    currentRise: 0.2,
    current: [
      0.004, 0.004, 0.005, 0.007, 0.009, 0.011, 0.014, 0.018, 0.022, 0.036, 0.089, 0.308, 0.719, 0.935, 0.987, 0.993,
      0.978, 0.953, 0.953, 0.933, 0.913, 0.92, 0.911, 0.906, 0.906, 0.9, 0.886, 0.88, 0.866, 0.855, 0.85, 0.859, 0.851,
      0.844, 0.835, 0.822, 0.81, 0.806, 0.793, 0.784, 0.772, 0.775, 0.772, 0.763, 0.757, 0.746, 0.75, 0.739, 0.734,
      0.736, 0.743, 0.734, 0.716, 0.712, 0.707, 0.714, 0.721, 0.708, 0.703,
    ],
    heldOut: { narrow: [0.7, 0.9] },
  },
];

// Each ordinate has about a few pixels of extraction uncertainty (~.01 in relative
// units), in addition to the published calibration scatter in Figure 2. Where
// the two calibration curves overlap near normal incidence, use their common level.
const wideResponse = {
  start: -44,
  step: 2,
  values: [
    0.01, 0.013, 0.025, 0.056, 0.149, 0.294, 0.446, 0.575, 0.688, 0.755, 0.812, 0.847, 0.875, 0.906, 0.926, 0.95, 0.964,
    0.979, 0.987, 0.986, 0.987, 0.992, 1.0, 0.994, 0.993, 0.99, 0.979, 0.97, 0.952, 0.925, 0.88, 0.824, 0.757, 0.677,
    0.563, 0.436, 0.262, 0.125, 0.024, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
  ],
};
const narrowResponse = {
  start: -11,
  step: 1,
  values: [
    0.0, 0.008, 0.068, 0.484, 0.732, 0.898, 0.93, 0.949, 0.966, 0.975, 0.982, 1.0, 0.994, 0.993, 0.992, 0.99, 0.99,
    0.988, 0.942, 0.745, 0.479, 0.134, 0.013, 0.0,
  ],
};
const receivers = {
  lower: { elevation: 18, response: wideResponse },
  upper: { elevation: 37, response: wideResponse },
  narrow: { elevation: 10, response: narrowResponse },
};
const range = 198;
const lightMetresPerMicrosecond = 299.792458;
// Independent speed of the current front, not measured from these radiometer traces.
// Willett et al. (2008), https://doi.org/10.1029/2006JD008116, Table 5.
// The ±24 m/µs values are the independent sample's spread, not a fit range.
const speeds = [180, 156, 204];
const resolutionAllowance = 0.2; // Two crossings/peaks at published 0.1 µs precision.

function interpolate(values, index) {
  if (index < 0 || index > values.length - 1) return 0;
  const j = Math.floor(index);
  const fraction = index - j;
  return values[j] + fraction * ((values[j + 1] ?? values[j]) - values[j]);
}

function decodeCurrent(record) {
  assert.equal(record.current.length, Math.round((end - start) / spacing) + 1);
  // Crossings of the coloured optical traces hide three black samples. Interpolate
  // only from neighbouring black samples, keeping the missing data explicit above.
  return record.current.map((value, j, values) => {
    const normalised = value ?? (values[j - 1] + values[j + 1]) / 2;
    return normalised * record.peakKA;
  });
}

function timing(samples, step) {
  const peak = samples.reduce((best, value, j) => (value > samples[best] ? j : best), 0);
  assert.ok(peak > 0 && peak < samples.length - 1, 'The recorded window must contain the peak');
  function firstCrossing(ratio) {
    const threshold = samples[peak] * ratio;
    const j = samples.findIndex((value) => value >= threshold);
    assert.ok(j > 0 && j < peak, 'The recorded window must contain both rising crossings');
    return start + step * (j - 1 + (threshold - samples[j - 1]) / (samples[j] - samples[j - 1]));
  }
  return { rise: firstCrossing(0.9) - firstCrossing(0.1), peak: start + step * peak };
}

function pulseAtReceiver(current, { elevation, response }, speed, dz, dt) {
  const taps = [];
  // The graph's final supported relative angle bounds the height integration.
  const endAngle = response.start + response.step * (response.values.length - 1);
  const height = range * Math.tan(((endAngle + elevation) * Math.PI) / 180);
  for (let z = dz / 2; z < height; z += dz) {
    const distance = Math.hypot(range, z);
    const angle = (Math.atan2(z, range) * 180) / Math.PI - elevation;
    const sensitivity = interpolate(response.values, (angle - response.start) / response.step);
    if (sensitivity <= 0) continue;
    // Quick & Krider §3 time-shifted measured irradiance by the horizontal path D/c.
    const delay = z / speed + (distance - range) / lightMetresPerMicrosecond;
    // Isotropic line source: dE = (power per metre) × dz × sensitivity / (4πR²).
    // Quick & Krider Eq. (1) is its short advancing front limit. Figure 2 already
    // includes angular projection, and the common factor 1/(4π) cancels in timing.
    taps.push({ delay, weight: (dz * sensitivity) / (distance * distance) });
  }

  // Early-time per-metre light proxy proportional to current amplitude, based on
  // Wang et al. (2005), https://doi.org/10.1016/j.atmosres.2004.11.025.
  // Extending this local ground observation up a straight channel and past the local
  // peak is a model hypothesis. The integral includes no attenuation, in-channel
  // waveform broadening, excitation delay, or separate leader radiation.
  // da Silva et al. (2019), https://doi.org/10.1029/2019JD030693, use
  // per-metre power η_vis × 4π × ε(T) × πr_c² (§3.4, p. 9457) and fit
  // the optical fraction to Quick & Krider's 2012 measurements. That fraction
  // cannot be used to predict this holdout. The present scale cancels in rise times.
  const samples = Array.from({ length: Math.round((end - start) / dt) + 1 }, (_, j) => {
    const time = start + j * dt;
    let signal = 0;
    for (const { delay, weight } of taps) {
      signal += weight * interpolate(current, (time - delay - start) / spacing);
    }
    return signal;
  });
  return timing(samples, dt);
}

function score(predicted, observed) {
  const error = predicted - observed;
  return { predicted, observed, error, withinTimingAllowance: Math.abs(error) <= resolutionAllowance };
}

const cases = records.map((record) => {
  const current = decodeCurrent(record);
  const reference = timing(current, spacing);
  assert.ok(Math.abs(reference.rise - record.currentRise) < 0.1, 'Reproduce the published input rise');
  const predictions = speeds.map((speed) => {
    const byReceiver = Object.entries(record.heldOut).map(([name, [observedRise, observedDelay]]) => {
      const coarse = pulseAtReceiver(current, receivers[name], speed, 0.5, 0.01);
      const fine = pulseAtReceiver(current, receivers[name], speed, 0.25, 0.005);
      assert.ok(
        Math.abs(coarse.rise - fine.rise) < 0.02 && Math.abs(coarse.peak - fine.peak) < 0.02,
        'Independent quadrature refinement must change both timings by less than 0.02 µs',
      );
      return [
        name,
        {
          rise: score(fine.rise, observedRise),
          peakDelay: score(fine.peak - reference.peak, observedDelay),
        },
      ];
    });
    const results = Object.fromEntries(byReceiver);
    if (results.lower) {
      results.differentialPeakDelay = score(
        results.upper.peakDelay.predicted - results.lower.peakDelay.predicted,
        record.heldOut.upper[1] - record.heldOut.lower[1],
      );
    }
    return { speedMetresPerMicrosecond: speed, results };
  });
  return { event: record.event, currentRiseMicroseconds: reference.rise, predictions };
});

console.log(JSON.stringify({ units: 'microseconds', timingAllowance: resolutionAllowance, cases }, null, 2));
