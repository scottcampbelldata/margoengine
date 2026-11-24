/// <reference lib="esnext.disposable" preserve="true" />
import { bounded, loadProcessor } from './worklet-host.js';

/** Automatic ducking settings, fixed for the lifetime of the stage. Times are seconds. */
export interface SidechainOptions {
  /** Attenuation in dB when the key exceeds threshold. Default 12, range 0..96. */
  amount?: number;
  /** Key peak threshold in dBFS. Default -40, range -120..0. */
  threshold?: number;
  /** Gain attack time constant. Default 0.01 s, range 0..10. Zero jumps. */
  attack?: number;
  /** Gain release time constant. Default 0.2 s, range 0..10. Zero jumps. */
  release?: number;
  /** Hold after the last above-threshold sample. Default 0.05 s, range 0..10. */
  hold?: number;
  /** Output channels, default 2, integer 1..32. Web Audio up/downmixes the program to this count. */
  channels?: number;
  /** Cancels module loading; the context's shared registration may still complete. */
  signal?: AbortSignal;
}

/** An audio-clock sidechain stage. Connect music to input and the dialogue key to sidechain. */
export interface Sidechain extends Disposable {
  /** Program input, the only signal passed to the output. */
  readonly input: GainNode;
  /** Detector input. Connect dialogue here as well as to its audible bus. */
  readonly sidechain: GainNode;
  /** Ducked program output. */
  readonly output: AudioWorkletNode;
  /** Disconnects owned nodes and ends processing. Idempotent; leaves caller sources connected elsewhere. */
  dispose(): void;
}

// Written from Web Audio's two-input processor contract and a one-pole gain envelope.
const processor = `class SidechainProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.floor = 10 ** (-o.amount / 20);
    this.threshold = 10 ** (o.threshold / 20);
    this.attack = o.attack === 0 ? 0 : Math.exp(-1 / (sampleRate * o.attack));
    this.release = o.release === 0 ? 0 : Math.exp(-1 / (sampleRate * o.release));
    this.holdFrames = Math.round(o.hold * sampleRate);
    this.remaining = 0;
    this.gain = 1;
    this.active = true;
    this.port.onmessage = () => { this.active = false; };
  }
  process(inputs, outputs) {
    if (!this.active) return false;
    const program = inputs[0], key = inputs[1], out = outputs[0];
    for (let i = 0; i < out[0].length; i++) {
      let peak = 0;
      for (let c = 0; c < key.length; c++) peak = Math.max(peak, Math.abs(key[c][i]));
      const detected = peak > this.threshold;
      if (detected) this.remaining = this.holdFrames;
      const target = detected || this.remaining > 0 ? this.floor : 1;
      if (!detected && this.remaining > 0) this.remaining--;
      const coefficient = target < this.gain ? this.attack : this.release;
      this.gain = target + coefficient * (this.gain - target);
      for (let c = 0; c < out.length; c++) out[c][i] = (program[c]?.[i] ?? 0) * this.gain;
    }
    return true;
  }
}
registerProcessor('margo-sidechain-v1', SidechainProcessor);`;

/** Create automatic audio-thread ducking. Works independently of WebGPU or WebGL2; requires AudioWorklet. */
export async function createSidechain(context: BaseAudioContext, options: SidechainOptions = {}): Promise<Sidechain> {
  const settings = {
    amount: bounded(options.amount ?? 12, 0, 96, 'Sidechain amount'),
    threshold: bounded(options.threshold ?? -40, -120, 0, 'Sidechain threshold'),
    attack: bounded(options.attack ?? 0.01, 0, 10, 'Sidechain attack'),
    release: bounded(options.release ?? 0.2, 0, 10, 'Sidechain release'),
    hold: bounded(options.hold ?? 0.05, 0, 10, 'Sidechain hold'),
  };
  const channels = bounded(options.channels ?? 2, 1, 32, 'Sidechain channels');
  if (!Number.isInteger(channels)) throw new RangeError('Sidechain channels needs an integer; pass 1 through 32');
  await loadProcessor(context, 'margo-sidechain-v1', processor, options.signal);
  options.signal?.throwIfAborted();
  const output = new AudioWorkletNode(context, 'margo-sidechain-v1', {
    numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [channels],
    channelCount: channels, channelCountMode: 'explicit', processorOptions: settings,
  });
  const input = context.createGain(), sidechain = context.createGain();
  input.connect(output, 0, 0);
  sidechain.connect(output, 0, 1);
  let disposed = false;
  const stage: Sidechain = {
    input, sidechain, output,
    dispose() {
      if (disposed) return;
      disposed = true;
      input.disconnect();
      sidechain.disconnect();
      output.disconnect();
      output.port.postMessage('dispose');
      output.port.close();
    },
    [Symbol.dispose]() { stage.dispose(); },
  };
  return stage;
}
