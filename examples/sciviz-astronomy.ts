import { Figure } from '@margoengine/sciviz';
import { readFITS } from '@margoengine/sciviz/fits';
import { readMRC } from '@margoengine/sciviz/mrc';
import { readOMETIFF } from '@margoengine/sciviz/ometiff';
import { element, signal } from './sciviz-demo.js';

const root = new URL('../packages/sciviz/tests/fixtures/astronomy/expected.json', import.meta.url);
export const figures: Record<string, Figure> = {};
export const samples: Record<string, number> = {};
try {
  const file = await readFITS(new URL('sdss-frame.fits.bz2', root), { signal }),
    image = file.hdus[0];
  if (image.kind !== 'image') throw new TypeError('SDSS primary HDU must be an image');
  const nx = Math.ceil(image.axes[0] / 8),
    ny = Math.ceil(image.axes[1] / 8),
    data = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++)
      data[y * nx + x] = Math.asinh(Number(image.data[y * 8 * image.axes[0] + x * 8]) / 0.05);
  const sky = (figures.sdss = await Figure.create(element<HTMLCanvasElement>('sdss'), {
    mode: '2d',
    axes: false,
    controls: false,
  }));
  await sky.heatmap(data, { nx, ny, range: [-1, 5], colormap: 'gray' });
  await sky.ready();
  sky.engine.render();
  sky.engine.stop();
  samples.sdss = image.data.length;
  const map = await readMRC(new URL('emd_1003.map.gz', root), { signal }),
    density = (figures.emdb = await Figure.create(element<HTMLCanvasElement>('emdb'), {
      axes: false,
      controls: false,
    }));
  density.volume(map.data, {
    dims: map.dims,
    range: [0, 5],
    quality: 1,
    opacity: [
      [0, 0],
      [0.3, 0],
      [0.6, 0.04],
      [1, 0.15],
    ],
    colormap: 'viridis',
  });
  await density.ready();
  density.engine.render();
  density.engine.stop();
  samples.emdb = map.data.length;
  const stack = await readOMETIFF(new URL('idr0096-crop.ome.tiff', root), { signal }),
    plane = await stack.plane(),
    microscopy = (figures.idr = await Figure.create(element<HTMLCanvasElement>('idr'), {
      mode: '2d',
      axes: false,
      controls: false,
    }));
  await microscopy.heatmap(plane, { nx: 256, ny: 256, range: [0, 255], colormap: 'gray' });
  await microscopy.ready();
  microscopy.engine.render();
  microscopy.engine.stop();
  samples.idr = plane.length;
  element('status').textContent =
    `Decoded ${samples.sdss} SDSS pixels, ${samples.emdb} EMDB voxels and ${samples.idr} IDR pixels.`;
  element<HTMLCanvasElement>('sdss').dataset.ready = 'true';
} catch (error) {
  element<HTMLCanvasElement>('sdss').dataset.error = String(error);
  throw error;
}
window.addEventListener(
  'pagehide',
  () => {
    for (const figure of Object.values(figures)) figure.dispose();
  },
  { once: true },
);
