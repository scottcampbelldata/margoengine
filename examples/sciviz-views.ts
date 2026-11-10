import { VolumeQuad, ComparativeGrid } from '@margoengine/sciviz/views';
import type { PipelineJSON, PipelineRegistry } from '@margoengine/sciviz/pipeline';
import { loadNRRD, nrrdGrid } from '@margoengine/sciviz/nrrd';
import { createFigure, element, floats, signal } from './sciviz-demo.js';
export const t1Data = nrrdGrid(await loadNRRD(new URL('./assets/sciviz/head.nrrd', import.meta.url), { signal }));
export const quad = await VolumeQuad.create(element('quad'), t1Data, {
  height: 300,
  range: [0, 500],
  createFigure: (canvas, options) => createFigure(canvas, { ...options, controls: true }),
});
// The factory must apply per-view options, including each slice's orthographic mode.

quad.layout.figures[3].engine.camera.position = [1.8, 1.4, 2.0];
const data = await floats(new URL('./assets/sciviz/wind.bin', import.meta.url)),
  nx = 49,
  ny = 19,
  size = nx * ny;
export const pipeline: PipelineJSON = {
  version: 1,
  nodes: [
    { id: 'day', type: 'wind.day' },
    { id: 'speed', type: 'wind.speed', inputs: ['day'], params: { minimum: 0 } },
  ],
};
export const registry: PipelineRegistry = {
  'wind.day': {
    kind: 'source',
    timeDependent: true,
    execute: ({ time }) => {
      if (!Number.isInteger(time) || time < 0 || time >= 8)
        throw new RangeError('Choose one of the eight observed NOAA days');
      return {
        u: data.subarray(time * 2 * size, (time * 2 + 1) * size),
        v: data.subarray((time * 2 + 1) * size, (time * 2 + 2) * size),
      };
    },
  },
  'wind.speed': {
    kind: 'filter',
    execute: ({ inputs, params }) => {
      const field = inputs[0] as { u: Float32Array; v: Float32Array },
        minimum = (params as { minimum: number }).minimum;
      return Float32Array.from(field.u, (u, i) => {
        const speed = Math.hypot(u, field.v[i]);
        return speed >= minimum ? speed : NaN;
      });
    },
  },
};
export const grid = await ComparativeGrid.create(element('wind'), pipeline, registry, {
  columns: 2,
  height: 270,
  figureOptions: () => ({ mode: '2d', titles: { x: 'Longitude', y: 'Latitude' } }),
  createFigure: (canvas, options) => createFigure(canvas, options),
  cells: [
    { label: 'January 1: all speeds', time: 0 },
    { label: 'January 8: all speeds', time: 7 },
    { label: 'January 1: at least 15 m/s', time: 0, params: { speed: { minimum: 15 } } },
    { label: 'January 8: at least 15 m/s', time: 7, params: { speed: { minimum: 15 } } },
  ],
  target: 'speed',
  draw: async (figure, output) => {
    await figure.heatmap(output as Float32Array, {
      nx,
      ny,
      x: [-100, 20],
      y: [20, 65],
      range: [0, 35],
      colormap: 'viridis',
    });
    figure.colorbar('viridis', [0, 35], { label: 'Wind speed (m/s)' });
  },
});
for (let axis = 0; axis < 3; axis++) {
  const label = document.createElement('label'),
    input = document.createElement('input');
  label.textContent = ['x', 'y', 'z'][axis] + ' (mm) ';
  input.type = 'range';
  input.min = String(Math.min(t1Data.bounds[axis * 2], t1Data.bounds[axis * 2 + 1]));
  input.max = String(Math.max(t1Data.bounds[axis * 2], t1Data.bounds[axis * 2 + 1]));
  input.step = String(Math.abs(t1Data.bounds[axis * 2 + 1] - t1Data.bounds[axis * 2]) / (t1Data.dims[axis] - 1));
  input.value = String(quad.crosshair[axis]);
  input.setAttribute('aria-label', ['x', 'y', 'z'][axis] + ' physical crosshair');
  input.oninput = () => {
    const p = [...quad.crosshair] as [number, number, number];
    p[axis] = Number(input.value);
    void quad.setCrosshair(p);
  };
  quad.addEventListener('change', () => {
    input.value = String(quad.crosshair[axis]);
  });
  label.append(input);
  element('sliders').append(label);
}
window.addEventListener(
  'pagehide',
  () => {
    quad.dispose();
    grid.dispose();
  },
  { once: true },
);
element('status').textContent = 'OpenNeuro T1 quad view and four NOAA wind comparisons loaded.';
element('status').dataset.ready = 'true';
