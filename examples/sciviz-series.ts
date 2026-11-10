import { createCompute } from '@margoengine/compute';
import { TimeSeries, bindSeries, openSeriesSource, seriesSpectrum, seriesSpectrogram, addSpectrumView, addSpectrogramView, type SeriesBinding, type SeriesMethod } from '@margoengine/sciviz/series';
import { createFigure, element } from './sciviz-demo.js';
export const figure = await createFigure(element<HTMLCanvasElement>('viewport'), { mode: '2d', theme: 'light', controls: false, titles: { x: 'Seconds from GW150914', y: 'Strain' }, limits: [-2.43, 1.57, -8e-19, 8e-19] });
figure.dragMode = 'box';
export const spectrumFigure = await createFigure(element<HTMLCanvasElement>('spectrum'), { mode: '2d', theme: 'light', controls: false, titles: { x: 'Frequency (Hz)', y: 'Strain squared / Hz' }, scale: { y: 'log' }, limits: [0, 1024, 1e-48, 1e-35] });
export const spectrogramFigure = await createFigure(element<HTMLCanvasElement>('spectrogram'), { mode: '2d', theme: 'light', controls: false, titles: { x: 'Seconds from GW150914', y: 'Frequency (Hz)' } });
export const gpu = await createCompute({ engine: figure.engine });
export let binding: SeriesBinding, operation: AbortController;
export const progress: { rows: number; bytes: number }[] = [];
export async function load(): Promise<void> {
  operation?.abort(); binding?.dispose(); operation = new AbortController();
  const format = element<HTMLSelectElement>('format').value as 'csv' | 'arrow' | 'parquet';
  binding = await bindSeries(figure, new TimeSeries(), { method: element<HTMLSelectElement>('method').value as SeriesMethod, color: '#267894', name: 'H1 original strain', signal: operation.signal });
  binding.addEventListener('selection', () => { element('selection').textContent = `${binding.selected.length.toLocaleString()} original samples selected`; });
  binding.addEventListener('progress', (event) => {
    const part = (event as CustomEvent).detail; progress.push({ rows: binding.data.length, bytes: part.loadedBytes });
    element('status').textContent = `${binding.data.length.toLocaleString()} samples loaded; ${binding.indices.length.toLocaleString()} displayed; ${part.loadedBytes.toLocaleString()} bytes read`;
  });
  const source = await openSeriesSource(`/packages/sciviz/tests/fixtures/series/gw150914.${format}`, { signal: operation.signal });
  await binding.load(source, { format, x: 'time', y: 'strain', chunkBytes: 32768, signal: operation.signal });
  for (const layer of [...spectrumFigure.layers]) spectrumFigure.remove(layer);
  for (const layer of [...spectrogramFigure.layers]) spectrogramFigure.remove(layer);
  const strain = Float64Array.from({ length: binding.data.length }, (_, i) => binding.data.y(i));
  const spectrum = await seriesSpectrum(gpu, strain, 4096, { signal: operation.signal });
  await addSpectrumView(spectrumFigure, spectrum);
  const spectrogram = await seriesSpectrogram(gpu, strain, 4096, { windowSize: 512, hopSize: 512, startTime: binding.data.x(0), signal: operation.signal });
  await addSpectrogramView(spectrogramFigure, spectrogram);
  spectrumFigure.render(); spectrogramFigure.render();
  element('status').dataset.ready = 'true';
}
const failed = (cause: unknown) => { if (!(cause instanceof DOMException && cause.name === 'AbortError')) { element('status').textContent = String(cause); element('status').dataset.error = 'true'; } };
element('reload').onclick = () => { element('status').dataset.ready = 'false'; void load().catch(failed); };
element('stop').onclick = () => operation.abort();
element('zoom').onclick = () => { figure.setLimits([-0.2, 0.2, -8e-19, 8e-19]); void binding.refresh().catch(failed); };
element('reset').onclick = () => { figure.setLimits([-2.43, 1.57, -8e-19, 8e-19]); void binding.refresh().catch(failed); };
void load().catch(failed);
