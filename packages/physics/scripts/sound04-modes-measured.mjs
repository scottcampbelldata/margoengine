// Dumond, Monette, Alladkani, Akl & Chikhaoui (2019), Simplified setup for the vibration study of plates
// with simply-supported boundary conditions, https://doi.org/10.1016/j.mex.2019.09.023 (CC BY 4.0).
// Tables 3–4 provide nominal material constants and dimensions; Table 5 provides the held-out test results.
// Only the first flat plate at each thickness is used. Both measured methods are retained, along with all
// six reported modes. Table 3's density exponent is a typographical error: 2.70 g/cm³ (2700 kg/m³) is the
// nominal alloy density and yields the approximately 0.10 kg Plate 1 mass described by the authors.
// Arthur W. Leissa (1969), Vibration of Plates, NASA SP-160, https://ntrs.nasa.gov/citations/19700009156.
// Run: node scripts/run-with-timeout.mjs --max=1 -- node packages/physics/scripts/sound04-modes-measured.mjs

import assert from 'node:assert/strict';
import { MODAL_CONTACT_WORDS, ModalSoundSolver } from '../dist/modal-sound.js';
import { PhysicsWorld, regionWords, worldMemory } from '../dist/world.js';

const frames = 60;
const cell = [0, 0, 0];
const material = { young: 68.9e9, density: 2700, poisson: 0.33 };
const modeIndices = [
  [1, 1],
  [2, 1],
  [1, 2],
  [2, 2],
  [3, 1],
  [1, 3],
];

// Observations are kept as strings to retain the published precision, including integer entries.
const plates = [
  {
    number: 1,
    length: 0.2467,
    width: 0.1861,
    thickness: 0.00081,
    speaker: ['92.4', '195.4', '263.4', '359.4', '350.6', '542.7'],
    hammer: ['90.4', '174.9', '254.6', '342', '333.6', '540.8'],
  },
  {
    number: 4,
    length: 0.2465,
    width: 0.1862,
    thickness: 0.00123,
    speaker: ['141.4', '287.5', '396.4', '548.5', '532.8', '823.5'],
    hammer: ['139.8', '284.4', '392.6', '541', '522.5', '812.3'],
  },
];

function plateFrequency({ length, width, thickness }, [m, n], { young, density, poisson } = material) {
  // The double sine satisfies w = 0 and vanishing edge moment. Substituting into
  // D ∇⁴w + ρh w_tt = 0 gives ω² = D k⁴/(ρh); divide ω by 2π to get Hz.
  const rigidity = (young * thickness ** 3) / (12 * (1 - poisson ** 2));
  const mode = (m / length) ** 2 + (n / width) ** 2;
  return (Math.PI / 2) * Math.sqrt(rigidity / (density * thickness)) * mode;
}

function inputRoundingRange(plate, order) {
  const extreme = (sign) =>
    plateFrequency(
      {
        length: plate.length - sign * 0.00005,
        width: plate.width - sign * 0.00005,
        thickness: plate.thickness + sign * 0.000005,
      },
      order,
      {
        young: material.young + sign * 0.05e9,
        density: material.density - sign * 5,
        poisson: material.poisson + sign * 0.0005,
      },
    );
  return [extreme(-1), extreme(1)];
}

class Tap {
  constructor(field, tracks) {
    this.field = field;
    this.tracks = tracks;
  }

  describe() {
    return { id: 'plate-tap', rate: 0, stableRate: () => 0, fields: [{ field: this.field, access: 'write' }] };
  }

  init(host) {
    this.memory = host.memory;
    this.contact = host.allocate('contact', this.tracks * MODAL_CONTACT_WORDS * 8, 'f64', 1);
  }

  step({ tick }) {
    const words = regionWords(this.memory, this.contact);
    words.fill(0);
    // Uniform testing impulse in N s, unrelated to actual loading. Gain/decay below are arbitrary
    // readout settings as the resonator takes damped frequencies directly. Only frequency is scored.
    for (let track = 0; track < this.tracks; track++) words[track * MODAL_CONTACT_WORDS] = tick === 0 ? 1 : 0;
  }

  exportPorts(tick) {
    return [{ field: this.field.name, region: this.contact, cell, tick }];
  }

  importPorts() {}

  stateRegions() {
    return [this.contact];
  }

  extraState() {
    return [];
  }
}

function pcmFrequency({ samples, sampleRate }) {
  let count = 0;
  let first = 0;
  let last = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 && samples[i] >= 0) {
      const crossing = i - samples[i] / (samples[i] - samples[i - 1]);
      if (count === 0) first = crossing;
      last = crossing;
      count++;
    }
  }
  assert.ok(count > 2, 'The production PCM must resolve multiple full oscillations.');
  const span = last - first;
  const periods = count - 1;
  return {
    hz: (periods * sampleRate) / span,
    // Each measured crossing brackets the true zero within one sample; differencing gives ±2.
    range: [(periods * sampleRate) / (span + 2), (periods * sampleRate) / (span - 2)],
  };
}

async function render(frequencies, sampleRate) {
  const sound = await ModalSoundSolver.load();
  // Isolate each indexed tone in its own PCM track to avoid assuming any experimental gain/phase.
  const tracks = frequencies.map((frequency) => ({ material: { modes: [{ frequency, decay: 4, gain: 0.1 }] } }));
  const world = new PhysicsWorld({ rate: { num: frames, den: 1 }, memory: worldMemory(false) });
  world.add(new Tap(sound.contactField, tracks.length), {}).add(sound, { tracks, sampleRate, historySeconds: 1 });
  world.advance(frames);
  return tracks.map((_, track) => {
    const block = sound.copySince(0, track);
    assert.equal(block.firstSample, 0);
    assert.equal(block.sampleRate, sampleRate);
    assert.equal(block.samples.length, sampleRate);
    return pcmFrequency(block);
  });
}

function compare(text, pcm, inputRange) {
  const measured = Number(text);
  const decimals = text.split('.')[1]?.length ?? 0;
  // Table precision alone permits this rounding interval. It does not bound instrument,
  // boundary support repeatability, sensor loading, damping, or variation in the alloy.
  const displayHalfWidth = 0.5 * 10 ** -decimals;
  const pcmHalfWidth = Math.max(pcm.hz - pcm.range[0], pcm.range[1] - pcm.hz);
  return {
    measuredHz: measured,
    residualHz: pcm.hz - measured,
    errorPercent: 100 * (pcm.hz / measured - 1),
    displayHalfWidthHz: displayHalfWidth,
    intersectsRoundingAndReadout:
      measured + displayHalfWidth >= inputRange[0] - pcmHalfWidth &&
      measured - displayHalfWidth <= inputRange[1] + pcmHalfWidth,
  };
}

const inputs = plates.flatMap((plate) => modeIndices.map((order, j) => ({ plate, order, j })));
const frequencies = inputs.map(({ plate, order }) => plateFrequency(plate, order));
const [low, high] = await Promise.all([render(frequencies, 24000), render(frequencies, 48000)]);
const results = inputs.map(({ plate, order, j }, i) => {
  for (const { range } of [low[i], high[i]])
    assert.ok(
      range[0] <= frequencies[i] && frequencies[i] <= range[1],
      `Tone ${i} is outside its PCM crossing bracket.`,
    );
  const rounding = inputRoundingRange(plate, order);
  return {
    plate: plate.number,
    mode: order,
    theoryHz: frequencies[i],
    pcmHz: high[i].hz,
    pcmRangeHz: high[i].range,
    sampleRateChangeHz: Math.abs(high[i].hz - low[i].hz),
    inputRoundingHz: rounding,
    speaker: compare(plate.speaker[j], high[i], rounding),
    hammer: compare(plate.hammer[j], high[i], rounding),
  };
});
console.log(
  JSON.stringify(
    {
      source: 'https://doi.org/10.1016/j.mex.2019.09.023',
      scope: 'Ideal simply-supported thin-plate frequencies supplied by the script and measured from production PCM.',
      limits:
        'Reported-precision overlap is descriptive. The paper gives no per-result confidence intervals. Frame, sensors, damping, mode shapes and radiation are outside this comparison.',
      sampleRatesHz: [24000, 48000],
      results,
    },
    null,
    2,
  ),
);
