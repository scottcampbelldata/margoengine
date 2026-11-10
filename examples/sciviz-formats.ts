import { Figure, type VolumeLayer } from '@margoengine/sciviz/spec';
import { openNetCDF } from '@margoengine/sciviz/netcdf';
import { openVTK, parseVtk } from '@margoengine/sciviz/vtk';
import { gridLayer, type MeshLayer } from '@margoengine/sciviz/grids';
import { element, fail, exportButton } from './sciviz-demo.js';

export const figure = await Figure.create(element<HTMLCanvasElement>('viewport'), {
  limits: [0, 4, 0, 4, 0, 7],
  titles: { x: 'Longitude index', y: 'Latitude index', z: 'Day index' },
});
let current: VolumeLayer | MeshLayer | undefined;
const files = {
  classic: new URL('./assets/sciviz/wind-classic.nc', import.meta.url),
  offset: new URL('./assets/sciviz/wind-offset.nc', import.meta.url),
  vti: new URL('./assets/sciviz/wind.vti', import.meta.url),
  vts: new URL('./assets/sciviz/wind.vts', import.meta.url),
  vtu: new URL('./assets/sciviz/wind.vtu', import.meta.url),
  legacy: new URL('./assets/sciviz/wind.vtk', import.meta.url),
};
export async function show(format: string): Promise<void> {
  const signal = AbortSignal.timeout(30_000),
    url = files[format as keyof typeof files];
  let next: VolumeLayer | MeshLayer;
  if (format === 'classic' || format === 'offset') {
    using file = await openNetCDF(url, { signal });
    const grid = await file.variables.uwnd.volume({ bounds: [0, 4, 0, 4, 0, 7] });
    next = await figure.volume(grid.data, { dims: grid.dims, bounds: grid.bounds, range: [-11, 7], density: 0.2 });
  } else if (format === 'legacy') {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Wind file HTTP ${response.status}`);
    next = gridLayer(figure, parseVtk(await response.arrayBuffer()), { range: [-11, 7], colormap: 'viridis' });
  } else {
    using file = await openVTK(url, { signal });
    if (format === 'vti') {
      const grid = await file.volume('uwnd');
      next = await figure.volume(grid.data, { dims: grid.dims, bounds: grid.bounds, range: [-11, 7], density: 0.2 });
    } else next = gridLayer(figure, await file.grid('uwnd'), { range: [-11, 7], colormap: 'viridis' });
  }
  if (current) figure.remove(current);
  current = next;
  await figure.ready();
  element('status').textContent = `200 NOAA wind samples from ${format}; drag to orbit, scroll to zoom.`;
  element('viewport').dataset.ready = format;
}
element('format').addEventListener('change', () => {
  void show(element<HTMLSelectElement>('format').value).catch(fail);
});
exportButton(figure, 'noaa-wind-files');
try {
  await show('classic');
} catch (error) {
  fail(error);
}
window.addEventListener('pagehide', () => figure.dispose(), { once: true });
