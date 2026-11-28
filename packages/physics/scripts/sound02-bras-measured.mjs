// After building Physics, run:
// node packages/physics/scripts/sound02-bras-measured.mjs "<extracted RS1 folder>/RIRs/wav"
// Aspöck et al., BRAS dataset v3 (2020), RS1 rigid tiled floor, CC BY-SA 4.0.
// https://doi.org/10.14279/depositonce-6726.3
// Source ZIP: https://depositonce.tu-berlin.de/bitstreams/6c82b63c-35be-4348-9f55-cfc9033b5375/download
// SHA-256: 4ab7c960219da32bfd13bcc41c2b61f2ba28cc2d586d2439fac394ab07a5c354
// Extract with `python -m zipfile -e <zip> <outside-repo-directory>`. Use the ten published
// mono `RS1_RIR_Rigid_LS*_MP*.wav` recordings. This script reads but does not redistribute them.
// Geometry inputs are independently surveyed positions labeled in Geometry/RS1_RIR_Rigid.png.
// Acquisition, 2.3 cm distance cross-check and conditions: BRAS Documentation §§3.1, 3.4.1 and
// Appendix A RS1. Companion paper: https://doi.org/10.1016/j.apacoust.2020.107867
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { roomArrivals } from '../dist/room-sound.js';

const directory = process.argv[2];
assert.ok(directory, 'Pass the extracted BRAS RS1 RIRs/wav folder. Download the archive using the script header link.');

// Authors' SketchUp axes are Z-up; permute to the solver's Y-up and convert mm to m.
const speakers = { LS1: [2.902, 1.5, 2.985], LS2: [3.379, 2.121, 2.985], LS3: [4.0, 2.598, 2.985] };
const microphones = {
  MP1: [8.098, 1.5, 2.985],
  MP2: [7.621, 2.121, 2.985],
  MP3: [7.0, 2.598, 2.985],
  MP4: [8.098, 1.573, 2.985],
};
// Interior rectangle of the documented flat tiled floor. The actual polygon edges are unneeded
// for a specular delay as long as the reflection point lies inside this portion of the tiles.
const floor = {
  vertices: [
    [4, 0, 2],
    [7, 0, 2],
    [7, 0, 4],
    [4, 0, 4],
  ],
  reflection: 1,
};
const pairs = [
  ['LS1', 'MP1'],
  ['LS1', 'MP2'],
  ['LS1', 'MP3'],
  ['LS2', 'MP1'],
  ['LS2', 'MP2'],
  ['LS2', 'MP3'],
  ['LS2', 'MP4'],
  ['LS3', 'MP1'],
  ['LS3', 'MP2'],
  ['LS3', 'MP3'],
];

const temperatureCelsius = 20.3;
const relativeHumidity = 0.415;
const nominalPressurePa = 101325;
const surveyedPathAllowanceMetres = 0.023;

function airSoundSpeed() {
  // Ideal-mixture limit of Gavioso et al. 2025, https://doi.org/10.1063/5.0294663.
  // Buck 1981 water saturation pressure, hPa converted to Pa. Use nominal atmospheric pressure.
  const t = temperatureCelsius;
  const saturatedVapourPressure = 611.21 * Math.exp((17.502 * t) / (240.97 + t));
  const vapour = (relativeHumidity * saturatedVapourPressure) / nominalPressurePa;
  const gasConstant = 8.314462618; // J/(mol K)
  const cp = (1 - vapour) * 29.12 + vapour * 33.58; // molar heat capacities at room temperature
  const mass = (1 - vapour) * 0.02896546 + vapour * 0.01801528; // kg/mol
  return Math.sqrt((cp / (cp - gasConstant)) * (gasConstant / mass) * (t + 273.15));
}

function readRecording(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', 'Provide an original BRAS RIFF WAV.');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE', 'Provide an original BRAS RIFF WAV.');
  let rate;
  let samples;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    assert.ok(start + size <= bytes.length, 'The WAV chunk is truncated. Extract the original archive again.');
    if (type === 'fmt ') {
      assert.ok(
        size >= 16 &&
          bytes.readUInt16LE(start) === 3 &&
          bytes.readUInt16LE(start + 2) === 1 &&
          bytes.readUInt16LE(start + 14) === 32,
        'The original mono RS1 WAV uses IEEE float32.',
      );
      rate = bytes.readUInt32LE(start + 4);
    }
    if (type === 'data') {
      assert.equal(size % 4, 0, 'The RS1 WAV data must contain whole float32 samples.');
      samples = Array.from({ length: size / 4 }, (_, i) => bytes.readFloatLE(start + i * 4));
    }
    offset = start + size + (size & 1);
  }
  assert.equal(rate, 44100, 'Expected the 44.1 kHz reference-scene recording.');
  assert.equal(samples?.length, 11025, 'Expected exactly 11,025 samples in the original RS1 RIR.');
  return { rate, samples };
}

function measuredPulses(samples, rate) {
  // A common 25 ms early window leaves the rigid-floor response and the direct arrival before
  // the weak room tail. Require 1.5 ms between the two strongest absolute pressure peaks to
  // avoid picking the next lobe of one pulse. The extractor never sees the predicted times.
  const end = Math.round(0.025 * rate);
  const separation = Math.round(0.0015 * rate);
  const strongest = (exclude) => {
    let peak = -1;
    for (let i = 0; i < end; i++) {
      if (Math.abs(i - exclude) < separation) continue;
      if (peak < 0 || Math.abs(samples[i]) > Math.abs(samples[peak])) peak = i;
    }
    return peak;
  };
  const first = strongest(-Infinity);
  const second = strongest(first);
  assert.ok(
    Math.abs(samples[second]) >= 0.3 * Math.abs(samples[first]),
    'The record does not have two clear early pulses.',
  );
  return [Math.min(first, second), Math.max(first, second)];
}

const soundSpeed = airSoundSpeed();
const soundSpeedSensitivity = 1; // m/s, explicit air-property sensitivity rather than a stated instrument uncertainty
const results = await Promise.all(
  pairs.map(async ([speaker, microphone]) => {
    const file = `RS1_RIR_Rigid_${speaker}_${microphone}.wav`;
    const { samples, rate } = readRecording(await readFile(join(directory, file)));
    const [directSample, reflectedSample] = measuredPulses(samples, rate);
    const observed = ((reflectedSample - directSample) * 1000) / rate;
    const paths = roomArrivals({
      source: speakers[speaker],
      listener: microphones[microphone],
      surfaces: [floor],
      order: 1,
      seconds: 0.025,
      speedOfSound: soundSpeed,
    });
    assert.equal(paths.length, 2, 'The surveyed BRAS setup must give one clear direct and one interior floor path.');
    const [direct, reflected] = paths;
    assert.deepEqual(direct.reflections, []);
    assert.deepEqual(reflected.reflections, [0]);
    const range = reflected.distance - direct.distance;
    const predicted = (reflected.delay - direct.delay) * 1000;
    const speedLow = soundSpeed - soundSpeedSensitivity;
    const speedHigh = soundSpeed + soundSpeedSensitivity;
    const combinedAllowance = 1000 * ((2 * surveyedPathAllowanceMetres) / speedLow + 1 / rate);
    const band = [(1000 * range) / speedHigh - combinedAllowance, (1000 * range) / speedLow + combinedAllowance];
    return {
      file,
      directSample,
      reflectedSample,
      measuredExcessMs: observed,
      predictedExcessMs: predicted,
      residualMs: predicted - observed,
      engineeringBandMs: band,
      insideBand: band[0] <= observed && observed <= band[1],
    };
  }),
);

console.log(
  JSON.stringify(
    {
      source: 'Aspöck et al., BRAS v3, DOI 10.14279/depositonce-6726.3, RS1 rigid floor',
      speedOfSoundMetresPerSecond: soundSpeed,
      scope:
        'Timing from two absolute pressure peaks in the measured mono impulse response. Loudspeaker phase, amplitude and reverberation are outside this comparison.',
      uncertainty:
        'Engineering allowance, not a confidence interval. Includes the authors’ observed 2.3 cm cross-check discrepancy for each path, one sample of difference quantization and an assumed ±1 m/s air-model sensitivity. The geometry cross-check used direct arrivals only. No specular group-delay uncertainty was published.',
      results,
    },
    null,
    2,
  ),
);
