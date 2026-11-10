/// <reference lib="esnext.disposable" preserve="true" />
// Effects built from Web Audio nodes: an equaliser, a filter, a compressor, a limiter, a feedback delay and a
// convolution reverb. Each is described by a plain object (so a chain can be saved as JSON) and created on any
// BaseAudioContext, real or offline.
import { MargoError } from '@margoengine/math/errors';
import { defaultQ, impulseResponse, type BiquadKind } from './dsp.js';

/** One band of an equaliser. */
export interface EqBand {
  /** Filter shape. Default `'peaking'`. */
  type?: BiquadKind;
  /** Centre or corner frequency in Hz, 10 to the Nyquist frequency. */
  frequency: number;
  /** Quality factor (resonance in dB for lowpass and highpass). Default {@link defaultQ}. */
  q?: number;
  /** Boost or cut in dB for `peaking` and the shelves. Default 0. */
  gain?: number;
}

/** Description of an effect. `type` picks the kind; every other field is optional unless marked. */
export type EffectSpec =
  | { type: 'eq'; bands: readonly EqBand[] }
  | { type: 'filter'; filter: BiquadKind; frequency: number; q?: number; gain?: number }
  | { type: 'compressor'; threshold?: number; knee?: number; ratio?: number; attack?: number; release?: number }
  | { type: 'limiter'; ceiling?: number; release?: number }
  | { type: 'delay'; time?: number; feedback?: number; mix?: number; maxTime?: number }
  | {
      type: 'reverb';
      seconds?: number;
      decay?: number;
      preDelay?: number;
      mix?: number;
      seed?: number;
      /** A recorded room (for example from {@link loadImpulse}) instead of the synthetic one. */
      impulse?: AudioBuffer;
    };

/** A running effect: connect into `input`, take sound from `output`. */
export interface Effect extends Disposable {
  /** The spec's `type`. */
  readonly kind: EffectSpec['type'];
  /** Where sound goes in. */
  readonly input: AudioNode;
  /** Where processed sound comes out. */
  readonly output: AudioNode;
  /** Named AudioParams you can automate, for example `frequency`, `gain`, `threshold`, `feedback`, `time`. */
  readonly params: Readonly<Record<string, AudioParam>>;
  /** For delay and reverb: sets the wet share 0..1 (dry is 1 minus it) at AudioContext time `at` (default now). */
  setMix?(mix: number, at?: number): void;
  /** Disconnects every node; the effect cannot be used afterwards. */
  dispose(): void;
}

const num = (value: unknown, name: string, min: number, max: number, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value))
    throw new TypeError(`${name} must be a number, got ${String(value)}`);
  if (value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}, got ${value}`);
  return value;
};

function make(
  kind: EffectSpec['type'],
  input: AudioNode,
  output: AudioNode,
  nodes: AudioNode[],
  params: Record<string, AudioParam>,
  setMix?: (mix: number, at?: number) => void,
): Effect {
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const node of nodes) node.disconnect();
  };
  const effect: Effect = { kind, input, output, params, dispose, [Symbol.dispose]: dispose };
  if (setMix) effect.setMix = setMix;
  return effect;
}

function biquad(context: BaseAudioContext, band: EqBand, index: string): BiquadFilterNode {
  const type = band.type ?? 'peaking';
  if (!['lowpass', 'highpass', 'bandpass', 'notch', 'allpass', 'peaking', 'lowshelf', 'highshelf'].includes(type))
    throw new TypeError(
      `${index}: unknown filter type "${String(type)}"; use lowpass, highpass, bandpass, notch, allpass, peaking, lowshelf or highshelf`,
    );
  const node = context.createBiquadFilter();
  node.type = type;
  node.frequency.value = num(band.frequency, `${index} frequency`, 10, context.sampleRate / 2, 1000);
  // The same q ranges as biquadCoefficients: for bandpass, notch, allpass and peaking alpha = sin(w0) / 2q has no
  // filter of the kind at q <= 0 (division by zero, or poles outside the unit circle), and resonance stops at 100 dB.
  const resonance = type === 'lowpass' || type === 'highpass';
  node.Q.value = num(band.q, `${index} q`, resonance ? -40 : 0.001, resonance ? 100 : 1000, defaultQ(type));
  node.gain.value = num(band.gain, `${index} gain`, -40, 40, 0);
  return node;
}

/** Wet/dry wrapper around a processing node, with a linear mix. */
function wetDry(
  context: BaseAudioContext,
  kind: 'delay' | 'reverb',
  wetIn: AudioNode,
  wetOut: AudioNode,
  mix: number,
  nodes: AudioNode[],
  params: Record<string, AudioParam>,
): Effect {
  const input = context.createGain(),
    output = context.createGain(),
    dry = context.createGain(),
    wet = context.createGain();
  dry.gain.value = 1 - mix;
  wet.gain.value = mix;
  input.connect(dry).connect(output);
  input.connect(wetIn);
  wetOut.connect(wet).connect(output);
  params.dry = dry.gain;
  params.wet = wet.gain;
  return make(kind, input, output, [input, output, dry, wet, ...nodes], params, (value, at = context.currentTime) => {
    const m = num(value, 'mix', 0, 1, 0);
    dry.gain.cancelScheduledValues(at);
    wet.gain.cancelScheduledValues(at);
    dry.gain.setTargetAtTime(1 - m, at, 0.01);
    wet.gain.setTargetAtTime(m, at, 0.01);
  });
}

/**
 * Builds the effect a spec describes on `context`. A bad number throws RangeError, a wrong type TypeError.
 * @example
 * const fx = createEffect(context, {type: 'reverb', seconds: 1.5, mix: 0.25});
 */
export function createEffect(context: BaseAudioContext, spec: EffectSpec): Effect {
  if (!context || typeof context.createGain !== 'function')
    throw new TypeError('createEffect needs an AudioContext or OfflineAudioContext as its first argument');
  if (!spec || typeof spec !== 'object') throw new TypeError('Effect spec must be an object such as {type: "reverb"}');
  switch (spec.type) {
    case 'eq': {
      if (!Array.isArray(spec.bands) || spec.bands.length === 0 || spec.bands.length > 16)
        throw new RangeError(
          'eq needs 1 to 16 bands, for example bands: [{frequency: 100, type: "lowshelf", gain: 3}]',
        );
      const nodes = spec.bands.map((band, i) => biquad(context, band, `eq band ${i}`));
      for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]);
      const params: Record<string, AudioParam> = {};
      nodes.forEach((node, i) => {
        params[`frequency${i}`] = node.frequency;
        params[`gain${i}`] = node.gain;
        params[`q${i}`] = node.Q;
      });
      return make('eq', nodes[0], nodes[nodes.length - 1], nodes, params);
    }
    case 'filter': {
      const node = biquad(
        context,
        { type: spec.filter, frequency: spec.frequency, q: spec.q, gain: spec.gain },
        'filter',
      );
      return make('filter', node, node, [node], { frequency: node.frequency, q: node.Q, gain: node.gain });
    }
    case 'compressor': {
      const node = context.createDynamicsCompressor();
      node.threshold.value = num(spec.threshold, 'threshold', -100, 0, -24);
      node.knee.value = num(spec.knee, 'knee', 0, 40, 30);
      node.ratio.value = num(spec.ratio, 'ratio', 1, 20, 4);
      node.attack.value = num(spec.attack, 'attack', 0, 1, 0.003);
      node.release.value = num(spec.release, 'release', 0, 1, 0.25);
      return make('compressor', node, node, [node], {
        threshold: node.threshold,
        knee: node.knee,
        ratio: node.ratio,
        attack: node.attack,
        release: node.release,
      });
    }
    case 'limiter': {
      const node = context.createDynamicsCompressor();
      node.threshold.value = num(spec.ceiling, 'ceiling', -100, 0, -1);
      node.knee.value = 0;
      node.ratio.value = 20;
      node.attack.value = 0;
      node.release.value = num(spec.release, 'release', 0.001, 1, 0.05);
      return make('limiter', node, node, [node], { threshold: node.threshold, release: node.release });
    }
    case 'delay': {
      // Web Audio cannot loop faster than one render quantum (128 frames), and every trip around a feedback loop costs
      // one extra quantum. A fixed one-quantum pre-delay and a loop delay of `time` minus one quantum make echo k land
      // exactly at k * time.
      const quantum = 128 / context.sampleRate;
      const maxTime = num(spec.maxTime, 'maxTime', quantum, 20, Math.max(2, quantum));
      const time = num(spec.time, 'time', quantum, maxTime, 0.3);
      const pre = context.createDelay(quantum + 0.001),
        loop = context.createDelay(maxTime),
        feedback = context.createGain();
      pre.delayTime.value = quantum;
      loop.delayTime.value = time - quantum;
      feedback.gain.value = num(spec.feedback, 'feedback', 0, 0.95, 0.35);
      pre.connect(loop);
      loop.connect(feedback).connect(loop);
      return wetDry(context, 'delay', pre, loop, num(spec.mix, 'mix', 0, 1, 0.3), [pre, loop, feedback], {
        feedback: feedback.gain,
      });
    }
    case 'reverb': {
      let buffer = spec.impulse;
      if (buffer === undefined) {
        const channels = impulseResponse(context.sampleRate, {
          seconds: num(spec.seconds, 'seconds', 0.05, 20, 2),
          decay: spec.decay === undefined ? undefined : num(spec.decay, 'decay', 0.01, 20, 1),
          preDelay: num(spec.preDelay, 'preDelay', 0, 5, 0),
          seed: num(spec.seed, 'seed', 0, 4294967295, 1),
        });
        buffer = context.createBuffer(channels.length, channels[0].length, context.sampleRate);
        channels.forEach((data, i) => buffer!.copyToChannel(data as Float32Array<ArrayBuffer>, i));
      }
      const convolver = context.createConvolver();
      convolver.normalize = false;
      convolver.buffer = buffer;
      return wetDry(context, 'reverb', convolver, convolver, num(spec.mix, 'mix', 0, 1, 0.25), [convolver], {});
    }
    default:
      throw new TypeError(
        `Unknown effect type "${String((spec as { type?: unknown }).type)}"; use eq, filter, compressor, limiter, delay or reverb`,
      );
  }
}

/** Options of {@link loadImpulse}. */
export interface LoadImpulseOptions {
  /** Cancels the download and the decoding; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Custom fetch. Default `globalThis.fetch`. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Downloads and decodes an audio file, for example a recorded room for the reverb's `impulse`. Rejects with the
 * signal's reason when aborted, and with a MargoError ('failed') for an HTTP or decoding failure.
 */
export async function loadImpulse(
  context: BaseAudioContext,
  url: string,
  { signal, fetch: fetcher = globalThis.fetch }: LoadImpulseOptions = {},
): Promise<AudioBuffer> {
  if (typeof fetcher !== 'function') throw new MargoError('unsupported', 'fetch is not available; pass options.fetch');
  signal?.throwIfAborted();
  const response = await fetcher(url, { signal });
  if (!response.ok) throw new MargoError('failed', `Loading ${url} failed with HTTP ${response.status}; check the URL`);
  const bytes = await response.arrayBuffer();
  signal?.throwIfAborted();
  try {
    const decoded = await context.decodeAudioData(bytes);
    signal?.throwIfAborted();
    return decoded;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new MargoError(
      'failed',
      `Decoding ${url} failed; use ogg, mp3, wav or m4a (${(error as Error)?.message ?? error})`,
    );
  }
}
