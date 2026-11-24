/// <reference lib="esnext.disposable" preserve="true" />
import { bounded, loadProcessor } from './worklet-host.js';
import { fxProcessor } from './fx-processor.js';
import type { Bus } from './mixer.js';

/** JSON modulation effect specification. All time values are seconds; numeric controls become audio-rate params. */
export interface ModulationSpec {
  /** Effect algorithm. */
  type: 'chorus' | 'flanger' | 'phaser' | 'tremolo' | 'vibrato' | 'auto-filter' | 'auto-pan';
  /** LFO rate Hz, 0..20, default 1. */
  rate?: number;
  /** Modulation depth 0..1, default 0.5. */
  depth?: number;
  /** Wet proportion 0..1; default 1 for vibrato/auto-filter/auto-pan/tremolo, 0.5 otherwise. */
  mix?: number;
  /** Delay centre seconds 0..0.1; default chorus 0.02, flanger 0.003, vibrato 0.005. Minimum read delay is one sample. */
  time?: number;
  /** Delay feedback -0.95..0.95, default 0. */
  feedback?: number;
  /** Filter base Hz 10..0.45*sampleRate, default 400. Sweep clamps at 0.45*sampleRate. */
  frequency?: number;
  /** Filter sweep octaves 0..8, default 3. */
  octaves?: number;
  /** Phaser/lowpass quality factor 0.1..40, default 1. */
  q?: number;
  /** Phaser allpass stages integer 1..32, default 6. */
  stages?: number;
  /** LFO waveform, default sine. */
  waveform?: 'sine' | 'triangle' | 'square' | 'sawtooth';
  /** Initial LFO phase degrees 0..360, default 0. */
  phase?: number;
  /** Odd-channel LFO phase offset degrees 0..360; default 180 for chorus/tremolo, otherwise 0. Auto-pan is linked. */
  spread?: number;
}

/** JSON bit-depth and sample-rate reduction spec. */
export interface BitcrusherSpec {
  /** Sample/hold and quantisation algorithm. */
  type: 'bitcrusher';
  /** Integer bit depth 1..24, default 4; step 2^(1-bits), rounded to nearest. */
  bits?: number;
  /** Integer sample/hold period frames 1..128, default 1. */
  reduction?: number;
  /** Wet proportion 0..1, default 1. */
  mix?: number;
}

/** Native oversampled waveshaping, described by JSON values. */
export interface ColourSpec {
  /** Distortion uses a rational soft clip; waveshaper uses the authored curve. */
  type: 'distortion' | 'waveshaper';
  /** Distortion amount 0..1, default 0.4. */
  amount?: number;
  /** Waveshaper curve: 2..65537 finite float32 values, required for waveshaper. */
  curve?: readonly number[];
  /** Native oversampling none/2x/4x, default none. */
  oversample?: OverSampleType;
  /** Wet proportion 0..1, default 1. */
  mix?: number;
}

/** Optional JSON effect variants, intentionally absent from the root EffectSpec to keep registration/imports local. */
export type FXSpec = ModulationSpec | BitcrusherSpec | ColourSpec;

/** Worklet construction settings. */
export interface FXOptions {
  /** Speaker channels, integer 1..32, default 2. Auto-pan requires stereo. */
  channels?: number;
  /** Cancels registration and chain construction; default unset. */
  signal?: AbortSignal;
}

/** An owned optional effect or chain with native AudioParams. */
export interface FXStage extends Disposable {
  /** Audio input. */
  readonly input: AudioNode;
  /** Audio output. */
  readonly output: AudioNode;
  /** Named audio-clock controls. Chains prefix names with effect index, e.g. 0.mix. */
  readonly params: Readonly<Record<string, AudioParam>>;
  /** Disconnect and stop owned processing; idempotent. */
  dispose(): void;
}

function colour(context: BaseAudioContext, spec: ColourSpec): FXStage {
  const mix = bounded(spec.mix ?? 1, 0, 1, 'FX mix'), amount = bounded(spec.amount ?? 0.4, 0, 1, 'Distortion amount');
  const oversample = spec.oversample ?? 'none';
  if (!['none','2x','4x'].includes(oversample)) throw new TypeError('Unknown oversampling; choose none, 2x or 4x');
  let curve: Float32Array<ArrayBuffer>;
  if (spec.type === 'waveshaper') {
    if (!Array.isArray(spec.curve) || spec.curve.length < 2 || spec.curve.length > 65537)
      throw new TypeError('Waveshaper needs a curve of 2..65537 samples; pass a JSON number array');
    for (const v of spec.curve) bounded(v, -3.4028234663852886e38, 3.4028234663852886e38, 'Curve sample');
    curve = Float32Array.from(spec.curve);
  } else {
    const k = amount * 100;
    curve = Float32Array.from({ length: 8193 }, (_, i) => {
      const x = i / 4096 - 1; return (1 + k) * x / (1 + k * Math.abs(x));
    });
  }
  const input = context.createGain(), output = context.createGain(), dry = context.createGain(), wet = context.createGain();
  const shape = context.createWaveShaper(), control = context.createConstantSource(), invert = context.createGain();
  shape.curve = curve; shape.oversample = oversample; control.offset.value = mix;
  dry.gain.value = 1; wet.gain.value = 0; invert.gain.value = -1;
  control.connect(wet.gain); control.connect(invert).connect(dry.gain); control.start();
  input.connect(dry).connect(output); input.connect(shape).connect(wet).connect(output);
  let disposed = false;
  const stage: FXStage = { input, output, params: { mix: control.offset },
    dispose() { if (disposed) return; disposed = true; control.stop();
      for (const n of [input, output, dry, wet, shape, control, invert]) n.disconnect(); },
    [Symbol.dispose]() { stage.dispose(); },
  };
  return stage;
}

/** Build one JSON effect, using native oversampling for colour and a sample-clock processor for modulation/reduction. */
export async function createFX(context: BaseAudioContext, spec: FXSpec, options: FXOptions = {}): Promise<FXStage> {
  options.signal?.throwIfAborted();
  if (!spec || typeof spec !== 'object') throw new TypeError('FX needs a JSON effect object; pass a spec with type');
  if (spec.type === 'distortion' || spec.type === 'waveshaper') return colour(context, spec);
  if (!['chorus','flanger','vibrato','phaser','tremolo','auto-filter','auto-pan','bitcrusher'].includes(spec.type))
    throw new TypeError('Unknown FX type; choose a documented modulation or colour effect');
  const channels = bounded(options.channels ?? 2, 1, 32, 'FX channels');
  if (!Number.isInteger(channels) || (spec.type === 'auto-pan' && channels !== 2))
    throw new RangeError('FX needs integer channels and auto-pan needs stereo; pass channels 2');
  const mod = spec as ModulationSpec, bits = spec as BitcrusherSpec;
  const waveform = mod.waveform ?? 'sine';
  if (!['sine','triangle','square','sawtooth'].includes(waveform))
    throw new TypeError('Unknown LFO waveform; use sine, triangle, square or sawtooth');
  const stages = bounded(mod.stages ?? 6, 1, 32, 'Phaser stages');
  const parameterData = {
    rate: bounded(mod.rate ?? 1, 0, 20, 'LFO rate'), depth: bounded(mod.depth ?? 0.5, 0, 1, 'FX depth'),
    mix: bounded(spec.mix ?? (['chorus','flanger','phaser'].includes(spec.type) ? 0.5 : 1), 0, 1, 'FX mix'),
    time: bounded(mod.time ?? (spec.type === 'flanger' ? 0.003 : spec.type === 'vibrato' ? 0.005 : 0.02), 0, 0.1, 'FX time'),
    feedback: bounded(mod.feedback ?? 0, -0.95, 0.95, 'FX feedback'),
    frequency: bounded(mod.frequency ?? 400, 10, context.sampleRate * 0.45, 'FX frequency'),
    octaves: bounded(mod.octaves ?? 3, 0, 8, 'FX octaves'), q: bounded(mod.q ?? 1, 0.1, 40, 'FX q'),
    bits: bounded(bits.bits ?? 4, 1, 24, 'FX bits'), reduction: bounded(bits.reduction ?? 1, 1, 128, 'FX reduction'),
  };
  if (![stages, parameterData.bits, parameterData.reduction].every(Number.isInteger))
    throw new RangeError('FX stages, bits and reduction need integers; pass whole numbers within their bounds');
  const phase = bounded(mod.phase ?? 0, 0, 360, 'FX phase');
  const spread = bounded(mod.spread ?? (['chorus','tremolo'].includes(spec.type) ? 180 : 0), 0, 360, 'FX spread');
  await loadProcessor(context, 'margo-fx-v1', fxProcessor, options.signal); options.signal?.throwIfAborted();
  const output = new AudioWorkletNode(context, 'margo-fx-v1', { numberOfInputs: 1, numberOfOutputs: 1,
    outputChannelCount: [channels], channelCount: channels, channelCountMode: 'explicit', parameterData,
    processorOptions: { type: spec.type, channels, stages, phase, spread: spec.type === 'auto-pan' ? 0 : spread, waveform },
  });
  const input = context.createGain(); input.connect(output);
  const params = Object.fromEntries(Object.keys(parameterData).map(k => [k, output.parameters.get(k)!]));
  let disposed = false;
  const stage: FXStage = { input, output, params,
    dispose() { if (disposed) return; disposed = true; input.disconnect(); output.disconnect();
      output.port.postMessage('dispose'); output.port.close(); },
    [Symbol.dispose]() { stage.dispose(); },
  };
  return stage;
}

/** Build a JSON chain transactionally. Failure/abort disposes earlier effects, leaving caller routing untouched. */
export async function createFXChain(context: BaseAudioContext, specs: readonly FXSpec[], options: FXOptions = {}): Promise<FXStage> {
  options.signal?.throwIfAborted();
  if (!Array.isArray(specs)) throw new TypeError('FX chain needs an array; pass JSON effect specs in processing order');
  const stages: FXStage[] = [];
  try { for (const spec of specs) { stages.push(await createFX(context, spec, options)); options.signal?.throwIfAborted(); } }
  catch (error) { for (const s of stages) s.dispose(); throw error; }
  const input = context.createGain(), output = context.createGain();
  let tail: AudioNode = input;
  const params: Record<string, AudioParam> = {};
  stages.forEach((s, i) => { tail.connect(s.input); tail = s.output;
    for (const [name, p] of Object.entries(s.params)) params[`${i}.${name}`] = p; });
  tail.connect(output); let disposed = false;
  const chain: FXStage = { input, output, params,
    dispose() { if (disposed) return; disposed = true; input.disconnect(); output.disconnect(); for (const s of stages) s.dispose(); },
    [Symbol.dispose]() { chain.dispose(); },
  };
  return chain;
}

/** Build and insert a caller-owned JSON chain on any bus. Its disposal restores the bus; bus teardown also disposes it. */
export async function createBusFX(bus: Bus, specs: readonly FXSpec[], options: FXOptions = {}): Promise<FXStage> {
  const stage = await createFXChain(bus.input.context, specs, options);
  let detach: (() => void) | undefined; const dispose = stage.dispose;
  stage.dispose = () => { detach?.(); dispose(); };
  try { options.signal?.throwIfAborted(); detach = bus.insert(stage); } catch (error) { dispose(); throw error; }
  return stage;
}
