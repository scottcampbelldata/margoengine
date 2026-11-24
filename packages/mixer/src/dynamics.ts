/// <reference lib="esnext.disposable" preserve="true" />
import { bounded, loadProcessor } from './worklet-host.js';
import { dynamicsProcessor } from './dynamics-processor.js';
import type { Bus } from './mixer.js';

/** Common worklet lifetime/layout settings, fixed at construction. */
export interface DynamicsLayout {
  /** Explicit speaker channels, integer 1..32, default 2. */
  channels?: number;
  /** Cancels module registration waiting, default unset. */
  signal?: AbortSignal;
}
/** Exact compressor curve/envelope settings, used independently per band. */
export interface BandDynamics {
  /** Threshold dBFS -120..0, default -24. */
  threshold?: number;
  /** Soft knee dB 0..40, default 6. */
  knee?: number;
  /** Ratio 1..100, default 4. */
  ratio?: number;
  /** Gain time constant seconds 0..10, default 0.003; compressor attenuation or gate/expander opening. */
  attack?: number;
  /** Gain time constant seconds 0..10, default 0.1; compressor recovery or gate/expander closing. */
  release?: number;
  /** Explicit makeup dB -24..24, default 0. */
  makeup?: number;
}
/** Hysteretic noise gate settings. */
export interface GateOptions extends DynamicsLayout {
  /** Opening peak dBFS -120..0, default -40. */
  threshold?: number;
  /** Closing threshold is threshold-hysteresis; 0..40 dB, default 3. */
  hysteresis?: number;
  /** Hold seconds 0..10 after the last above-closing-threshold sample, default 0.05. */
  hold?: number;
  /** Closed gain dB -120..0 or -Infinity for silence, default -Infinity. */
  floor?: number;
  /** Opening time constant seconds 0..10, default 0.001. */
  attack?: number;
  /** Closing time constant seconds 0..10, default 0.1. */
  release?: number;
}
/** Downward expander settings; attack opens, release closes. */
export interface ExpanderOptions extends DynamicsLayout, BandDynamics {
  /** Threshold defaults to -40 dBFS. */
  threshold?: number;
  /** Expansion ratio defaults to 2. */
  ratio?: number;
  /** Maximum attenuation dB 0..120, default 80. */
  range?: number;
}
/** Three phase-aligned fourth-order Linkwitz-Riley bands with independent linked-channel compression. */
export interface MultibandOptions extends DynamicsLayout {
  /** Ordered low/high crossover Hz 10..0.45*sampleRate, defaults [250,2500]. */
  crossovers?: readonly [number, number];
  /** Low/mid/high compressor settings; omitted bands use BandDynamics defaults. */
  low?: BandDynamics;
  /** Mid-band compressor settings. */
  mid?: BandDynamics;
  /** High-band compressor settings. */
  high?: BandDynamics;
}
/** Owned exact-curve audio processor with no lookahead or native automatic makeup. */
export interface ExtendedDynamicsStage extends Disposable {
  /** Program input. */
  readonly input: GainNode;
  /** Processed output. */
  readonly output: AudioWorkletNode;
  /** Zero sample lookahead. Crossovers still have their inherent frequency-dependent phase. */
  readonly latencyFrames: number;
  /** Idempotently stop/disconnect owned processing. */
  dispose(): void;
}
/** JSON choice for optional bus dynamics. */
export type BusDynamicsSpec = ({ type: 'gate' } & GateOptions) | ({ type: 'expander' } & ExpanderOptions)
  | ({ type: 'multiband' } & MultibandOptions);

function band(o: BandDynamics = {}, expansion = false) {
  return {
    threshold: bounded(o.threshold ?? (expansion ? -40 : -24), -120, 0, 'Dynamics threshold'),
    knee: bounded(o.knee ?? 6, 0, 40, 'Dynamics knee'), ratio: bounded(o.ratio ?? (expansion ? 2 : 4), 1, 100, 'Dynamics ratio'),
    attack: bounded(o.attack ?? 0.003, 0, 10, 'Dynamics attack'), release: bounded(o.release ?? 0.1, 0, 10, 'Dynamics release'),
    makeup: bounded(o.makeup ?? 0, -24, 24, 'Dynamics makeup'),
  };
}

/** Exact downward-expansion dB curve, including soft knee and maximum attenuation; default -40/6/2/80. */
export function expanderCurve(inputDb: number, options: ExpanderOptions = {}): number {
  if (inputDb !== -Infinity) bounded(inputDb, -Number.MAX_VALUE, Number.MAX_VALUE, 'Expander input dB');
  const o = band(options, true), range = bounded(options.range ?? 80, 0, 120, 'Expander range');
  if (inputDb === -Infinity) return -Infinity;
  const d = inputDb - o.threshold;
  let reduction = 0;
  if (d < -o.knee / 2) reduction = (o.ratio - 1) * d;
  else if (o.knee > 0 && d < o.knee / 2) reduction = -(o.ratio - 1) * (d - o.knee / 2) ** 2 / (2 * o.knee);
  return inputDb + Math.max(-range, reduction) + o.makeup;
}

function cross(frequency: number, rate: number): number[][] {
  const w = 2 * Math.PI * frequency / rate, cos = Math.cos(w), alpha = Math.sin(w) / Math.SQRT2, a0 = 1 + alpha;
  return [[(1-cos)/2, 1-cos, (1-cos)/2], [(1+cos)/2, -(1+cos), (1+cos)/2]]
    .map(b => [b[0]/a0,b[1]/a0,b[2]/a0,-2*cos/a0,(1-alpha)/a0]);
}

async function create(context: BaseAudioContext, spec: BusDynamicsSpec): Promise<ExtendedDynamicsStage> {
  const channels = bounded(spec.channels ?? 2, 1, 32, 'Dynamics channels');
  if (!Number.isInteger(channels)) throw new RangeError('Dynamics channels needs an integer; use channels 2');
  let settings: object;
  if (spec.type === 'gate') {
    const floor = spec.floor ?? -Infinity;
    if (floor !== -Infinity) bounded(floor, -120, 0, 'Gate floor');
    settings = { threshold: bounded(spec.threshold ?? -40, -120, 0, 'Gate threshold'),
      hysteresis: bounded(spec.hysteresis ?? 3, 0, 40, 'Gate hysteresis'), floor,
      holdFrames: Math.round(bounded(spec.hold ?? 0.05, 0, 10, 'Gate hold') * context.sampleRate),
      attack: bounded(spec.attack ?? 0.001, 0, 10, 'Gate attack'), release: bounded(spec.release ?? 0.1, 0, 10, 'Gate release') };
  } else if (spec.type === 'expander') settings = { ...band(spec, true), range: bounded(spec.range ?? 80, 0, 120, 'Expander range') };
  else if (spec.type === 'multiband') {
    const frequencies = spec.crossovers ?? [250,2500];
    if (!Array.isArray(frequencies) || frequencies.length !== 2)
      throw new TypeError('Multiband needs two crossover frequencies; pass [250,2500]');
    for (const f of frequencies) bounded(f, 10, context.sampleRate * 0.45, 'Crossover Hz');
    if (frequencies[0] >= frequencies[1]) throw new RangeError('Crossovers need increasing frequencies; put low Hz before high Hz');
    settings = { cross: frequencies.map(f => cross(f, context.sampleRate)), bands: [band(spec.low),band(spec.mid),band(spec.high)] };
  } else throw new TypeError('Unknown dynamics type; use gate, expander or multiband');
  await loadProcessor(context, 'margo-extended-dynamics-v1', dynamicsProcessor, spec.signal); spec.signal?.throwIfAborted();
  const output = new AudioWorkletNode(context, 'margo-extended-dynamics-v1', { numberOfInputs: 1, numberOfOutputs: 1,
    outputChannelCount: [channels], channelCount: channels, channelCountMode: 'explicit',
    processorOptions: { ...settings, channels, type: spec.type },
  });
  const input = context.createGain(); input.connect(output); let disposed = false;
  const stage: ExtendedDynamicsStage = { input, output, latencyFrames: 0,
    dispose() { if (disposed) return; disposed = true; input.disconnect(); output.disconnect();
      output.port.postMessage('dispose'); output.port.close(); },
    [Symbol.dispose]() { stage.dispose(); },
  };
  return stage;
}

/** Create a linked peak gate with audio-clock hysteresis and retriggerable hold. */
export function createGate(context: BaseAudioContext, options: GateOptions = {}): Promise<ExtendedDynamicsStage> {
  return create(context, { ...options, type: 'gate' });
}
/** Create linked downward expansion with a fixed soft-knee curve and explicit range/makeup. */
export function createExpander(context: BaseAudioContext, options: ExpanderOptions = {}): Promise<ExtendedDynamicsStage> {
  return create(context, { ...options, type: 'expander' });
}
/** Create LR4 low/mid/high compression with phase compensation on the low branch. Unity gains sum to an allpass. */
export function createMultibandCompressor(context: BaseAudioContext, options: MultibandOptions = {}): Promise<ExtendedDynamicsStage> {
  return create(context, { ...options, type: 'multiband' });
}
/** Insert owned optional dynamics on any bus, preserving other stages and restoring routing on disposal. */
export async function createBusDynamics(bus: Bus, spec: BusDynamicsSpec): Promise<ExtendedDynamicsStage> {
  const stage = await create(bus.input.context, spec); let detach: (() => void) | undefined; const dispose = stage.dispose;
  stage.dispose = () => { detach?.(); dispose(); };
  try { spec.signal?.throwIfAborted(); detach = bus.insert(stage); } catch (error) { dispose(); throw error; }
  return stage;
}
