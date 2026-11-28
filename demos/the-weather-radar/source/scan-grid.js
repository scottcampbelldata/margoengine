import { Figure } from '@margoengine/sciviz';
import { curvilinearVolume } from '@margoengine/sciviz/curvilinear';
import { coordinates, extent, elevationExaggeration, palette, reflectivity } from './radar-data.js';

export async function createScanGrid(engine, grid, signal) {
  const azimuthStep = 3, gateStep = 3;
  const bearingEdges = grid.bearingCount / azimuthStep + 1;
  const rangeEdges = Math.floor((grid.gateCount - 1) / gateStep) + 1;
  const dims = [rangeEdges, bearingEdges, grid.sweeps.length];
  const nodeCount = dims.reduce((product, count) => product * count, 1);
  const points = new Float32Array(nodeCount * 3), values = new Float32Array(nodeCount);
  let node = 0;
  for (const sweep of grid.sweeps) {
    for (let row = 0; row < bearingEdges; row++) {
      const azimuth = row * azimuthStep % grid.bearingCount;
      for (let col = 0; col < rangeEdges; col++) {
        const gate = col * gateStep;
        const slant = (grid.firstMetres + gate * grid.gateStepMetres) / 1000;
        const [east,height,north] = coordinates(slant, sweep.elevations[azimuth], azimuth);
        points.set([east,north,height], node * 3);
        const value = reflectivity(grid, sweep, azimuth, gate);
        values[node] = value >= 5 ? value : NaN;
        node++;
      }
    }
  }

  const halfHeight = extent / elevationExaggeration;
  const figure = Figure.attach(engine,{axes:false,tooltips:false,legend:false,aspect:[1,1,1],
    limits:[-extent,extent,-extent,extent,-halfHeight,halfHeight]});
  try {
    signal.throwIfAborted();
    const layer = curvilinearVolume(figure, {dims,points}, values, {range:[5,70],colormap:palette,shading:false});
    layer.visible = false;
    const slice = layer.slice(2,0,{opacity:.92});
    slice.visible = false;
    await figure.ready();
    signal.throwIfAborted();
    return {
      show(visible) { slice.visible = visible; },
      select(cut) { slice.index = grid.sweeps.findIndex(sweep => sweep.cut === cut); },
      dispose() { layer.dispose(); figure.dispose(); },
    };
  } catch (reason) {
    figure.dispose();
    throw reason;
  }
}
