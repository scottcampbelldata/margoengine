// OpenNeuro ds000030, CC0. The local NRRD has the scan's intensities and 2 mm RAS sampling.
import type { IsosurfaceLayer, SliceLayer } from '@margoengine/sciviz';
import { loadNRRD, nrrdGrid } from '@margoengine/sciviz/nrrd';
import { createFigure, element, exportButton, fail, signal } from './sciviz-demo.js';

export const figure = await createFigure(element<HTMLCanvasElement>('viewport'), {
  aspect: [174 / 254, 1, 1],
  titles: { x: 'Right (mm)', y: 'Anterior (mm)', z: 'Superior (mm)' },
});
export let surface: IsosurfaceLayer | undefined;
export let settled = Promise.resolve();
figure.engine.camera.position = element('viewport').clientWidth < 600 ? [2.6, 1.7, 2.9] : [1.8, 1.2, 2];

try {
  const grid = nrrdGrid(await loadNRRD(new URL('./assets/sciviz/head.nrrd', import.meta.url), { signal }));
  const volume = figure.volume(grid.data, {
    ...grid,
    range: [0, 600],
    colormap: 'gray',
    density: 2,
    // A cutaway exposes tissue inside the outer surface. The background stays clear.
    opacity: [
      [0, 0],
      [0.12, 0],
      [0.3, 0.03],
      [0.55, 0.12],
      [1, 0.2],
    ],
    clip: [{ normal: [-1, 0, 0], offset: 0.55 }],
  });
  let slice: SliceLayer = volume.slice('z', 0.5);
  slice.visible = false;
  figure.colorbar('gray', [0, 600], { label: 'MRI intensity' });
  const update = async () => {
    const view = element<HTMLSelectElement>('view').value;
    const axis = element<HTMLSelectElement>('axis').value as 'x' | 'y' | 'z';
    const position = Number(element<HTMLInputElement>('position').value) / 100;
    const level = Number(element<HTMLInputElement>('level').value);
    element<HTMLSelectElement>('axis').disabled = view !== 'slice';
    element<HTMLInputElement>('position').disabled = view !== 'slice';
    element<HTMLInputElement>('level').disabled = view !== 'surface';
    element('position-out').textContent = `${Math.round(position * 100)}%`;
    element('level-out').textContent = String(level);
    if (slice.axis !== axis) {
      slice.dispose();
      slice = volume.slice(axis, position);
    }
    slice.position = position;
    // Keep the displayed view while the first extraction is pending.
    if (view === 'surface') {
      if (surface) await surface.update(level);
      else surface = await figure.isosurface(grid.data, level, { ...grid, color: '#b5d9d3' });
    }
    volume.visible = view === 'volume';
    slice.visible = view === 'slice';
    if (surface) surface.visible = view === 'surface';
    await figure.ready();
    element('status').textContent =
      view === 'surface'
        ? `Intensity ${level}: ${surface!.triangles.toLocaleString('en')} triangles.`
        : 'OpenNeuro T1w MRI. Drag to orbit; scroll to zoom.';
  };
  // Serialise first surface creation as well as updates when controls change quickly.
  for (const id of ['view', 'axis', 'position', 'level']) {
    element(id).addEventListener(id === 'position' || id === 'level' ? 'input' : 'change', () => {
      settled = settled.then(update);
      void settled.catch(fail);
    });
  }
  await update();
  exportButton(figure, 'mri-head-volume');
  element('viewport').dataset.ready = 'true';
} catch (error) {
  fail(error);
}
window.addEventListener('pagehide', () => figure.dispose(), { once: true });
