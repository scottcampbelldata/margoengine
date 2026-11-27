import { harmonicOrders, coefficient, fundamentalHz } from './model.js';

export function soundEngine(context) {
  const volume = context.createGain();
  volume.gain.value = 0;
  volume.connect(context.destination);
  const begin = context.currentTime + .015;
  const parts = harmonicOrders.map((order) => {
    const tone = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0;
    tone.type = 'sine';
    tone.frequency.value = fundamentalHz * order;
    tone.connect(gain).connect(volume);
    tone.start(begin);
    return { tone, gain, order };
  });

  return {
    update(count, listening) {
      const now = context.currentTime;
      for (const [i, { gain, order }] of parts.entries()) {
        gain.gain.setTargetAtTime(i < count ? coefficient(order) : 0, now, .024);
      }
      volume.gain.setTargetAtTime(listening ? .075 : 0, now, .020);
    },
    stop() {
      for (const { tone } of parts) tone.stop();
      return context.close();
    },
  };
}

