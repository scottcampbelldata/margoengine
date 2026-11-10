/// <reference lib="esnext.disposable" preserve="true" />
export { TimeSeries, downsampleSeries, type SeriesValues, type SeriesMethod, type DownsampleOptions } from './series-data.js';
export { openSeriesSource, readSeries, type SeriesSource, type SeriesReadOptions, type SeriesChunk } from './series-source.js';
export { seriesSpectrum, seriesSpectrogram, addSpectrumView, addSpectrogramView, type SeriesSpectrum, type SeriesSpectrumOptions, type SeriesSpectrogram, type SeriesSpectrogramOptions } from './series-spectral.js';
export { bindSeries, type SeriesBinding, type SeriesBindingOptions } from './series-figure.js';
