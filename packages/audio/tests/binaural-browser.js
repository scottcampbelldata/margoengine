import { AudioListener } from '@margoengine/audio';
import { BinauralAudio } from '../dist/binaural.js';

const basis = (x, y, z) => [
  1,
  y,
  z,
  x,
  Math.sqrt(3) * x * y,
  Math.sqrt(3) * y * z,
  (3 * z * z - 1) / 2,
  Math.sqrt(3) * x * z,
  (Math.sqrt(3) / 2) * (x * x - y * y),
  Math.sqrt(5 / 8) * y * (3 * x * x - y * y),
  Math.sqrt(15) * x * y * z,
  Math.sqrt(3 / 8) * y * (5 * z * z - 1),
  (z * (5 * z * z - 3)) / 2,
  Math.sqrt(3 / 8) * x * (5 * z * z - 1),
  (Math.sqrt(15) / 2) * z * (x * x - y * y),
  Math.sqrt(5 / 8) * x * (x * x - 3 * y * y),
];

async function render(buffer, reference, rotated) {
  const context = new OfflineAudioContext(2, 12288, 48000);
  const listener = new AudioListener({ context, smoothing: 0 });
  listener.follow(null).setPose([0, 0, 0], [0, 0, -1]);
  let bed;
  if (!reference) {
    bed = new BinauralAudio(listener, buffer, { loop: true });
    if (rotated) bed.setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    bed.play();
  } else {
    // Independent polynomial basis and offline speaker signals, rather than the production gain graph.
    for (const sign of [-1, 1])
      for (const ring of [-1, 1]) {
        const z = sign * Math.sqrt((3 + ring * 2 * Math.sqrt(6 / 5)) / 7),
          radius = Math.sqrt(1 - z * z);
        const weight = (18 - ring * Math.sqrt(30)) / 576;
        for (let a = 0; a < 8; a++) {
          const x = radius * Math.cos((a * Math.PI) / 4),
            y = radius * Math.sin((a * Math.PI) / 4),
            coefficients = basis(x, y, z);
          const mono = context.createBuffer(1, buffer.length, 48000),
            data = mono.getChannelData(0);
          for (let i = 0; i < data.length; i++)
            for (let c = 0; c < buffer.numberOfChannels; c++)
              data[i] += buffer.getChannelData(c)[i] * coefficients[c] * (2 * Math.floor(Math.sqrt(c)) + 1) * weight;
          const p = context.createPanner();
          p.panningModel = 'HRTF';
          p.rolloffFactor = 0;
          p.positionX.value = rotated ? -x : -y;
          p.positionY.value = z;
          p.positionZ.value = rotated ? y : -x;
          p.connect(listener.input);
          const source = context.createBufferSource();
          source.buffer = mono;
          source.loop = true;
          source.connect(p);
          source.start();
        }
      }
  }
  const output = await context.startRendering();
  bed?.dispose();
  listener.dispose();
  return output;
}

export async function runBinauralTests() {
  const context = new OfflineAudioContext(2, 12288, 48000),
    results = [];
  const recording = await context.decodeAudioData(await (await fetch('./fixtures/rain-foa.wav')).arrayBuffer());
  for (const channels of [4, 9, 16])
    for (const rotated of [false, true]) {
      const buffer = context.createBuffer(channels, 4096, 48000);
      for (let c = 0; c < channels; c++)
        for (let i = 0; i < buffer.length; i++)
          buffer.getChannelData(c)[i] =
            c < 4
              ? recording.getChannelData(c)[i] * 0.1
              : 0.005 * Math.sin((2 * Math.PI * (300 + c * 100) * i) / 48000);
      const actual = await render(buffer, false, rotated),
        expected = await render(buffer, true, rotated);
      let maxError = 0,
        energy = 0;
      for (let ear = 0; ear < 2; ear++)
        for (let i = 0; i < actual.length; i++) {
          const value = actual.getChannelData(ear)[i];
          if (!Number.isFinite(value)) throw new Error('Nonfinite binaural PCM');
          maxError = Math.max(maxError, Math.abs(value - expected.getChannelData(ear)[i]));
          energy += value * value;
        }
      if (maxError > 1e-6 || energy <= 1e-12)
        throw new Error(`Binaural ${channels}/${rotated}: error=${maxError}, energy=${energy}`);
      results.push({ channels, rotated, maxError, energy });
    }
  return results;
}
