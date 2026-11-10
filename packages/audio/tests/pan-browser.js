import { AudioListener } from '@margoengine/audio';
import { StereoAudio } from '../dist/pan.js';

export async function runPanTests() {
  const results = [];
  for (const channels of [1, 2])
    for (const pan of [-1, 0, 1]) {
      const context = new OfflineAudioContext(2, 2048, 48000);
      const listener = new AudioListener({ context, smoothing: 0 });
      const buffer = context.createBuffer(channels, 2048, 48000);
      buffer.getChannelData(0).fill(0.25);
      if (channels === 2) buffer.getChannelData(1).fill(0.5);
      const sound = new StereoAudio(listener, { pan }).setBuffer(buffer).play();
      const output = await context.startRendering();
      const expected =
        channels === 1
          ? pan === 0
            ? [Math.SQRT1_2 * 0.25, Math.SQRT1_2 * 0.25]
            : pan < 0
              ? [0.25, 0]
              : [0, 0.25]
          : pan === 0
            ? [0.25, 0.5]
            : pan < 0
              ? [0.75, 0]
              : [0, 0.75];
      for (let ear = 0; ear < 2; ear++) {
        const sample = output.getChannelData(ear)[1024];
        if (Math.abs(sample - expected[ear]) > 1e-6) throw new Error(`Stereo pan ${channels}/${pan}/${ear}: ${sample}`);
      }
      results.push({ channels, pan, expected });
      sound.dispose();
      listener.dispose();
    }
  return results;
}
