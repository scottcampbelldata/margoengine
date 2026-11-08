// The drawing cases of entries-browser.js, one per entry feature. Each places the camera, adds its layer and returns
// the facts it checked.
import { gridLayer, CELL_TYPES } from '@margoengine/sciviz/grids';

/** The cases entries-browser.js runs, in order. */
export const cases = [];
const addCase = (name, run) => cases.push({ name, run });

function look(figure, position = [1.9, 1.3, 2.1]) {
  figure.engine.stop?.();
  figure.engine.camera.position = position;
  figure.engine.camera.target = [0, 0, 0];
  figure.engine.camera.up = [0, 1, 0];
}

// n x n x n unit hexahedra with point data x + y + z, as in tests/grids.test.js.
function block(n) {
  const points = [],
    id = (i, j, k) => (k * (n + 1) + j) * (n + 1) + i;
  for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) points.push(i, j, k);
  const connectivity = [],
    offsets = [],
    types = [];
  for (let k = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        connectivity.push(id(i, j, k), id(i + 1, j, k), id(i + 1, j + 1, k), id(i, j + 1, k));
        connectivity.push(id(i, j, k + 1), id(i + 1, j, k + 1), id(i + 1, j + 1, k + 1), id(i, j + 1, k + 1));
        offsets.push(connectivity.length);
        types.push(CELL_TYPES.hexahedron);
      }
  const pointData = [];
  for (let p = 0; p < points.length; p += 3) pointData.push(points[p] + points[p + 1] + points[p + 2]);
  return { points, connectivity, offsets, types, pointData };
}

addCase('grid-surface', async (figure, { pixels, lit, assert }) => {
  look(figure);
  const layer = gridLayer(figure, block(4), { colormap: 'aurora' });
  await figure.ready();
  const image = await pixels(),
    count = lit(image);
  assert(layer.triangles === 6 * 16 * 2, `surface has ${layer.triangles} triangles`);
  assert(count > 5000, `the grid surface lit ${count} pixels`);
  return { triangles: layer.triangles, lit: count };
});

addCase('grid-slice', async (figure, { pixels, lit, assert }) => {
  look(figure);
  const layer = gridLayer(figure, block(4), { slice: { normal: [1, 1, 1], offset: 6 }, colormap: 'aurora' });
  await figure.ready();
  const image = await pixels(),
    count = lit(image);
  assert(layer.triangles > 0, 'the slice cut no cells');
  assert(count > 2000, `the slice lit ${count} pixels`);
  return { triangles: layer.triangles, lit: count };
});
