// Million-point demo: samples a five-cluster Gaussian mixture on the GPU (@margoengine/compute/random, seeded), colours
// each point by its distance from its cluster centre, and plots it with sciviz's scatter layer (@margoengine/points
// with a point budget). Changing the count or the budget rebuilds the figure.
import { createCompute } from '@margoengine/compute';
import { Random } from '@margoengine/compute/random';
import { Figure } from '@margoengine/sciviz';

declare global {
  interface Window {
    pointsDemo?: { count: number };
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('viewport'),
  status = $<HTMLParagraphElement>('status');
// Cluster centres and spreads in data units.
const CLUSTERS = [
  [0, 0, 0, 1.0],
  [4, 1, 2, 0.6],
  [-3, 3, 1, 0.8],
  [1, -4, 3, 0.5],
  [-2, -2, -2, 0.7],
];

let figure: Figure | undefined;
async function build(): Promise<void> {
  figure?.dispose();
  const count = Number($<HTMLSelectElement>('count').value),
    budget = Number($<HTMLSelectElement>('budget').value);
  status.textContent = `Sampling ${count.toLocaleString('en')} points on the GPU…`;
  const fig = (figure = await Figure.create(canvas, { pointBudget: budget, titles: { x: 'x', y: 'y', z: 'z' } }));
  const gpu = await createCompute({ engine: fig.engine });
  const rng = new Random(gpu, { seed: 2026 });
  // Each point picks a cluster, then a normal offset scaled by that cluster's spread.
  const pick = rng.integers(0, CLUSTERS.length, count);
  const table = (k: number) => gpu.array(CLUSTERS.map((c) => c[k]));
  const [cx, cy, cz, spread] = [0, 1, 2, 3].map((k) => gpu.take(table(k), pick));
  const dx = rng.normal(count).mul(spread),
    dy = rng.normal(count).mul(spread),
    dz = rng.normal(count).mul(spread).mul(0.6);
  const x = cx.add(dx).eval(),
    y = cy.add(dy).eval(),
    z = cz.add(dz).eval(),
    distance = dx.hypot(dy).hypot(dz).div(spread).eval();
  const t0 = performance.now();
  await fig.scatter(
    { x, y, z, color: distance },
    { colormap: 'aurora', range: [0, 3], edl: $<HTMLInputElement>('edl').checked },
  );
  fig.colorbar('aurora', [0, 3], { label: 'σ from centre' });
  gpu.dispose();
  window.pointsDemo = { count };
  const summary = `${count.toLocaleString('en')} points (sampled on the GPU, plotted in ${(performance.now() - t0).toFixed(0)} ms), up to ${budget.toLocaleString('en')} drawn per frame.`;
  status.textContent = summary;
  // Box or lasso drags select points; the status line counts them.
  fig.dragMode = $<HTMLSelectElement>('drag').value as 'orbit' | 'box' | 'lasso';
  fig.addEventListener('selection', (event) => {
    const selected = event.detail.points.reduce((sum, p) => sum + p.indices.length, 0);
    status.textContent = `${summary} Selected ${selected.toLocaleString('en')}.`;
  });
  await fig.ready();
  canvas.dataset.ready = 'true';
}

for (const id of ['count', 'budget', 'edl']) $(id).addEventListener('change', () => void build().catch(fail));
$('drag').addEventListener('change', () => {
  if (figure) figure.dragMode = $<HTMLSelectElement>('drag').value as 'orbit' | 'box' | 'lasso';
});
const fail = (error: Error) => (status.textContent = `Could not start: ${error.message}`);
window.addEventListener('pagehide', () => figure?.dispose(), { once: true });
build().catch(fail);
