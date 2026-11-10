import { AudioListener } from '@margoengine/audio';
import { AudioSpriteBank, loadAudioFallback } from '../dist/sprites.js';

export async function runSpriteTests() {
  const context = new OfflineAudioContext(2, 24000, 48000),
    listener = new AudioListener({ context, smoothing: 0 });
  const probe = document.createElement('audio'),
    requested = [];
  const decoded = await loadAudioFallback(
    listener,
    [{ url: 'never', type: 'audio/x-unsupported' }, 'failed.wav', './fixtures/rain-foa.wav'],
    {
      canPlayType: (type) => probe.canPlayType(type),
      fetch: async (url, init) => {
        requested.push(url);
        return url === 'failed.wav' ? new Response('', { status: 503 }) : fetch(url, init);
      },
    },
  );
  if (requested.join('|') !== 'failed.wav|./fixtures/rain-foa.wav')
    throw new Error(`Codec fallback order: ${requested}`);
  const buffer = context.createBuffer(1, 48000, 48000);
  buffer.copyToChannel(decoded.getChannelData(0).subarray(0, 48000), 0);
  const bank = new AudioSpriteBank(listener, buffer, {
    hit: { offset: 0.125, duration: 0.125 },
    loop: { offset: 0.5, duration: 0.125, loop: true },
  });
  bank.play('hit', { volume: 0.5 });
  bank.play('loop', { volume: 0.25 }, 0.125);
  const pcm = await context.startRendering(),
    data = buffer.getChannelData(0);
  let maxError = 0,
    energy = 0;
  for (let ear = 0; ear < 2; ear++)
    for (let i = 0; i < pcm.length; i++) {
      const expected = i < 6000 ? data[6000 + i] * 0.5 : data[24000 + ((i - 6000) % 6000)] * 0.25;
      const actual = pcm.getChannelData(ear)[i];
      maxError = Math.max(maxError, Math.abs(actual - expected));
      energy += actual * actual;
    }
  if (maxError > 1e-6 || energy === 0) throw new Error(`Sprite PCM ${maxError}, energy ${energy}`);
  bank.dispose();
  listener.dispose();
  return { requested, maxError, energy, frames: pcm.length };
}
