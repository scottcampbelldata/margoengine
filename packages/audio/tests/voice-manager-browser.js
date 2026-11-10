import { Audio, AudioListener } from '@margoengine/audio';
import { AudioVoiceManager } from '../dist/voice-manager.js';

async function render(buffer, reference) {
  const context = new OfflineAudioContext(2, 24576, 48000),
    listener = new AudioListener({ context, smoothing: 0 });
  if (reference) {
    const segment = (start, end, offset, detune, gain) => {
      const source = context.createBufferSource(),
        volume = context.createGain();
      source.buffer = buffer;
      source.loop = true;
      source.detune.value = detune;
      volume.gain.value = gain;
      source.connect(volume).connect(listener.input);
      source.start(start, offset);
      source.stop(end);
    };
    segment(0, 0.128, 0, 0, 0.5);
    segment(0.128, 0.256, 0.256, 1200, 0.25);
    segment(0.256, 0.512, 0.256, 0, 0.5);
    const pcm = await context.startRendering();
    listener.dispose();
    return { pcm };
  }
  const manager = new AudioVoiceManager(listener, { maxVoices: 1 });
  const a = manager.add(new Audio(listener, { loop: true, volume: 0.5 }).setBuffer(buffer), { priority: 1 }).play();
  const b = manager.add(new Audio(listener, { loop: true, volume: 0.25, detune: 1200 }).setBuffer(buffer)).play();
  if (manager.activeCount !== 1 || manager.virtualCount !== 1 || !b.isVirtual) throw new Error('Initial physical cap');
  const p1 = context.suspend(0.128),
    p2 = context.suspend(0.256),
    rendering = context.startRendering();
  await p1;
  b.priority = 2;
  if (!a.isVirtual || b.isVirtual || manager.activeCount !== 1 || Math.abs(b.currentTime - 0.256) > 1e-12)
    throw new Error('Virtual pitch phase');
  await context.resume();
  await p2;
  a.priority = 3;
  if (a.isVirtual || !b.isVirtual || manager.activeCount !== 1 || Math.abs(a.currentTime - 0.256) > 1e-12)
    throw new Error('Resumed loop phase');
  await context.resume();
  const pcm = await rendering;
  manager.dispose();
  listener.dispose();
  return { pcm };
}

export async function runVoiceManagerTests() {
  const context = new OfflineAudioContext(2, 24576, 48000);
  const recording = await context.decodeAudioData(await (await fetch('./fixtures/rain-foa.wav')).arrayBuffer());
  const buffer = context.createBuffer(1, 16384, 48000);
  buffer.copyToChannel(recording.getChannelData(0).subarray(0, 16384), 0);
  const { pcm: actual } = await render(buffer, false),
    { pcm: expected } = await render(buffer, true);
  let maxError = 0,
    energy = 0;
  for (let ear = 0; ear < 2; ear++)
    for (let i = 0; i < actual.length; i++) {
      const sample = actual.getChannelData(ear)[i];
      maxError = Math.max(maxError, Math.abs(sample - expected.getChannelData(ear)[i]));
      energy += sample * sample;
    }
  if (maxError > 1e-6 || energy === 0) throw new Error(`Voice phase PCM: ${maxError}, energy ${energy}`);
  return { maxError, energy, cap: 1, segments: [0, 0.128, 0.256, 0.512], virtualPitch: 1200 };
}
