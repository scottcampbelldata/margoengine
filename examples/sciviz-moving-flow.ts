import { Figure, type LineLayer } from '@margoengine/sciviz/spec';
import { flowParticles, tracePathline, traceStreakline, type FlowGrid, type FlowParticles, type FlowSeeding } from '@margoengine/sciviz/flow';
import { element, exportButton, fail, floats, signal } from './sciviz-demo.js';

const nx = 49, ny = 19, size = nx * ny, day = 86400;
const km = Math.PI * 6371 / 180, cosine = Math.cos(42.5 * Math.PI / 180);
const bounds: FlowGrid['bounds'] = [-60 * km * cosine, 60 * km * cosine, -22.5 * km, 22.5 * km, 0, 0];
export const figure = await Figure.create(element<HTMLCanvasElement>('viewport'), {
  limits: [...bounds], aspect: [1.5, 1, 0.05], titles: { x: 'East of 40 W (km)', y: 'North of 42.5 N (km)', z: 'km' },
});
export let particles: FlowParticles;
let path: LineLayer | undefined, streak: LineLayer | undefined;
let playing = false, busy = false, alive = true;
const lifetime = new AbortController();
const play = element<HTMLButtonElement>('play');
const stop = () => { playing = false; play.textContent = 'Play'; };
window.addEventListener('pagehide', () => { alive = false; stop(); lifetime.abort(); figure.dispose(); }, { once: true });
const date = () => {
  element('date').textContent = new Date(Date.UTC(2024, 0, 1) + particles.time * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
};
try {
  const data = await floats(new URL('./assets/sciviz/wind.bin', import.meta.url));
  const frames = Array.from({ length: 8 }, (_, frame) => ({
    time: frame * day,
    u: Float32Array.from(data.subarray(frame * 2 * size, (frame * 2 + 1) * size),
      (v, i) => (v / 1000) * cosine / Math.cos((20 + Math.floor(i / nx) * 2.5) * Math.PI / 180)),
    v: Float32Array.from(data.subarray((frame * 2 + 1) * size, (frame * 2 + 2) * size), (v) => v / 1000),
  }));
  const grid: FlowGrid = { dims: [nx, ny, 1], bounds, frames };
  const layouts: Record<string, FlowSeeding> = {
    uniform: { kind: 'uniform' }, random: { kind: 'random', seed: 171 },
    rake: { kind: 'rake', start: [0, bounds[2], 0], end: [0, bounds[3], 0] },
    region: { kind: 'region', bounds: [-800, 800, -800, 800, 0, 0] },
  };
  const make = () => flowParticles(figure, grid, { count: 4096, trails: 32, lifetime: 2 * day,
    width: 1.8, seeding: layouts[element<HTMLSelectElement>('seeding').value],
    signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(120000)]) });
  particles = await make();
  await particles.advance(day / 4, { step: 600, signal });
  const pathline = await tracePathline(grid, [0, 0, 0], { from: 0, to: 2 * day, step: 600, signal });
  const streakline = await traceStreakline(grid, [0, 0, 0], Array.from({ length: 17 }, (_, i) => i * day / 8), { to: 2 * day, step: 600, signal });
  const coordinates = (samples: Float64Array) => ({
    x: samples.filter((_, i) => i % 4 === 0), y: samples.filter((_, i) => i % 4 === 1), z: samples.filter((_, i) => i % 4 === 2),
  });
  path = await figure.line(coordinates(pathline.samples), { color: '#ffd27d', width: 3, name: 'Pathline, Jan 1-3' });
  streak = await figure.line(coordinates(streakline.samples), { color: '#ff96c5', width: 3, name: 'Streakline, Jan 3' });
  await figure.ready();
  const controls = [...document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('#next,#reset,#seeding')];
  const operation = async (action: () => Promise<void>) => {
    if (busy || !alive) return;
    busy = true;
    controls.forEach((control) => { control.disabled = true; });
    try { await action(); if (alive) date(); }
    finally { busy = false; controls.forEach((control) => { control.disabled = false; }); }
  };
  const advance = () => operation(async () => {
    await particles.advance(Math.min(7 * day, particles.time + day / 4), { step: 600, signal: lifetime.signal });
    if (particles.time === 7 * day) stop();
  });
  const reset = () => operation(async () => {
    const next = await make();
    try { await next.advance(day / 4, { step: 600, signal: lifetime.signal }); }
    catch (error) { figure.remove(next); throw error; }
    figure.remove(particles); particles = next;
  });
  const tick = async () => {
    if (!playing || !alive) return;
    try { await advance(); }
    catch (error) { stop(); fail(error); return; }
    if (playing && alive) requestAnimationFrame(() => { void tick(); });
  };
  play.addEventListener('click', () => {
    if (playing) stop();
    else if (!busy && particles.time < 7 * day) { playing = true; play.textContent = 'Pause'; void tick(); }
  });
  element('next').addEventListener('click', () => { stop(); void advance().catch(fail); });
  for (const id of ['reset', 'seeding']) element(id).addEventListener(id === 'reset' ? 'click' : 'change', () => { stop(); void reset().catch(fail); });
  element('traces').addEventListener('change', () => { path!.line.visible = streak!.line.visible = element<HTMLInputElement>('traces').checked; });
  exportButton(figure, 'moving-north-atlantic-wind');
  date();
  element('status').textContent = 'GPU particles through daily means. Drag to orbit; scroll to zoom. Gold pathline and pink streakline are fixed Jan 3 references.';
  element('viewport').dataset.ready = 'true';
} catch (error) { fail(error); }
