import { Figure } from '@margoengine/sciviz/spec';
import { readInWorker, type ReaderSession } from '@margoengine/sciviz/workers';
import { gridLayer } from '@margoengine/sciviz/grids';
import type { VolumeGrid } from '@margoengine/sciviz/formats';
import { element, fail, exportButton } from './sciviz-demo.js';

export let figure = await Figure.create(element<HTMLCanvasElement>('viewport'), { limits: [0, 4, 0, 4, 0, 7] });
let session: ReaderSession<unknown> | undefined;
let lifetime = new AbortController();
let imageMode = false;
export const milestones: unknown[] = [];
const asset = (name: string) => new URL(`./assets/sciviz/${name}`, import.meta.url).href;
const fixture = (name: string) => new URL(`../packages/sciviz/tests/fixtures/${name}`, import.meta.url).href;
export async function show(format: string): Promise<void> {
  lifetime.abort();
  session?.dispose();
  lifetime = new AbortController();
  if (imageMode !== (format === 'dicom')) {
    figure.dispose();
    imageMode = format === 'dicom';
    figure = await Figure.create(element<HTMLCanvasElement>('viewport'), {
      mode: imageMode ? '2d' : '3d',
      limits: imageMode ? [0, 1, 0, 1] : [0, 4, 0, 4, 0, 7],
    });
  }
  const options = {
    signal: lifetime.signal,
    onProgress: (event: unknown) => {
      milestones.push(event);
      element('status').textContent = JSON.stringify(event);
    },
  };
  let grid: VolumeGrid | undefined;
  if (format === 'netcdf') {
    const current = await readInWorker('openNetCDF', ['./assets/sciviz/wind-classic.nc'], options);
    session = current;
    grid = await current.value.variables.uwnd.volume();
  } else if (format === 'vtkxml') {
    const current = await readInWorker('openVTK', [asset('wind.vti')], options);
    session = current;
    grid = await current.value.volume('uwnd');
  } else if (format === 'vtk') {
    const bytes = await (await fetch(asset('wind.vtk'), { signal: lifetime.signal })).arrayBuffer();
    const current = await readInWorker('parseVtk', [bytes], { ...options, transfer: [bytes] });
    session = current;
    for (const layer of [...figure.layers]) figure.remove(layer);
    figure.setLimits([0, 4, 0, 4, 0, 7]);
    gridLayer(figure, current.value, { range: [-11, 7], colormap: 'viridis' });
  } else if (format === 'zarr') {
    // The existing native NOAA samples are exposed as a Zarr v2 key store, without resampling.
    const source = await readInWorker('openNetCDF', [asset('wind-classic.nc')], options);
    let data: Float64Array;
    try {
      data = await source.value.variables.uwnd.read();
    } finally {
      source.dispose();
    }
    const store = {
      '.zarray': JSON.stringify({
        zarr_format: 2,
        shape: [8, 5, 5],
        chunks: [8, 5, 5],
        dtype: '<f8',
        compressor: null,
        fill_value: 0,
        order: 'C',
        filters: null,
      }),
      '0.0.0': new Uint8Array(data.buffer),
    };
    const current = await readInWorker('openZarr', [store], { ...options, transfer: [data.buffer as ArrayBuffer] });
    session = current;
    grid = { data: (await current.value.read()).data, dims: [5, 5, 8], bounds: [0, 4, 0, 4, 0, 7], range: [-11, 7] };
  } else if (format === 'nrrd') {
    const current = await readInWorker('loadNRRD', [asset('head.nrrd')], options);
    session = current;
    grid = { ...current.value, range: [0, 715] };
  } else if (format === 'nifti') {
    const current = await readInWorker('loadNIfTI', [fixture('zstat1.nii.gz')], options);
    session = current;
    grid = current.value;
  } else {
    const current = await readInWorker('loadDICOMSeries', [[fixture('CT_small.dcm')]], options);
    session = current;
    grid = current.value;
  }
  if (grid) {
    for (const layer of [...figure.layers]) figure.remove(layer);
    if (grid.dims[2] === 1) {
      figure.setLimits([grid.bounds[0], grid.bounds[1], grid.bounds[2], grid.bounds[3]]);
      await figure.heatmap(grid.data, { nx: grid.dims[0], ny: grid.dims[1], range: grid.range });
    } else {
      figure.setLimits(grid.bounds);
      await figure.volume(grid.data, { dims: grid.dims, bounds: grid.bounds, range: grid.range, density: 0.2 });
    }
  }
  await figure.ready();
  element('status').textContent =
    `${format}: worker decoded the file and transferred the samples. Drag to orbit, scroll to zoom.`;
  element('viewport').dataset.ready = format;
}
element('format').addEventListener('change', () => {
  void show(element<HTMLSelectElement>('format').value).catch(fail);
});
exportButton(figure, 'worker-reader');
try {
  await show('netcdf');
} catch (error) {
  fail(error);
}
window.addEventListener(
  'pagehide',
  () => {
    lifetime.abort();
    session?.dispose();
    figure.dispose();
  },
  { once: true },
);
