import { Figure } from '@margoengine/sciviz/spec';
import { glyphLayer, warpByVector, warpByScalar, type GlyphLayer, type GlyphShape } from '@margoengine/sciviz/glyph';
import { gridLayer, type MeshLayer } from '@margoengine/sciviz/grids';
import { readDisplacement } from './sciviz-glyph-data.js';
import { element, floats, fail } from './sciviz-demo.js';
export const windFigure = await Figure.create(element<HTMLCanvasElement>('wind'), { axes: false, controls: false }),
  warpFigure = await Figure.create(element<HTMLCanvasElement>('displacement'), { axes: false, controls: false });
windFigure.engine.camera.position = [0, 3.2, 0];
windFigure.engine.camera.target = [0, 0, 0];
windFigure.engine.camera.up = [0, 0, -1];
const wind = await floats(new URL('./assets/sciviz/wind.bin', import.meta.url)),
  nx = 49,
  ny = 19,
  count = nx * ny;
export const windTable = {
  points: Float32Array.from({ length: 3 * count }, (_, i) =>
    i % 3 === 0
      ? -100 + (Math.floor(i / 3) % nx) * 2.5
      : i % 3 === 1
        ? 20 + Math.floor(Math.floor(i / 3) / nx) * 2.5
        : 0,
  ),
  pointArrays: {
    velocity: Float32Array.from({ length: 3 * count }, (_, i) =>
      i % 3 === 0 ? wind[Math.floor(i / 3)] : i % 3 === 1 ? wind[count + Math.floor(i / 3)] : 0,
    ),
  },
};
const response = await fetch(new URL('./assets/sciviz/glyph/displacement.e', import.meta.url));
if (!response.ok) throw new Error(`SEACAS HTTP ${response.status}`);
export const exodusGrid = await readDisplacement(new Uint8Array(await response.arrayBuffer()));
export let windLayer: GlyphLayer,
  displacementLayer: GlyphLayer,
  surface: MeshLayer,
  warped = exodusGrid;
export async function show(shape: GlyphShape = 'arrow', factor = 20, mode = 'vector') {
  if (windLayer) windFigure.remove(windLayer);
  if (displacementLayer) warpFigure.remove(displacementLayer);
  if (surface) warpFigure.remove(surface);
  windLayer = await glyphLayer(windFigure, windTable, {
    shape,
    vectors: 'velocity',
    scaleMode: 'magnitude',
    scaleFactor: 0.15,
    stride: 3,
  });
  warped =
    mode === 'scalar'
      ? await warpByScalar(exodusGrid, '', { scaleFactor: factor })
      : await warpByVector(exodusGrid, 'displacement', { scaleFactor: factor });
  surface = gridLayer(warpFigure, warped, { colormap: 'viridis', range: [0, 0.025] });
  displacementLayer = await glyphLayer(warpFigure, warped, {
    shape: 'arrow',
    vectors: 'displacement',
    scaleMode: 'magnitude',
    scaleFactor: 8,
    stride: 20,
    material: { color: '#e7b76b' },
  });
  await Promise.all([windFigure.ready(), warpFigure.ready()]);
  windFigure.engine.render();
  warpFigure.engine.render();
  element('status').textContent =
    `Ready. ${windLayer.instances.ids.length} wind instances in ${windFigure.engine.stats.drawCalls} draw; ${exodusGrid.types.length} warped SEACAS cells.`;
}
let pending = Promise.resolve();
for (const id of ['shape', 'scale', 'warp'])
  element(id).addEventListener('change', () => {
    pending = pending
      .then(() =>
        show(
          element<HTMLSelectElement>('shape').value as GlyphShape,
          Number(element<HTMLInputElement>('scale').value),
          element<HTMLSelectElement>('warp').value,
        ),
      )
      .catch(fail);
  });
window.addEventListener(
  'pagehide',
  () => {
    windFigure.dispose();
    warpFigure.dispose();
  },
  { once: true },
);
await show();
