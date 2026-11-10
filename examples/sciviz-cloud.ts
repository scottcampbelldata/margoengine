import { Figure } from '@margoengine/sciviz';
import { brickedVolume, type BrickRequest, type BrickedVolumeLayer } from '@margoengine/sciviz/bricks';
import { openOMEZarr, openN5, openPrecomputed, type CloudRange } from '@margoengine/sciviz/omezarr';

const canvas = document.querySelector('canvas')!;
export const figure = await Figure.create(canvas, { axes: true, controls: false });
let layer: BrickedVolumeLayer | undefined;
const readers = { 'idr-lightsheet': openOMEZarr, openorganelle: openN5, hemibrain: openPrecomputed };
type Sample = keyof typeof readers;

/** Draws an original compressed cloud sample through its bricked source, retaining bounded chunk reads. */
export async function showCloud(name: Sample): Promise<void> {
  canvas.dataset.ready = '';
  if (layer) figure.remove(layer);
  const base = `/packages/sciviz/tests/fixtures/cloud-volumes/${name}/`;
  const manifest = await fetch(`${base}manifest.json`).then((r) => r.json());
  const store = {
    async get(key: string, _signal?: AbortSignal, range?: CloudRange) {
      const record = manifest.requests.find(
        (r: { key: string; range?: CloudRange }) =>
          r.key === key && r.range?.offset === range?.offset && r.range?.length === range?.length,
      );
      if (!record) throw new RangeError(`This recorded region does not include ${key}; choose a recorded brick`);
      if (!record.file) return undefined;
      const response = await fetch(base + record.file, { signal: _signal });
      return new Uint8Array(await response.arrayBuffer());
    },
  };
  const volume = await readers[name](store);
  const selected = volume.levels[manifest.selected];
  const size = manifest.size as [number, number, number],
    origin = manifest.origin as [number, number, number];
  const source = {
    dims: size,
    range: manifest.sampleRange,
    async read(request: BrickRequest) {
      const factor = 2 ** request.level;
      const from = request.origin.map((n, d) => origin[d] + n * factor) as [number, number, number];
      const extent = request.size.map((n, d) =>
        Math.min((n - 1) * factor + 1, size[d] - request.origin[d] * factor),
      ) as [number, number, number];
      const values = await selected.source.read({ ...request, level: 0, origin: from, size: extent });
      const out = new Float32Array(request.size[0] * request.size[1] * request.size[2]);
      for (let z = 0, w = 0; z < request.size[2]; z++)
        for (let y = 0; y < request.size[1]; y++)
          for (let x = 0; x < request.size[0]; x++, w++)
            out[w] = values[x * factor + extent[0] * (y * factor + extent[1] * z * factor)];
      return out;
    },
  };
  layer = brickedVolume(figure, source, {
    brickSize: 16,
    memoryBudget: 16 * 1024 * 1024,
    range: manifest.sampleRange,
    colormap: 'viridis',
  });
  await layer.ready({ signal: AbortSignal.timeout(30000) });
  document.querySelector('#status')!.textContent =
    `${volume.format}: stored resolution ${selected.path}; ${size.join(' x ')} region at voxel ${origin.join(', ')}. ${layer.stats.resident} resident bricks, ${layer.stats.memoryBytes.toLocaleString()} GPU bytes.`;
  document.querySelector('#caption')!.textContent = volume.caption;
  const credit = document.querySelector('#credit')!;
  credit.replaceChildren(document.createTextNode(`${manifest.attribution}. ${manifest.license}. `));
  const link = document.createElement('a');
  link.href = manifest.base;
  link.textContent = 'Original cloud source';
  credit.append(link);
  canvas.dataset.ready = name;
}
document.querySelector('select')!.addEventListener('change', (event) => {
  void showCloud((event.target as HTMLSelectElement).value as Sample);
});
await showCloud('idr-lightsheet');
