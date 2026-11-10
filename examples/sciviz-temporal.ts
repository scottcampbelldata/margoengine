import type { Figure, RectsLayer } from '@margoengine/sciviz';
import { openNetCDF, type NetCDFFile } from '@margoengine/sciviz/netcdf';
import type { ProbeInput } from '@margoengine/sciviz/probe';
import {
  temporalStatistics, interpolateTemporal, probeTemporal, plotTemporalProbe, parseFileSeries,
  groupFileSeries, fileSeriesSource, formatTemporalTime,
  type TemporalSource, type TemporalStatistics, type TemporalProbe, type TemporalChart,
} from '@margoengine/sciviz/temporal';
import { createFigure, element, fail } from './sciviz-demo.js';
const seriesURL = new URL('./assets/sciviz/temporal/wind.json.series', import.meta.url), root = new URL('.', seriesURL);
let controller = new AbortController(), file: NetCDFFile | undefined, chart: TemporalChart | undefined,
  fieldLayer: RectsLayer | undefined, queue = Promise.resolve();
export let fieldFigure: Figure, figure: Figure, source: TemporalSource, statistics: TemporalStatistics,
  probe: TemporalProbe, units = '', dims: readonly [number, number, number], bounds: [number, number, number, number, number, number];
async function json(url: URL | string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Temporal data HTTP ${response.status}`);
  return response.json();
}
export async function drawField(): Promise<void> {
  const { signal } = controller, statistic = element<HTMLSelectElement>('statistic').value,
    fraction = Number(element<HTMLInputElement>('time').value) / 7,
    time = source.times[0] + fraction * (source.times[source.times.length - 1] - source.times[0]),
    values = statistic === 'step' ? await interpolateTemporal(source, time, { signal }) : statistics[statistic as 'mean'];
  signal.throwIfAborted();
  const next = await fieldFigure.heatmap(values, { nx: dims[0], ny: dims[1], x: [bounds[0], bounds[1]], y: [bounds[2], bounds[3]],
    colormap: 'viridis', name: statistic });
  if (fieldLayer) fieldFigure.remove(fieldLayer);
  fieldLayer = next;
  element('timestamp').textContent = formatTemporalTime(time, units);
  await fieldFigure.ready();
}
export async function sampleProbe(): Promise<void> {
  const { signal } = controller, position: [number, number, number] = [Number(element<HTMLInputElement>('longitude').value), Number(element<HTMLInputElement>('latitude').value), 0];
  const gridSource: TemporalSource<ProbeInput> = { times: source.times, read: async (i, options) => ({ dims, bounds, pointData: await source.read(i, options) }) };
  const next = await probeTemporal(gridSource, position, { signal });
  signal.throwIfAborted();
  const plotted = await plotTemporalProbe(figure, next, { signal, color: '#69cced', name: 'Probe' });
  chart?.dispose(); chart = plotted; probe = next;
  const summary = await temporalStatistics({ times: probe.times, read: i => [probe.values[i]] }, { signal });
  element('summary').textContent = `Probe: mean ${summary.mean[0].toFixed(3)}, minimum ${summary.minimum[0].toFixed(3)}, maximum ${summary.maximum[0].toFixed(3)}, standard deviation ${summary.standardDeviation[0].toFixed(3)}. ${probe.valid.reduce((a, b) => a + b, 0)} of ${probe.times.length} observations.`;
  await figure.ready();
}
export async function show(mode: 'noaa' | 'era5'): Promise<void> {
  controller.abort(); controller = new AbortController();
  const { signal } = controller;
  chart?.dispose(); chart = undefined; figure?.dispose(); fieldFigure?.dispose(); file?.dispose(); file = undefined; fieldLayer = undefined;
  element('status').textContent = 'Loading...';
  if (mode === 'noaa') {
    units = 'days since 2024-01-01'; dims = [5, 5, 1]; bounds = [-100, -90, 20, 30, 0, 0];
    const series = parseFileSeries(await json(seriesURL, signal), { units, baseURL: root });
    const numbered = groupFileSeries(series.files.map(f => f.name), { units });
    if (numbered.length !== 1 || numbered[0].files.length !== 8) throw new Error('Expected one eight-file wind series');
    source = fileSeriesSource(series, async (f, options) => (await json(f.name, options.signal!)).values as number[]);
    element<HTMLInputElement>('longitude').value = '-95'; element<HTMLInputElement>('latitude').value = '25';
  } else {
    file = await openNetCDF(new URL('era5.nc', root), { signal });
    const nc = file, times = await nc.variables.time.read({ signal }), lat = await nc.variables.latitude.read({ signal }), lon = await nc.variables.longitude.read({ signal });
    units = nc.variables.time.attributes.units as string;
    dims = [64, 32, 1]; bounds = [lon[0], lon[63], Math.min(lat[0], lat[31]), Math.max(lat[0], lat[31]), 0, 0];
    source = { times, async read(i, options) {
      const raw = await nc.variables['2m_temperature'].read({ start: [i, 0, 0], count: [1, 64, 32], signal: options.signal }), out = new Float64Array(raw.length);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) out[y * 64 + x] = raw[x * 32 + (lat[0] < lat[31] ? y : 31 - y)];
      return out;
    } };
    element<HTMLInputElement>('longitude').value = '90'; element<HTMLInputElement>('latitude').value = '25';
  }
  statistics = await temporalStatistics(source, { signal });
  figure = await createFigure(element<HTMLCanvasElement>('chart'), { mode: '2d', titles: { x: mode === 'noaa' ? 'Days since first observation' : 'Hours since first observation', y: mode === 'noaa' ? 'Eastward wind (m/s)' : 'Temperature (K)' } });
  fieldFigure = await createFigure(element<HTMLCanvasElement>('field'), { mode: '2d', titles: { x: 'Longitude', y: 'Latitude' } });
  await drawField(); await sampleProbe();
  element('status').textContent = `Ready. ${mode === 'noaa' ? 'NOAA daily wind' : 'ERA5 six-hour temperature'}: ${source.times.length} steps, ${statistics.mean.length} values per step.`;
}
function enqueue(action: () => Promise<void>) { queue = queue.then(action).catch(fail); }
element('dataset').addEventListener('change', () => enqueue(() => show(element<HTMLSelectElement>('dataset').value as 'noaa' | 'era5')));
element('statistic').addEventListener('change', () => enqueue(drawField));
element('time').addEventListener('input', () => enqueue(drawField));
element('probe').addEventListener('click', () => enqueue(sampleProbe));
window.addEventListener('pagehide', () => { controller.abort(); chart?.dispose(); figure?.dispose(); fieldFigure?.dispose(); file?.dispose(); }, { once: true });
try { await show('noaa'); } catch (error) { fail(error); }
