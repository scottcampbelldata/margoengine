// Synthesized gym sounds through @margoengine/audio: a chalk puff, a grip squeak, a landing and a low room tone. No audio
// files. main.ts imports this module only when the visitor presses Sound.
import { Audio, AudioListener, AudioVoicePool } from '@margoengine/audio';

function buffer(context: BaseAudioContext, seconds: number, write: (t: number, i: number) => number): AudioBuffer {
  const length = Math.floor(seconds * context.sampleRate),
    out = context.createBuffer(1, length, context.sampleRate),
    data = out.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = write(i / context.sampleRate, i);
  return out;
}

// Seeded noise, so the sounds are the same each time.
function noise(seed: number): () => number {
  let a = seed;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) | 0;
    return a / 2147483648;
  };
}

export type SoundName = 'grip' | 'chalk' | 'land';

export interface GymSound {
  play(name: SoundName, position: readonly [number, number, number]): void;
  setEnabled(on: boolean): void;
  dispose(): void;
}

export function createSound(engine: never): GymSound {
  const listener = AudioListener.attach(engine, { volume: 0.7 }),
    context = listener.context as BaseAudioContext,
    hiss = noise(7),
    thud = noise(11),
    room = noise(3);
  const grip = new AudioVoicePool(
      listener,
      buffer(context, 0.12, (t) => Math.sin(2 * Math.PI * (1400 - 5000 * t) * t) * Math.exp(-t * 34) * 0.5),
      { voices: 4, refDistance: 2 },
    ),
    chalk = new AudioVoicePool(
      listener,
      buffer(context, 0.32, (t) => hiss() * Math.exp(-t * 13) * 0.35),
      { voices: 4, refDistance: 2 },
    ),
    land = new AudioVoicePool(
      listener,
      buffer(context, 0.4, (t) => (Math.sin(2 * Math.PI * 70 * t) + thud() * 0.5) * Math.exp(-t * 11) * 0.8),
      { voices: 2, refDistance: 3 },
    );
  let last = 0;
  const tone = new Audio(listener, { volume: 0.08 });
  tone.setBuffer(
    buffer(context, 4, (t) => {
      last += (room() - last) * 0.03;
      // A fade at both ends so the loop has no click.
      return last * Math.min(1, t * 4, (4 - t) * 4);
    }),
  );
  tone.loop = true;
  tone.fadeIn(0.5);
  let enabled = true;
  const pools: Record<SoundName, AudioVoicePool> = { grip, chalk, land };
  return {
    play(name, position) {
      if (enabled) pools[name].play(position as [number, number, number], { volume: 0.8 });
    },
    setEnabled(on) {
      enabled = on;
      listener.volume = on ? 0.7 : 0;
    },
    dispose() {
      (engine as unknown as { removePlugin(name: string): void }).removePlugin(listener.name);
    },
  };
}
