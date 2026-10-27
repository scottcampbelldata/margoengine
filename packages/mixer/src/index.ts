// @margoengine/mixer: audio buses with mute, solo, sends and ducking; an effects chain (equaliser, filter, compressor,
// limiter, delay, reverb) on Web Audio; positional emitters; and deterministic offline rendering.
export {
  biquadCoefficients,
  biquadMagnitude,
  biquadProcess,
  compressorCurve,
  dbToGain,
  defaultQ,
  gainToDb,
  impulseResponse,
  measure,
  type BiquadCoefficients,
  type BiquadKind,
  type CompressorCurve,
  type ImpulseOptions,
} from './dsp.js';
export {
  createEffect,
  loadImpulse,
  type Effect,
  type EffectSpec,
  type EqBand,
  type LoadImpulseOptions,
} from './effects.js';
export {
  Bus,
  Mixer,
  audibleBuses,
  rampParam,
  type BusOptions,
  type BusState,
  type Duck,
  type DuckOptions,
  type MixerOptions,
  type RampOptions,
  type Routable,
  type Send,
  type SendOptions,
} from './mixer.js';
export { Emitter, setListenerPose, type EmitterOptions, type ListenerPose, type Vec3 } from './spatial.js';
export { bufferChannels, renderOffline, type RenderOptions, type RenderScene } from './offline.js';
