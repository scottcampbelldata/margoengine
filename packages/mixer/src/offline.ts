// Deterministic offline rendering: build a mixer on an OfflineAudioContext, schedule sources on its clock, render to
// an AudioBuffer faster than real time. Same graph and same inputs give the same samples, so tests can compare numbers.
import { MargoError } from '@margoengine/math/errors';
import { Mixer, type MixerOptions } from './mixer.js';

/** Settings of {@link renderOffline}. */
export interface RenderOptions {
  /** Length of the render in seconds, above 0. */
  seconds: number;
  /** Samples per second. Default 48000. */
  sampleRate?: number;
  /** Output channels, 1 to 8. Default 2. */
  channels?: number;
  /** Mixer settings (buses, master gain, master effects). */
  mixer?: MixerOptions;
  /**
   * Stops waiting. A render in progress cannot be interrupted by Web Audio, so an abort during it makes the promise
   * reject with the signal's reason as soon as it is observed after the render and drops the result.
   */
  signal?: AbortSignal;
}

/** What {@link renderOffline} hands to its setup function. */
export interface RenderScene {
  /** The offline context (time 0 until rendering starts). */
  context: OfflineAudioContext;
  /** A mixer on that context. */
  mixer: Mixer;
}

/**
 * Renders a mixer graph offline. `setup` creates sources and schedules their start times, fades and ducks on the
 * context clock (it may be async, for example to load files); then the graph renders and the AudioBuffer is returned.
 * The mixer is disposed afterwards.
 * @example
 * const buffer = await renderOffline({seconds: 2}, ({context, mixer}) => {
 *   const tone = new OscillatorNode(context, {frequency: 440});
 *   mixer.route(tone, mixer.createBus('tones', {effects: [{type: 'reverb', mix: 0.3}]}));
 *   tone.start(0);
 *   tone.stop(1);
 * });
 */
export async function renderOffline(
  options: RenderOptions,
  setup: (scene: RenderScene) => void | Promise<void>,
): Promise<AudioBuffer> {
  const { seconds, sampleRate = 48000, channels = 2, signal } = options;
  if (typeof OfflineAudioContext === 'undefined')
    throw new MargoError('unsupported', 'OfflineAudioContext is not available here; render in a browser');
  if (!(seconds > 0) || !Number.isFinite(seconds)) throw new RangeError(`seconds must be above 0, got ${seconds}`);
  if (!Number.isInteger(channels) || channels < 1 || channels > 8)
    throw new RangeError(`channels must be an integer from 1 to 8, got ${channels}`);
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000)
    throw new RangeError(`sampleRate must be between 8000 and 96000, got ${sampleRate}`);
  signal?.throwIfAborted();
  const context = new OfflineAudioContext(channels, Math.ceil(seconds * sampleRate), sampleRate);
  const mixer = new Mixer(context, options.mixer);
  try {
    await setup({ context, mixer });
    signal?.throwIfAborted();
    const buffer = await context.startRendering();
    signal?.throwIfAborted();
    return buffer;
  } finally {
    mixer.dispose();
  }
}

/** The channels of a buffer as copies, in order. */
export function bufferChannels(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i).slice());
}
