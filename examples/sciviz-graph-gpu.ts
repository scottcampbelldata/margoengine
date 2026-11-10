import { Figure } from '@margoengine/sciviz';
import { createCompute } from '@margoengine/compute';
import {
  GPUGraphLayout,
  gpuGraphLayer,
  bundleGraphEdges,
  type GPUGraphLayer,
  type GraphBundles,
  type GraphForceModel,
} from '@margoengine/sciviz/graph-gpu';
const canvas = document.querySelector<HTMLCanvasElement>('#plot')!,
  status = document.querySelector<HTMLElement>('#status')!;
export const works: { id: string; title: string; year: number; references: string[] }[] = await (
  await fetch('/packages/sciviz/tests/fixtures/graph-gpu/openalex.json')
).json();
const ids = new Map(works.map((w, i) => [w.id, i])),
  edges: number[] = [];
for (let i = 0; i < works.length; i++)
  for (const ref of works[i].references) if (ids.has(ref)) edges.push(i, ids.get(ref)!);
export const graph = { nodes: works.length, edges: Uint32Array.from(edges) };
export const figure = await Figure.create(canvas, {
  mode: '2d',
  theme: 'light',
  axes: false,
  limits: [-25, 25, -25, 25],
});
export const gpu = await createCompute({ engine: figure.engine });
export let layout: GPUGraphLayout, layer: GPUGraphLayer, bundles: GraphBundles | undefined;
const labels = works.map((w, node) => ({
  node,
  text: w.title.length > 44 ? w.title.slice(0, 42) + '...' : w.title,
  priority: works.reduce((n, other) => n + Number(other.references.includes(w.id)), 0),
}));
function draw(): void {
  layer?.dispose();
  layer = gpuGraphLayer(figure, layout, {
    bounds: [-25, 25, -25, 25, -1, 1],
    labels,
    maxLabels: 20,
    nodeSize: 7,
    edgeWidth: Array.from({ length: edges.length / 2 }, (_, i) => 1 + (i % 3) * 0.5),
    edgeColor: Array.from({ length: edges.length / 2 }, (_, i) => (i % 2 ? '#467ca6' : '#9c658b')),
    bundles,
  });
}
export async function advance(iterations = 20): Promise<void> {
  bundles?.dispose();
  bundles = undefined;
  draw();
  for await (const work of layout.run({ iterations }))
    status.textContent = `${graph.nodes} nodes, ${edges.length / 2} citations. ${work.iterations} GPU iterations.`;
  await layer.refreshLabels();
  figure.render();
  status.dataset.ready = 'true';
}
export async function reset(model: GraphForceModel = 'forceatlas2'): Promise<void> {
  layer?.dispose();
  bundles?.dispose();
  layout?.dispose();
  bundles = undefined;
  layout = new GPUGraphLayout(gpu, graph, { model, gridSide: 16, gravity: 0.1, seed: 175 });
  await advance(5);
}
export async function bundle(): Promise<void> {
  layer.dispose();
  bundles?.dispose();
  bundles = await bundleGraphEdges(gpu, graph, layout.positions, { cycles: 4, iterations: 15, step: 0.04 });
  draw();
  await layer.refreshLabels();
  figure.render();
}
let pending = false;
const action = (run: () => Promise<void>) => async () => {
  if (pending) return;
  pending = true;
  try {
    await run();
  } catch (error) {
    status.textContent = String(error);
    throw error;
  } finally {
    pending = false;
  }
};
document.querySelector('#advance')!.addEventListener(
  'click',
  action(() => advance()),
);
document.querySelector('#bundle')!.addEventListener('click', action(bundle));
document.querySelector<HTMLSelectElement>('#model')!.addEventListener(
  'change',
  action(() => reset(document.querySelector<HTMLSelectElement>('#model')!.value as GraphForceModel)),
);
await reset();
