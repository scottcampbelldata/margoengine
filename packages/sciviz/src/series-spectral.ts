import type { ComputeContext } from '@margoengine/compute';
import type { Figure, LineLayer, HeatmapLayerOptions } from './figure.js';
import type { RectsLayer } from './rects.js';
import { rangeError } from '../../shared/errors.js';
/** Windowed, one-sided spectrum in physical units. Power is PSD (value squared per Hz). */
export interface SeriesSpectrum {
  readonly frequency: Float64Array;
  readonly real: Float64Array;
  readonly imaginary: Float64Array;
  readonly power: Float64Array;
}
/** Spectral preprocessing, applied to original observations, never display samples. */
export interface SeriesSpectrumOptions {
  /** Default hann (periodic); rectangular is also supported. */ readonly window?: 'hann' | 'rectangular';
  /** Remove each window's mean, default true. */ readonly detrend?: boolean;
  readonly signal?: AbortSignal;
}
function validate(values: ArrayLike<number>, sampleRate: number, options: SeriesSpectrumOptions): void {
  options.signal?.throwIfAborted();
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isSafeInteger(values.length) || values.length < 2 || values.length > 16777216 || !['hann', 'rectangular'].includes(options.window ?? 'hann')) throw rangeError('Use 2..16777216 finite samples, a positive sample rate and hann or rectangular window', 'sciviz');
  for (let i = 0; i < values.length; i++) { if (!(i & 16383)) options.signal?.throwIfAborted(); if (!Number.isFinite(values[i])) throw rangeError('Remove gaps before computing a spectrum', 'sciviz'); }
}
/** GPU FFT through compute/fft. Normalize before f32 upload and restore binary64 units after readback, retaining tiny physical signals. */
export async function seriesSpectrum(gpu: ComputeContext, values: ArrayLike<number>, sampleRate: number, options: SeriesSpectrumOptions = {}): Promise<SeriesSpectrum> {
  validate(values, sampleRate, options);
  const n = values.length, input = new Float32Array(n), bins = Math.floor(n / 2) + 1;
  let scale = 0, mean = 0, energy = 0;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(values[i]));
  if (!scale) scale = 1;
  if (options.detrend !== false) for (let i = 0; i < n; i++) mean += values[i] / scale / n;
  for (let i = 0; i < n; i++) { const w = options.window === 'rectangular' ? 1 : 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); input[i] = (values[i] / scale - mean) * w; energy += w * w; }
  const { fft } = await import('@margoengine/compute/fft'); options.signal?.throwIfAborted();
  using data = gpu.array(input);
  const transformed = fft(data);
  try {
    const [re, im] = await Promise.all([transformed.re.read({ signal: options.signal }), transformed.im.read({ signal: options.signal })]);
    options.signal?.throwIfAborted();
    const frequency = new Float64Array(bins), real = new Float64Array(bins), imaginary = new Float64Array(bins), power = new Float64Array(bins);
    for (let i = 0; i < bins; i++) {
      frequency[i] = i * sampleRate / n; real[i] = re[i] * scale; imaginary[i] = im[i] * scale;
      const sided = i === 0 || (n % 2 === 0 && i === n / 2) ? 1 : 2;
      power[i] = (real[i] * real[i] + imaginary[i] * imaginary[i]) * sided / (sampleRate * energy);
    }
    return { frequency, real, imaginary, power };
  } finally { transformed.re.dispose(); transformed.im.dispose(); }
}
/** Short-time Fourier transform settings. */
export interface SeriesSpectrogramOptions extends SeriesSpectrumOptions {
  /** Default 256 samples; no padding of incomplete final windows. */ readonly windowSize?: number;
  /** Default floor(windowSize/2). */ readonly hopSize?: number;
  /** Start of the original recording in seconds, default 0. */ readonly startTime?: number;
  /** Maximum output bytes, default 268435456. */ readonly maxBytes?: number;
}
/** Column-major time/frequency cells suitable for Figure.heatmap: power[frequency * times.length + time]. */
export interface SeriesSpectrogram {
  readonly times: Float64Array;
  readonly frequency: Float64Array;
  readonly power: Float64Array;
  readonly hopSeconds: number;
  readonly binHz: number;
}
/** Windowed FFT of original samples with bounded one-window GPU staging, binary64 PSD and AbortSignal. */
export async function seriesSpectrogram(gpu: ComputeContext, values: ArrayLike<number>, sampleRate: number, options: SeriesSpectrogramOptions = {}): Promise<SeriesSpectrogram> {
  validate(values, sampleRate, options);
  const n = options.windowSize ?? 256, hop = options.hopSize ?? Math.floor(n / 2), start = options.startTime ?? 0, limit = options.maxBytes ?? 268435456;
  if (!Number.isSafeInteger(n) || n < 2 || n > values.length || !Number.isSafeInteger(hop) || hop < 1 || !Number.isFinite(start) || !Number.isSafeInteger(limit) || limit < 0) throw rangeError('Use a window within the recording, a positive integer hop and a finite start time and byte limit', 'sciviz');
  const frames = Math.floor((values.length - n) / hop) + 1, bins = Math.floor(n / 2) + 1;
  if ((frames * bins + frames + bins) * 8 > limit) throw rangeError('Increase spectrogram maxBytes or reduce the window count', 'sciviz');
  const times = new Float64Array(frames), frequency = Float64Array.from({ length: bins }, (_, i) => i * sampleRate / n), power = new Float64Array(frames * bins), window = new Float64Array(n);
  for (let frame = 0; frame < frames; frame++) {
    options.signal?.throwIfAborted();
    for (let i = 0; i < n; i++) window[i] = values[frame * hop + i];
    const spectrum = await seriesSpectrum(gpu, window, sampleRate, options);
    times[frame] = start + (frame * hop + n / 2) / sampleRate;
    for (let k = 0; k < bins; k++) power[k * frames + frame] = spectrum.power[k];
  }
  return { times, frequency, power, hopSeconds: hop / sampleRate, binHz: sampleRate / n };
}
/** Plot PSD in physical units; choose figure axis scales independently. */
export async function addSpectrumView(figure: Figure, spectrum: SeriesSpectrum): Promise<LineLayer> {
  return figure.line({ x: spectrum.frequency, y: spectrum.power }, { name: 'Power spectral density' });
}
/** Plot STFT PSD as dB relative to one physical value squared/Hz. Half-cell bounds retain true window-centre coordinates. */
export async function addSpectrogramView(figure: Figure, spectrum: SeriesSpectrogram, options: HeatmapLayerOptions = {}): Promise<RectsLayer> {
  if (!spectrum.times.length || !spectrum.frequency.length) throw rangeError('Compute at least one spectrogram window before drawing', 'sciviz');
  return figure.heatmap(Float32Array.from(spectrum.power, (v) => 10 * Math.log10(Math.max(Number.MIN_VALUE, v))), {
    name: 'Spectrogram (dB / Hz)', colormap: 'inferno', ...options, nx: spectrum.times.length, ny: spectrum.frequency.length,
    x: [spectrum.times[0] - spectrum.hopSeconds / 2, spectrum.times.at(-1)! + spectrum.hopSeconds / 2],
    y: [spectrum.frequency[0] - spectrum.binHz / 2, spectrum.frequency.at(-1)! + spectrum.binHz / 2],
  });
}
