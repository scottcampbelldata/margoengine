/// <reference lib="esnext.disposable" preserve="true" />
import type { Audio } from './audio.js';

export interface AudioAnalyserOptions {
  /** FFT size, a power of two from 32 to 32768. Default 2048. */
  fftSize?: number;
  /** Averaging between successive frames, 0..1. Default 0.8 (the Web Audio default). */
  smoothingTimeConstant?: number;
  minDecibels?: number;
  maxDecibels?: number;
}

/**
 * Taps the output of a sound (after its volume stage and panner) with an AnalyserNode (THREE.AudioAnalyser
 * counterpart). The tap is a side branch and does not change what reaches the speakers.
 */
export class AudioAnalyser {
  readonly analyser: AnalyserNode;
  /** Byte frequency bins from the last getFrequencyData call. */
  readonly data: Uint8Array<ArrayBuffer>;
  private readonly input: AudioNode;
  private readonly waveform: Uint8Array<ArrayBuffer>;
  private readonly spectrum: Float32Array<ArrayBuffer>;
  private disposed = false;

  constructor(source: Audio | AudioNode, options: AudioAnalyserOptions | number = {}) {
    const settings = typeof options === 'number' ? { fftSize: options } : options;
    this.input = 'getOutput' in source ? source.getOutput() : source;
    const analyser = this.input.context.createAnalyser();
    analyser.fftSize = settings.fftSize ?? 2048;
    if (settings.smoothingTimeConstant !== undefined) analyser.smoothingTimeConstant = settings.smoothingTimeConstant;
    if (settings.minDecibels !== undefined) analyser.minDecibels = settings.minDecibels;
    if (settings.maxDecibels !== undefined) analyser.maxDecibels = settings.maxDecibels;
    this.analyser = analyser;
    this.data = new Uint8Array(analyser.frequencyBinCount);
    this.waveform = new Uint8Array(analyser.fftSize);
    this.spectrum = new Float32Array(analyser.frequencyBinCount);
    this.input.connect(analyser);
  }

  /** Byte magnitudes per frequency bin (0..255), written into `data`. */
  getFrequencyData(): Uint8Array<ArrayBuffer> {
    this.analyser.getByteFrequencyData(this.data);
    return this.data;
  }
  /** Decibel magnitudes per frequency bin. */
  getFloatFrequencyData(out = new Float32Array(this.analyser.frequencyBinCount)): Float32Array<ArrayBuffer> {
    this.analyser.getFloatFrequencyData(out);
    return out;
  }
  /** Byte waveform samples (128 is silence). */
  getWaveformData(): Uint8Array<ArrayBuffer> {
    this.analyser.getByteTimeDomainData(this.waveform);
    return this.waveform;
  }
  /** Float waveform samples in -1..1. */
  getFloatWaveformData(out = new Float32Array(this.analyser.fftSize)): Float32Array<ArrayBuffer> {
    this.analyser.getFloatTimeDomainData(out);
    return out;
  }
  /** Mean of the byte frequency bins, 0..255. */
  getAverageFrequency(): number {
    const data = this.getFrequencyData();
    let total = 0;
    for (let i = 0; i < data.length; i++) total += data[i];
    return data.length ? total / data.length : 0;
  }
  /** Peak frequency in Hz, from the decibel spectrum (byte data saturates at maxDecibels). */
  getDominantFrequency(): number {
    const data = this.getFloatFrequencyData(this.spectrum);
    let best = 0;
    for (let i = 1; i < data.length; i++) if (data[i] > data[best]) best = i;
    return (best * this.analyser.context.sampleRate) / this.analyser.fftSize;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.input.disconnect(this.analyser);
    } catch {
      /* already gone */
    }
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
