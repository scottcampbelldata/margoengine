import { Figure } from '@margoengine/sciviz';
import {
  AWS_TERRARIUM,
  decodeTerrarium,
  geoLodLayer,
  type GeoTile,
  type GeoTileElevation,
} from '@margoengine/sciviz/geo-lod';
import type { Projection } from '@margoengine/sciviz/geo';

const canvas = document.querySelector<HTMLCanvasElement>('#map')!;
const status = document.querySelector<HTMLElement>('#status')!;
const projection = document.querySelector<HTMLSelectElement>('#projection')!;
const live = document.querySelector<HTMLInputElement>('#live')!;
const credit = await fetch('/examples/assets/sciviz/geo-lod/attribution.txt').then((r) => r.text());
document.querySelector('#credit')!.textContent = credit;
let figure: Figure | undefined, interval: ReturnType<typeof setInterval> | undefined;
export let layer: ReturnType<typeof geoLodLayer>;
export function currentFigure(): Figure {
  return figure!;
}

async function start(): Promise<void> {
  if (interval) clearInterval(interval);
  figure?.dispose();
  figure = await Figure.create(canvas, {
    axes: false,
    controls: true,
    limits: [-1, 1, -1, 1, -1, 1],
    aspect: [1, 1, 1],
  });
  figure.engine.camera.position = [2.6, 1.1, 2.6];
  const levels = live.checked ? 15 : 2;
  const load = async (t: GeoTile, signal?: AbortSignal): Promise<ImageData> => {
    const url = live.checked
      ? AWS_TERRARIUM.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y))
      : `/examples/assets/sciviz/geo-lod/${t.z}-${t.x}-${t.y}.png`;
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`${r.status}: ${url}`);
    const bitmap = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(bitmap.width, bitmap.height),
      g = c.getContext('2d')!;
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    return g.getImageData(0, 0, c.width, c.height);
  };
  // Share in-flight imagery/elevation decode for each tile; delete as soon as both consumers have obtained it.
  const pending = new Map<string, { promise: Promise<ImageData>; users: number }>();
  const pixels = async (t: GeoTile, signal?: AbortSignal): Promise<ImageData> => {
    const key = `${t.z}/${t.x}/${t.y}`;
    let p = pending.get(key);
    if (!p) {
      p = { promise: load(t, signal), users: 0 };
      pending.set(key, p);
    }
    p.users++;
    if (p.users === 2) pending.delete(key);
    return p.promise;
  };
  layer = geoLodLayer(figure, {
    projection: projection.value as Projection,
    maxZoom: levels,
    tileBudget: 40,
    cacheTiles: 80,
    tiles: async (z, x, y, signal) => {
      const data = await pixels({ z, x, y }, signal),
        elevation = decodeTerrarium(data),
        out = new Uint8ClampedArray(data.data.length);
      for (let i = 0; i < elevation.heights.length; i++) {
        const h = elevation.heights[i],
          land = Math.min(1, Math.max(0, h / 4000));
        out.set(
          h < 0
            ? [17, 63 + Math.min(30, -h / 200), 100, 255]
            : [45 + land * 210, 100 + land * 150, 55 + land * 195, 255],
          i * 4,
        );
      }
      return new ImageData(out, data.width, data.height);
    },
    elevation: async (t, signal): Promise<GeoTileElevation> => decodeTerrarium(await pixels(t, signal)),
    attribution: 'Mapzen terrain tiles / USGS / NOAA; full data credits below',
  });
  interval = setInterval(() => {
    status.textContent = layer.error
      ? `Tile error: ${String(layer.error)}`
      : `Ready. ${layer.selected.length} selected, ${layer.stats.resident} cached, ${layer.stats.pending} requests, ${layer.stats.drawn} draws.`;
  }, 200);
}
projection.addEventListener('change', () => void start());
live.addEventListener('change', () => void start());
await start();
