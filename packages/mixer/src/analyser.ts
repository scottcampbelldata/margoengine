/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import { bounded, loadProcessor } from './worklet-host.js';
import { loudnessFilters } from './loudness-filters.js';
import type { Bus } from './mixer.js';

/** Analysis settings. No AudioContext, polling timer or GPU is created by this entry. */
export interface AnalyserOptions {
  /** Power-of-two FFT size 32..32768, default 2048. */
  fftSize?: number;
  /** Native FFT smoothing 0..1, default 0.8. */
  smoothing?: number;
  /** Speaker channel count 1, 2 or 6, default 2. 5.1 order L R C LFE SL SR. */
  channels?: number;
  /** RMS/peak window and report interval seconds, 0.01..1, default 0.05. */
  interval?: number;
  /** Cancels worklet registration waiting, default unset. */
  signal?: AbortSignal;
}

/** Audio-thread measurements at an exact frame count; silence and incomplete LUFS windows read -Infinity. */
export interface MeterReading {
  /** Total audio frames since creation or reset. */
  readonly frames: number;
  /** Per-channel linear RMS over the last complete interval. */
  readonly rms: readonly number[];
  /** Per-channel absolute sample peak over that interval. */
  readonly peak: readonly number[];
  /** Per-channel RMS in dBFS. */
  readonly db: readonly number[];
  /** BS.1770 K-weighted, channel-weighted trailing 400 ms LUFS. */
  readonly momentary: number;
  /** BS.1770 K-weighted, channel-weighted trailing 3 s LUFS. */
  readonly shortTerm: number;
}

/** Transparent audio stage and per-channel analysis tap. */
export interface BusAnalyser extends Disposable {
  /** Audio input. */
  readonly input: GainNode;
  /** Bit-preserving audio output with no algorithmic delay. */
  readonly output: AudioWorkletNode;
  /** Number of spectrum bins, FFT size / 2. */
  readonly frequencyBinCount: number;
  /** Latest complete audio-thread report, copied for caller ownership. */
  read(): MeterReading;
  /** Current per-channel waveform. Optional target must have fftSize elements; default allocates. */
  waveform(channel?: number, target?: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer>;
  /** Current per-channel FFT in dBFS or linear amplitude. Target must have frequencyBinCount elements. */
  spectrum(channel?: number, target?: Float32Array<ArrayBuffer>, linear?: boolean): Float32Array<ArrayBuffer>;
  /** Frequency of a spectrum bin in Hz. */
  frequency(bin: number): number;
  /** Clear filter history and meter windows on the audio thread. */
  reset(): void;
  /** End processing and disconnect owned nodes; idempotent. */
  dispose(): void;
}

const processor = `class MeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.o = options.processorOptions; this.active = true; this.generation = 0; this.reset();
    this.port.onmessage = e => { if (e.data === 'reset') { this.generation++; this.reset(); } else this.active = false; };
  }
  reset() {
    const o = this.o;
    this.frames = 0; this.at = 0; this.partial = 0;
    this.energy = new Float64Array(Math.round(3 * sampleRate));
    this.m = 0; this.s = 0; this.mLive = 0; this.sLive = 0;
    this.states = Array.from({length:o.channels}, () => [new Float64Array(4), new Float64Array(4)]);
    this.squares = new Float64Array(o.channels); this.peaks = new Float64Array(o.channels);
  }
  process(inputs, outputs) {
    if (!this.active) return false;
    const data = inputs[0], out = outputs[0], o = this.o, n400 = Math.round(.4 * sampleRate);
    for (let i = 0; i < out[0].length; i++) {
      let energy = 0;
      for (let ch = 0; ch < out.length; ch++) {
        const sample = data[ch]?.[i] ?? 0; out[ch][i] = sample;
        this.squares[ch] += sample * sample; this.peaks[ch] = Math.max(this.peaks[ch], Math.abs(sample));
        let v = sample;
        for (let k = 0; k < 2; k++) {
          const c = o.filters[k], s = this.states[ch][k];
          const y = c[0]*v + c[1]*s[0] + c[2]*s[1] - c[3]*s[2] - c[4]*s[3];
          s[1]=s[0]; s[0]=v; s[3]=s[2]; s[2]=y; v=y;
        }
        const weight = o.channels === 6 ? [1,1,1,0,1.41,1.41][ch] : 1;
        energy += v*v*weight;
      }
      const old400 = (this.at - n400 + this.energy.length) % this.energy.length;
      // Running window sums, plus exact counts of nonzero samples in each window: once a loud passage has left a
      // window its sum is exactly 0 again instead of the rounding left by adding and removing it.
      const leaving = this.energy[old400], expiring = this.energy[this.at];
      this.m += energy - leaving; this.s += energy - expiring;
      this.mLive += (energy !== 0) - (leaving !== 0); this.sLive += (energy !== 0) - (expiring !== 0);
      if (this.mLive === 0) this.m = 0;
      if (this.sLive === 0) this.s = 0;
      this.energy[this.at] = energy; this.at = (this.at+1) % this.energy.length;
      if (this.at === 0) {
        // Once per 3 s ring, resum both windows so rounding cannot build up over a long session.
        let m = 0, s = 0;
        for (let k = 0; k < this.energy.length; k++) { s += this.energy[k]; if (k >= this.energy.length - n400) m += this.energy[k]; }
        this.m = m; this.s = s;
      }
      this.frames++; this.partial++;
      if (this.partial === o.intervalFrames) {
        const rms = Array.from(this.squares, v => Math.sqrt(v / this.partial));
        const level = p => p > 0 ? -.691 + 10*Math.log10(p) : -Infinity;
        this.port.postMessage({generation:this.generation, frames:this.frames, rms, peak:Array.from(this.peaks), db:rms.map(v=>v>0?20*Math.log10(v):-Infinity),
          momentary:this.frames>=n400?level(Math.max(0,this.m)/n400):-Infinity,
          shortTerm:this.frames>=this.energy.length?level(Math.max(0,this.s)/this.energy.length):-Infinity});
        this.squares.fill(0); this.peaks.fill(0); this.partial=0;
      }
    }
    return true;
  }
}
registerProcessor('margo-meter-v1', MeterProcessor);`;

/** Create transparent FFT/waveform and audio-clock RMS/peak/LUFS analysis, independently of the renderer. */
export async function createAnalyser(context: BaseAudioContext, options: AnalyserOptions = {}): Promise<BusAnalyser> {
  const fftSize = bounded(options.fftSize ?? 2048, 32, 32768, 'Analyser fftSize');
  if (!Number.isInteger(Math.log2(fftSize))) throw new RangeError('FFT size needs a power of two; use 2048');
  const channels = options.channels ?? 2;
  if (![1,2,6].includes(channels)) throw new RangeError('Analyser channels needs 1, 2 or 6; choose a speaker layout');
  if (![32000,44100,48000,88200,96000,176400,192000].includes(context.sampleRate))
    throw new RangeError('LUFS sample rate is unsupported; use a standard 32000..192000 Hz context');
  const smoothing = bounded(options.smoothing ?? 0.8, 0, 1, 'FFT smoothing');
  const intervalFrames = Math.round(bounded(options.interval ?? 0.05, 0.01, 1, 'Meter interval') * context.sampleRate);
  await loadProcessor(context, 'margo-meter-v1', processor, options.signal);
  options.signal?.throwIfAborted();
  const output = new AudioWorkletNode(context, 'margo-meter-v1', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [channels], channelCount: channels,
    channelCountMode: 'explicit', processorOptions: { channels, intervalFrames, filters: loudnessFilters(context.sampleRate) },
  });
  const input = context.createGain(), splitter = context.createChannelSplitter(channels), sink = context.createGain();
  sink.gain.value = 0; sink.connect(context.destination);
  input.connect(output); output.connect(splitter);
  const analysers = Array.from({ length: channels }, (_, c) => {
    const node = context.createAnalyser(); node.fftSize = fftSize; node.smoothingTimeConstant = smoothing;
    splitter.connect(node, c); node.connect(sink); return node;
  });
  let disposed = false;
  const empty = (): MeterReading => ({ frames: 0, rms: Array(channels).fill(0), peak: Array(channels).fill(0),
    db: Array(channels).fill(-Infinity), momentary: -Infinity, shortTerm: -Infinity });
  let reading = empty(), generation = 0;
  // Reports carry the count of resets the audio thread had seen; one posted before it received the latest reset()
  // is stale and must not restore the old readings.
  output.port.onmessage = event => {
    if (disposed || event.data.generation !== generation) return;
    const { generation: _, ...report } = event.data as MeterReading & { generation: number };
    reading = report;
  };
  const alive = () => { if (disposed) throw new MargoError('disposed', 'Analyser is disposed; create a new analyser'); };
  const data = (channel: number, target: Float32Array<ArrayBuffer> | undefined, size: number) => {
    alive(); bounded(channel, 0, channels - 1, 'Analyser channel');
    if (!Number.isInteger(channel)) throw new RangeError('Analyser channel needs an integer; use 0 for left');
    if (target !== undefined && (!(target instanceof Float32Array) || !(target.buffer instanceof ArrayBuffer) || target.length !== size))
      throw new TypeError(`Analyser target needs ${size} Float32Array elements; allocate a matching buffer`);
    return target ?? new Float32Array(size);
  };
  const stage: BusAnalyser = {
    input, output, frequencyBinCount: fftSize / 2,
    read() { alive(); return { ...reading, rms: [...reading.rms], peak: [...reading.peak], db: [...reading.db] }; },
    waveform(channel = 0, target) { const a = data(channel, target, fftSize); analysers[channel].getFloatTimeDomainData(a); return a; },
    spectrum(channel = 0, target, linear = false) {
      const a = data(channel, target, fftSize / 2); analysers[channel].getFloatFrequencyData(a);
      if (linear) for (let i = 0; i < a.length; i++) a[i] = 10 ** (a[i] / 20);
      return a;
    },
    frequency(bin) { alive(); bounded(bin, 0, fftSize / 2 - 1, 'FFT bin');
      if (!Number.isInteger(bin)) throw new RangeError('FFT bin needs an integer; use a spectrum index');
      return bin * context.sampleRate / fftSize;
    },
    reset() { alive(); generation++; reading = empty(); output.port.postMessage('reset'); },
    dispose() {
      if (disposed) return; disposed = true;
      for (const n of [input, output, splitter, sink, ...analysers]) n.disconnect();
      output.port.onmessage = null; output.port.postMessage('dispose'); output.port.close();
    },
    [Symbol.dispose]() { stage.dispose(); },
  };
  return stage;
}

/** Insert transparent per-bus analysis, including master. Bus teardown owns disposal; manual disposal restores routing. */
export async function createBusAnalyser(bus: Bus, options: AnalyserOptions = {}): Promise<BusAnalyser> {
  const stage = await createAnalyser(bus.input.context, options);
  let detach: (() => void) | undefined;
  const dispose = stage.dispose;
  stage.dispose = () => { detach?.(); dispose(); };
  try { detach = bus.insert(stage); }
  catch (error) { dispose(); throw error; }
  return stage;
}
