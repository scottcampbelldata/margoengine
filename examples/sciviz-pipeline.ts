import { Figure, type LineLayer } from '@margoengine/sciviz';
import { FilterPipeline, type PipelineRegistry } from '@margoengine/sciviz/pipeline';
import { element, fail } from './sciviz-demo.js';

type Samples = readonly (readonly [number, number])[];
export const counts = { source: 0, subset: 0, chart: 0 };
export const figure = await Figure.create(element<HTMLCanvasElement>('viewport'), {
  mode: '2d',
  limits: [0, 2, 0.002, 0.008],
  titles: { x: 'x / plate reference length', y: 'Skin friction coefficient' },
});
const registry: PipelineRegistry = {
  'nasa.fun3d': {
    kind: 'source',
    async execute({ signal }) {
      counts.source++;
      const response = await fetch(new URL('./assets/sciviz/pipeline/cf-plate.dat', import.meta.url), { signal });
      if (!response.ok) throw new TypeError(`NASA data HTTP ${response.status}; serve the downloaded example asset`);
      const rows: [number, number][] = [];
      let selected = false;
      for (const line of (await response.text()).split(/\r?\n/)) {
        if (/^zone/i.test(line)) {
          selected = /FUN3D/.test(line);
          continue;
        }
        if (selected && line.trim()) {
          const values = line.trim().split(/\s+/).map(Number);
          rows.push([values[0], values[1]]);
        }
      }
      signal.throwIfAborted();
      return rows;
    },
  },
  'samples.minimum': {
    kind: 'filter',
    execute({ inputs, params }) {
      counts.subset++;
      return (inputs[0] as Samples).filter((row) => row[0] >= Number(params));
    },
  },
  'figure.line': {
    kind: 'layer',
    async execute({ inputs, signal }) {
      counts.chart++;
      signal.throwIfAborted();
      const rows = inputs[0] as Samples;
      return await figure.line(
        { x: rows.map((row) => row[0]), y: rows.map((row) => row[1]) },
        { color: '#65d9ff', name: 'FUN3D' },
      );
    },
    release(output) {
      figure.remove(output as LineLayer);
    },
  },
};
export const pipeline = new FilterPipeline(registry)
  .add({ id: 'solution', type: 'nasa.fun3d' })
  .add({ id: 'minimum', type: 'samples.minimum', inputs: ['solution'], params: 0 })
  .add({ id: 'chart', type: 'figure.line', inputs: ['minimum'] });

export async function show(minimum: number): Promise<void> {
  pipeline.setParams('minimum', minimum);
  await pipeline.run('chart', { signal: AbortSignal.timeout(30000) });
  await figure.ready();
  element('status').textContent =
    `Minimum x ${minimum.toFixed(2)}. Executions: source ${counts.source}, subset ${counts.subset}, chart ${counts.chart}.`;
}
element<HTMLInputElement>('minimum').addEventListener('change', (event) => {
  show(Number((event.target as HTMLInputElement).value)).catch(fail);
});
element('save').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(pipeline, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'nasa-pipeline.json';
  link.click();
  URL.revokeObjectURL(url);
});
window.addEventListener(
  'pagehide',
  () => {
    pipeline.dispose();
    figure.dispose();
  },
  { once: true },
);
await show(0);
