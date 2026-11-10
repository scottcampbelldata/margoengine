import { Figure } from '@margoengine/sciviz';
import { pointcloud, type PointCloudColour, type PointCloudPick } from '@margoengine/sciviz/pointcloud';
import { SelectionStore } from '@margoengine/sciviz/link';
import { parseLAS } from '@margoengine/points/las';
import type { OctreeNode, OctreeSource } from '@margoengine/points/octree';

const canvas = document.querySelector('canvas')!;
const base = '/examples/assets/sciviz/pointcloud/';
const manifest = await fetch(`${base}manifest.json`).then((r) => r.json());
const box: number[] = manifest.metadata.bounds;
const origin: [number, number, number] = [0, 1, 2].map((a) => (box[a] + box[a + 3]) / 2) as [number, number, number];
const keys = new Map<OctreeNode, string>();
const nodes = new Map<string, OctreeNode>();
for (const record of manifest.nodes) {
  const [d, x, y, z] = record.key.split('-').map(Number),
    side = (box[3] - box[0]) / 2 ** d;
  const bounds = new Float64Array(6);
  for (let a = 0; a < 3; a++) {
    bounds[a] = box[a] - origin[a] + [x, y, z][a] * side;
    bounds[a + 3] = bounds[a] + side;
  }
  const parent = d ? nodes.get('0-0-0-0')! : null;
  const octant = x | (y << 1) | (z << 2);
  const node: OctreeNode = {
    id: parent ? parent.id + octant : 'r',
    level: d,
    bounds,
    count: record.count,
    spacing: side / manifest.metadata.span,
    parent,
    children: new Array(8).fill(null),
  };
  if (parent) (parent.children as (OctreeNode | null)[])[octant] = node;
  nodes.set(record.key, node);
  keys.set(node, record.key);
}
export let reads = 0;
const source: OctreeSource = {
  root: nodes.get('0-0-0-0')!,
  async load(node, signal) {
    reads++;
    const response = await fetch(`${base}${keys.get(node)}.laz`, { signal });
    if (!response.ok) throw new Error(`Tile HTTP ${response.status}`);
    const data = await parseLAS(new Uint8Array(await response.arrayBuffer()), { origin, signal });
    return {
      positions: data.positions,
      attributes: {
        intensity: data.intensity,
        classification: data.classification,
        return_number: data.returnNumber,
        gps_time: data.gpsTime!,
      },
    };
  },
};
export const selection = new SelectionStore([], { universe: 'open' });
export const figure = await Figure.create(canvas, {
  axes: true,
  controls: true,
  dragMode: 'box',
  titles: { x: 'Easting (m)', y: 'Northing (m)', z: 'Elevation (m)' },
});
export const layer = await pointcloud(figure, source, {
  origin,
  name: 'USGS Iowa',
  selection,
  pointBudget: 220_000,
  maxLoadedPoints: 220_000,
  minNodePixels: 1,
  attribute: 'elevation',
  range: [-100, 600],
});
const colours: Record<string, PointCloudColour> = {
  elevation: { attribute: 'elevation', range: [-100, 600] },
  intensity: { attribute: 'intensity', range: [0, 65535], colormap: 'gray' },
  classification: { attribute: 'classification', range: [0, 18], colormap: 'viridis' },
};
function status() {
  document.querySelector('#status')!.textContent =
    `${layer.stats.drawn.toLocaleString()} points visible; ${layer.stats.loaded.toLocaleString()} resident; ${reads} tile reads; ${layer.stats.attributeBytes.toLocaleString()} attribute bytes; ${selection.rowIds.length.toLocaleString()} selected.`;
}
document.querySelector('#caption')!.textContent = layer.caption;
layer.addEventListener('pick', (event) => {
  const hit = (event as CustomEvent<PointCloudPick | null>).detail;
  document.querySelector('#pick')!.textContent = hit
    ? `Point ${hit.rowId}: ${hit.position.map((v) => v.toFixed(2)).join(', ')}; ${JSON.stringify(hit.attributes)}`
    : 'Hover to inspect original point attributes.';
});
document.querySelector('#attribute')!.addEventListener('change', (event) => {
  layer.setColour(colours[(event.target as HTMLSelectElement).value]);
});
document.querySelector('#budget')!.addEventListener('change', async (event) => {
  layer.setPointBudget(Number((event.target as HTMLSelectElement).value));
  await layer.ready({ signal: AbortSignal.timeout(30000) });
  status();
});
document.querySelector('#select')!.addEventListener('click', () => {
  const r = canvas.getBoundingClientRect();
  layer.select({ rect: [0, 0, r.width / 2, r.height] });
});
document.querySelector('#clear')!.addEventListener('click', () => selection.clear());
selection.subscribe(status);
await layer.ready({ signal: AbortSignal.timeout(30000) });
await figure.ready();
status();
canvas.dataset.ready = 'true';
