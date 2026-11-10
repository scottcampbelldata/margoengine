// Same hash-pinned NOAA daily winds as the other official wind examples; no synthetic velocity or height.
import { Figure, type Layer } from '@margoengine/sciviz';
import { deriveFlowGPU, type GpuDerivedFlowFields } from '@margoengine/sciviz/derive';
import { element, exportButton, fail, floats, signal } from './sciviz-demo.js';

const nx = 49, ny = 19, count = nx * ny;
const metrePerDegree = Math.PI * 6_371_000 / 180;
const halfX = 60 * metrePerDegree * Math.cos(42.5 * Math.PI / 180), halfY = 22.5 * metrePerDegree;
const bounds: [number, number, number, number, number, number] = [-halfX, halfX, -halfY, halfY, 0, 0];
export const figure = await Figure.create(element<HTMLCanvasElement>('viewport'), {
  mode: '2d', titles: { x: 'East of 40 W (m)', y: 'North of 42.5 N (m)' },
});
export let settled: Promise<void>;
let fields: GpuDerivedFlowFields | undefined, layer: Layer | undefined;
let queue = Promise.resolve();
const main = async () => {
  const values = await floats(new URL('./assets/sciviz/wind.bin', import.meta.url));
  const gpu = await figure.renderer.compute();
  async function draw() {
    const day = Number(element<HTMLSelectElement>('day').value);
    const field = element<HTMLSelectElement>('field').value as 'q' | 'lambda2' | 'vorticity' | 'divergence';
    const next = await deriveFlowGPU(gpu, { dims: [nx, ny, 1], bounds,
      u: values.subarray(2 * day * count, (2 * day + 1) * count),
      v: values.subarray((2 * day + 1) * count, (2 * day + 2) * count) }, { signal });
    try {
      const scale = field === 'q' || field === 'lambda2' ? 1e10 : 1e5;
      // A readback is intentional for the 2D heatmap's automatic min/max; 3D scalar consumers can stay on GPU.
      const data = await next[field].read({ signal });
      const plotted = Float32Array.from(data, v => v * scale);
      const replacement = await figure.heatmap(plotted, { nx, ny, x: [-halfX, halfX], y: [-halfY, halfY], colormap: 'viridis' });
      layer = layer ? figure.replace(layer, replacement) : replacement;
      fields?.dispose(); fields = next;
      await figure.ready();
      element('status').textContent = `${field === 'q' ? 'Q rotation dominance' : field === 'lambda2' ? 'Lambda-2' : field === 'vorticity' ? 'Curl magnitude' : 'Divergence'}, ${field === 'q' || field === 'lambda2' ? '10^-10 s^-2' : '10^-5 s^-1'}. NOAA daily mean, January ${day + 1}, 2024. Drag to pan; scroll to zoom.`;
      element('viewport').dataset.ready = 'true';
    } catch (error) { next.dispose(); throw error; }
  }
  const update = () => { settled = queue = queue.then(draw); void settled.catch(fail); };
  element('day').addEventListener('change', update); element('field').addEventListener('change', update);
  exportButton(figure, 'north-atlantic-wind-derivatives');
  await draw();
};
settled = main(); void settled.catch(fail);
window.addEventListener('pagehide', () => { fields?.dispose(); figure.dispose(); }, { once: true });
