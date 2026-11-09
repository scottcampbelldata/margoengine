/// <reference lib="esnext.disposable" preserve="true" />
import { bounded, loadProcessor } from './worklet-host.js';
import { peakPhases } from './true-peak.js';
export { measureTruePeak } from './true-peak.js';

/** Fixed, browser-independent dynamics settings. Input PCM must be finite. */
export interface DynamicsOptions {
  /** Default limiter. Compressor applies the soft-knee curve before the true-peak safety stage. */
  mode?: 'limiter' | 'compressor';
  /** True-peak ceiling in dBTP, default -1, range -96..0. */
  ceiling?: number;
  /** Compressor threshold dBFS, default -24, range -96..0. Ignored in limiter mode. */
  threshold?: number;
  /** Compressor knee width in dB, default 6, range 0..40. Ignored in limiter mode. */
  knee?: number;
  /** Compressor ratio, default 4, range 1..100. Ignored in limiter mode. */
  ratio?: number;
  /** Compressor gain attack time constant, default 0.003 s, range 0..10. Zero jumps. */
  attack?: number;
  /** Compressor and limiter gain release time constant, default 0.05 s, range 0..10. Zero jumps. */
  release?: number;
  /** Explicit make-up gain, default 0 dB, range -24..24. No automatic make-up. */
  makeup?: number;
  /** Explicit speaker channel count, default 2, integer 1..32. */
  channels?: number;
  /** Cancels waiting for shared module registration. Default unset. */
  signal?: AbortSignal;
}

/** A linked-channel dynamics stage with 11 samples of lookahead and a finite-FIR true-peak ceiling. */
export interface DynamicsStage extends Disposable {
  /** Program input. */
  readonly input: GainNode;
  /** Delayed, processed output. */
  readonly output: AudioWorkletNode;
  /** Fixed algorithmic latency, 11 samples. */
  readonly latencyFrames: number;
  /** Algorithmic latency in seconds (does not include device or graph buffering). */
  readonly latency: number;
  /** Disconnects owned nodes and ends processing; idempotent. Context and sources remain caller-owned. */
  dispose(): void;
}

const processor = `const phases = ${JSON.stringify(peakPhases)};
class DynamicsProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = this.options = options.processorOptions;
    this.history = Array.from({length: o.channels}, () => new Float64Array(12));
    this.caps = new Float64Array(12).fill(1);
    this.at = 11;
    this.gain = 1;
    this.guard = 1;
    this.ceiling = 10 ** (o.ceiling / 20) * (1 - 2 ** -22);
    this.makeup = 10 ** (o.makeup / 20);
    this.attack = o.attack === 0 ? 0 : Math.exp(-1 / (sampleRate * o.attack));
    this.release = o.release === 0 ? 0 : Math.exp(-1 / (sampleRate * o.release));
    this.active = true;
    this.port.onmessage = () => { this.active = false; };
  }
  process(inputs, outputs) {
    if (!this.active) return false;
    const input = inputs[0], out = outputs[0], o = this.options;
    for (let i = 0; i < out[0].length; i++) {
      let peak = 0;
      for (let c = 0; c < input.length; c++) peak = Math.max(peak, Math.abs(input[c][i]));
      let target = 1;
      if (o.mode === 'compressor' && peak > 0) {
        const x = 20 * Math.log10(peak), d = x - o.threshold;
        let reduction = 0;
        if (d > o.knee / 2) reduction = d * (1 / o.ratio - 1);
        else if (o.knee > 0 && d > -o.knee / 2)
          reduction = (1 / o.ratio - 1) * (d + o.knee / 2) ** 2 / (2 * o.knee);
        target = 10 ** (reduction / 20);
      }
      const coefficient = target < this.gain ? this.attack : this.release;
      this.gain = target + coefficient * (this.gain - target);
      this.at = (this.at + 1) % 12;
      let bound = 0;
      for (let c = 0; c < out.length; c++) {
        const value = (input[c]?.[i] ?? 0) * this.gain * this.makeup;
        this.history[c][this.at] = value;
        bound = Math.max(bound, Math.abs(value));
        for (const phase of phases) {
          let sum = 0;
          for (let k = 0; k < 12; k++) sum += Math.abs(phase[k] * this.history[c][(this.at - k + 12) % 12]);
          bound = Math.max(bound, sum);
        }
      }
      this.caps[this.at] = bound > this.ceiling ? this.ceiling / bound : 1;
      let safe = 1;
      for (let k = 0; k < 12; k++) safe = Math.min(safe, this.caps[k]);
      this.guard = Math.min(safe, 1 + this.release * (this.guard - 1));
      const oldest = (this.at + 1) % 12;
      for (let c = 0; c < out.length; c++) out[c][i] = this.history[c][oldest] * this.guard;
    }
    return true;
  }
}
registerProcessor('margo-dynamics-v1', DynamicsProcessor);`;

/** Build exact package-owned compression and conservative ITU four-phase true-peak limiting, on either renderer. */
export async function createDynamics(context: BaseAudioContext, options: DynamicsOptions = {}): Promise<DynamicsStage> {
  const mode = options.mode ?? 'limiter';
  if (mode !== 'limiter' && mode !== 'compressor')
    throw new TypeError('Dynamics mode is unknown; use limiter or compressor');
  const channels = bounded(options.channels ?? 2, 1, 32, 'Dynamics channels');
  if (!Number.isInteger(channels)) throw new RangeError('Dynamics channels needs an integer; pass 1 through 32');
  const settings = {
    mode, channels,
    ceiling: bounded(options.ceiling ?? -1, -96, 0, 'Dynamics ceiling'),
    threshold: bounded(options.threshold ?? -24, -96, 0, 'Dynamics threshold'),
    knee: bounded(options.knee ?? 6, 0, 40, 'Dynamics knee'),
    ratio: bounded(options.ratio ?? 4, 1, 100, 'Dynamics ratio'),
    attack: bounded(options.attack ?? 0.003, 0, 10, 'Dynamics attack'),
    release: bounded(options.release ?? 0.05, 0, 10, 'Dynamics release'),
    makeup: bounded(options.makeup ?? 0, -24, 24, 'Dynamics makeup'),
  };
  await loadProcessor(context, 'margo-dynamics-v1', processor, options.signal);
  options.signal?.throwIfAborted();
  const output = new AudioWorkletNode(context, 'margo-dynamics-v1', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [channels],
    channelCount: channels, channelCountMode: 'explicit', processorOptions: settings,
  });
  const input = context.createGain();
  input.connect(output);
  let disposed = false;
  const stage: DynamicsStage = {
    input, output, latencyFrames: 11, latency: 11 / context.sampleRate,
    dispose() {
      if (disposed) return;
      disposed = true;
      input.disconnect(); output.disconnect();
      output.port.postMessage('dispose'); output.port.close();
    },
    [Symbol.dispose]() { stage.dispose(); },
  };
  return stage;
}
