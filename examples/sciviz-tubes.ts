import { Figure } from '@margoengine/sciviz/spec';
import { streamline, sampleField } from '@margoengine/sciviz/maths';
import { meshLayer, type MeshLayer } from '@margoengine/sciviz/grids';
import { streamTubeGeometry, streamRibbonGeometry, streamMeshTriangles } from '@margoengine/sciviz/tubes';
import { element, exportButton, fail, floats } from './sciviz-demo.js';

const nx = 49, ny = 19, size = nx * ny, km = Math.PI * 6371 / 180, cosine = Math.cos(42.5 * Math.PI / 180);
const bounds: [number, number, number, number, number, number] =
  [-60 * km * cosine, 60 * km * cosine, -22.5 * km, 22.5 * km, 0, 0];
export const figure = await Figure.create(element<HTMLCanvasElement>('viewport'), {
  limits: [bounds[0], bounds[1], bounds[2], bounds[3], -200, 200], aspect: [1.5, 1, 0.15],
  titles: { x: 'East of 40 W (km)', y: 'North of 42.5 N (km)', z: 'km' },
});
export let work: Promise<void> = Promise.resolve();
export let layers: MeshLayer[] = [];
const lifetime = new AbortController();
window.addEventListener('pagehide', () => { lifetime.abort(); figure.dispose(); }, { once: true });
try {
  const data = await floats(new URL('./assets/sciviz/wind.bin', import.meta.url));
  const update = async () => {
    lifetime.signal.throwIfAborted();
    const day = Number(element<HTMLSelectElement>('day').value),
      mode = element<HTMLSelectElement>('shape').value,
      scale = Number(element<HTMLInputElement>('scale').value),
      east = data.subarray(day * 2 * size, (day * 2 + 1) * size),
      north = data.subarray((day * 2 + 1) * size, (day * 2 + 2) * size),
      projected = Float32Array.from(east, (v, i) => v * cosine /
        Math.cos((20 + Math.floor(i / nx) * 2.5) * Math.PI / 180)),
      grid = { u: projected, v: north, dims: [nx, ny, 1] as const, bounds }, next: MeshLayer[] = [];
    try {
      for (let seed = 0; seed < 12; seed++) {
        const line = streamline(grid, [-3500 + (seed % 4) * 2100, -1500 + Math.floor(seed / 4) * 1400, 0],
          { step: 50, maxSteps: 180 });
        if (line.positions.length < 6) continue;
        const speed = Float64Array.from(line.speeds, (_, i) => {
          const vector = sampleField({ ...grid, u: east }, line.positions[i * 3], line.positions[i * 3 + 1], 0)!;
          return Math.hypot(...vector);
        }), radius = Float64Array.from(speed, (v) => scale * (8 + 1.8 * v)),
          path = { positions: line.positions, scalar: speed },
          options = { steps: Math.min(1024, Math.max(64, line.speeds.length - 1)), signal: lifetime.signal };
        const geometry = mode === 'tube' ? streamTubeGeometry(path, { ...options, radius, sides: 12 })
          : streamRibbonGeometry(path, { ...options, width: Float64Array.from(radius, (v) => 4 * v) });
        next.push(meshLayer(figure, streamMeshTriangles(geometry), { range: [0, 35] }));
      }
    } catch (error) {
      for (const layer of next) figure.remove(layer);
      throw error;
    }
    for (const layer of layers) figure.remove(layer);
    layers = next;
    await figure.ready();
    element('status').textContent = `January ${day + 1}, 2024: ${layers.length} ${mode === 'tube' ? 'tubes' : 'ribbons'}. Colour and width encode speed. These horizontal winds have zero streamwise curl, so ribbons have no physical spin.`;
  };
  await update();
  for (const id of ['day', 'shape', 'scale']) element(id).addEventListener('change', () => {
    work = work.then(update); void work.catch(fail);
  });
  exportButton(figure, 'north-atlantic-wind-paths');
  element('viewport').dataset.ready = 'true';
} catch (error) { fail(error); }
