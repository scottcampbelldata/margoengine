import { Figure } from '@margoengine/sciviz';
import { lic, type LicLayer } from '@margoengine/sciviz/lic';
import { element, exportButton, fail, floats } from './sciviz-demo.js';

const nx = 49, ny = 19, size = nx * ny;
const km = Math.PI * 6371 / 180, cosine = Math.cos(42.5 * Math.PI / 180);
const bounds: [number, number, number, number, number, number] = [-60 * km * cosine, 60 * km * cosine, -22.5 * km, 22.5 * km, 0, 0];
export const figure = await Figure.create(element<HTMLCanvasElement>('viewport'), {
  limits: bounds, aspect: [1.5, 1, 0.05], titles: { x: 'East of 40 W (km)', y: 'North of 42.5 N (km)', z: 'km' },
});
export let layer: LicLayer;
export let work: Promise<void> = Promise.resolve();
let alive = true, playing = false;
const lifetime = new AbortController(), play = element<HTMLButtonElement>('play');
const phase = element<HTMLInputElement>('phase'), animate = element<HTMLInputElement>('animate');
const stop = () => { playing = false; play.textContent = 'Play'; };
window.addEventListener('pagehide', () => { alive = false; stop(); lifetime.abort(); figure.dispose(); }, { once: true });
try {
  const data = await floats(new URL('./assets/sciviz/wind.bin', import.meta.url));
  const update = async () => {
    if (!alive) return;
    const day = Number(element<HTMLSelectElement>('day').value);
    const east = data.subarray(day * 2 * size, (day * 2 + 1) * size), north = data.subarray((day * 2 + 1) * size, (day * 2 + 2) * size);
    const u = Float32Array.from(east, (v, i) => v * cosine / Math.cos((20 + Math.floor(i / nx) * 2.5) * Math.PI / 180));
    const scalar = Float32Array.from(east, (v, i) => Math.hypot(v, north[i]));
    const next = await lic(figure, { dims: [nx, ny, 1], bounds, u, v: north }, {
      scalar, range: [0, 35], resolution: [256, 128], seed: 171, steps: 24,
      coloured: element<HTMLInputElement>('colour').checked, animated: animate.checked, phase: Number(phase.value),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(120000)]),
    });
    if (layer) figure.replace(layer, next);
    layer = next; await figure.ready();
    phase.disabled = play.disabled = !animate.checked;
    element('status').textContent = `January ${day + 1}, 2024. ${animate.checked ? 'Direction animation; phase is not physical time.' : 'Static LIC; texture shows tangents, colour shows speed.'} Drag to orbit; scroll to zoom.`;
  };
  await update();
  for (const id of ['day', 'colour', 'animate']) element(id).addEventListener('change', () => {
    stop(); work = work.then(update); void work.catch(fail);
  });
  phase.addEventListener('input', () => { stop(); layer.setPhase(Number(phase.value)); });
  const tick = (time: number) => {
    if (!playing || !alive) return;
    const p = (time / 1000) % (2 * Math.PI); phase.value = String(p); layer.setPhase(p);
    requestAnimationFrame(tick);
  };
  play.addEventListener('click', () => { if (playing) stop(); else { playing = true; play.textContent = 'Pause'; requestAnimationFrame(tick); } });
  exportButton(figure, 'north-atlantic-wind-texture');
  element('viewport').dataset.ready = 'true';
} catch (error) { fail(error); }
