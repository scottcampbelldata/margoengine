// Browser side of range-overflow-browser.mjs: draws a surface, a mesh or a graph whose values are all 0 with a colour
// range, captures it with toPNG({overlays: false}) and returns the RGBA pixels. Values of 0 sit halfway along both
// [-1, 1] and [-1e308, 1e308], so the two captures must match.
import { Figure } from '@margoengine/sciviz/spec';
import { meshLayer } from '@margoengine/sciviz/grids';
import { graphLayer } from '@margoengine/sciviz/graph';

const canvas = document.getElementById('view');
const n = 16;
const add = {
  surface: (figure, range) =>
    figure.surface(new Float32Array(n * n), { nx: n, ny: n, x: [-1, 1], y: [-1, 1], range, contours: 0 }),
  mesh: (figure, range) =>
    meshLayer(
      figure,
      {
        positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: new Float32Array(Array.from({ length: 6 }, () => [0, 0, 1]).flat()),
        values: new Float32Array(6),
        cells: new Uint32Array([0, 1]),
        bounds: [-1, 1, -1, 1, 0, 0],
      },
      { range },
    ),
  graph: (figure, range) =>
    graphLayer(figure, { nodes: 2, edges: [0, 1] }, new Float32Array([-0.5, 0, 0, 0.5, 0, 0]), {
      nodeSize: 40,
      values: [0, 0],
      range,
    }),
};
let figure;
window.capture = async ({ kind, range }) => {
  figure?.dispose?.();
  figure = await Figure.create(canvas, { axes: false });
  figure.engine.stop();
  add[kind](figure, range);
  await figure.ready();
  const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false })),
    copy = new OffscreenCanvas(bitmap.width, bitmap.height),
    ctx = copy.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return Array.from(ctx.getImageData(0, 0, copy.width, copy.height).data);
};
window.ready = true;
