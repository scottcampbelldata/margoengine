import { Figure } from '@margoengine/sciviz';
import { openCF, cfMapLayer, cfTimeCodec, type CFGrid, type CFMapTarget } from '@margoengine/sciviz/cf';
import { climateProjection, type ClimateProjectionName } from '@margoengine/sciviz/projections';
import type { MeshLayer } from '@margoengine/sciviz/grids';
const root = '/examples/assets/sciviz/climate/',
  canvas = document.querySelector<HTMLCanvasElement>('#map')!,
  status = document.querySelector<HTMLElement>('#status')!;
let figure: Figure, layer: MeshLayer, grid: CFGrid, target: CFMapTarget, mask: CFGrid;
export const currentFigure = (): Figure => figure;
export const currentLayer = (): MeshLayer => layer;
export const currentGrid = (): CFGrid => grid;
export const currentTarget = (): CFMapTarget => target;
export async function start(): Promise<void> {
  status.textContent = 'Reading climate coordinates...';
  const dataset = document.querySelector<HTMLSelectElement>('#dataset')!.value,
    name = dataset === 'era5' ? '2m_temperature' : 'tas',
    max = dataset === 'era5' ? 7 : 11,
    stepInput = document.querySelector<HTMLInputElement>('#step')!,
    step = Math.max(0, Math.min(max, Number(stepInput.value))),
    projectionName = document.querySelector<HTMLSelectElement>('#projection')!.value as ClimateProjectionName,
    keep = document.querySelector<HTMLSelectElement>('#mask')!.value;
  stepInput.max = String(max);
  stepInput.value = String(step);
  using source = await openCF(root + dataset + '.nc');
  grid = await source.read(name, { indices: { time: step }, units: 'degC' });
  if (!mask) {
    using land = await openCF(root + 'land-fraction.nc');
    mask = await land.read('sftlf');
  }
  const time = source.file.variables.time,
    times = await time.read(),
    date = cfTimeCodec(String(time.attributes.units), {
      calendar: String(time.attributes.calendar) as 'gregorian',
    }).decode(times[step]);
  const projection = climateProjection(projectionName, {
      radius: 1,
      flattening: 0,
      latitudeOrigin: projectionName === 'polar-stereographic' ? 90 : 0,
    }),
    extent: CFMapTarget['extent'] =
      projectionName === 'mollweide'
        ? [-2 * Math.SQRT2, -Math.SQRT2, 2 * Math.SQRT2, Math.SQRT2]
        : projectionName === 'robinson'
          ? [-0.8487 * Math.PI, -1.3523, 0.8487 * Math.PI, 1.3523]
          : projectionName === 'polar-stereographic'
            ? [-2.5, -2.5, 2.5, 2.5]
            : [-3, -2, 3, 2];
  target = { projection, extent, width: 210, height: 105 };
  figure?.dispose();
  figure = await Figure.create(canvas, {
    axes: false,
    controls: true,
    limits: [extent[0], extent[2], extent[1], extent[3], -0.01, 0.01],
    aspect: [(extent[2] - extent[0]) / (extent[3] - extent[1]), 1, 1],
  });
  figure.engine.camera.position = [0, 3.8, 0.001];
  figure.engine.camera.target = [0, 0, 0];
  layer = await cfMapLayer(figure, grid, target, {
    landMask: keep === 'all' ? undefined : mask,
    keep: keep === 'ocean' ? 'ocean' : 'land',
    colormap: 'aurora',
    range: [-50, 40],
  });
  await figure.ready();
  status.textContent = `Ready. ${dataset.toUpperCase()} ${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')} ${String(date.hour).padStart(2, '0')}:00 (${date.calendar}), degrees Celsius. ${layer.triangles} triangles.`;
}
// Serialize UI requests so a slow file read cannot replace a newer selection.
let queue = Promise.resolve();
for (const id of ['dataset', 'projection', 'mask', 'step'])
  document.querySelector('#' + id)!.addEventListener('change', () => {
    queue = queue.then(start).catch((error) => {
      status.textContent = String(error);
    });
  });
await start();
