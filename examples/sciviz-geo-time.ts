import { Figure } from '@margoengine/sciviz';
import { project } from '@margoengine/sciviz/geo';
import { geoVectorLayer, parseGeoVectors } from '@margoengine/sciviz/geo-vector';
import {
  geoTripsLayer,
  geoTimeRasterLayer,
  SGP4,
  parseOMM,
  satelliteTrack,
  type GeoTripsLayer,
  type GeoTimeRasterLayer,
} from '@margoengine/sciviz/geo-time';
const root = '/examples/assets/sciviz/geo-time/',
  canvas = document.querySelector<HTMLCanvasElement>('#map')!,
  status = document.querySelector<HTMLElement>('#status')!;
let figure: Figure, layer: GeoTripsLayer | GeoTimeRasterLayer;
export const currentFigure = (): Figure => figure;
export const currentLayer = (): GeoTripsLayer | GeoTimeRasterLayer => layer;
export async function start(): Promise<void> {
  figure?.dispose();
  status.textContent = 'Loading real observations...';
  const mode = document.querySelector<HTMLSelectElement>('#dataset')!.value,
    ais = mode === 'ais';
  const sw = project(-74.25, 40.52),
    ne = project(-73.7, 40.98);
  figure = await Figure.create(canvas, {
    axes: false,
    controls: true,
    limits: ais ? [sw[0], ne[0], sw[1], ne[1], -0.001, 0.001] : [-1.1, 1.1, -1.1, 1.1, -1.1, 1.1],
    aspect: [1, 1, 1],
  });
  figure.engine.camera.position = ais ? [0, 2.4, 0.001] : [5, 1, 2];
  figure.engine.camera.target = [0, 0, 0];
  if (mode === 'raster') {
    const times = [Date.parse('2024-01-01T00:00Z'), Date.parse('2024-01-02T00:00Z')];
    layer = await geoTimeRasterLayer(figure, {
      times,
      projection: 'globe',
      maxZoom: 0,
      tileBudget: 1,
      cacheTiles: 2,
      segments: 64,
      skirt: 0,
      attribution: 'NASA EOSDIS GIBS / MODIS Terra, 2024-01-01 and 2024-01-02',
      source: {
        url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{Layer}/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpg',
        layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
        matrixSet: 'GoogleMapsCompatible_Level9',
        formatTime: (t) => new Date(t).toISOString().slice(0, 10),
        fetch: async (url, init) => {
          const match = String(url).match(/\/(2024-01-0[12])\//);
          if (!match) throw new Error('Unknown retained WMTS frame');
          return fetch(`${root}terra-${match[1]}.jpg`, init);
        },
      },
    });
    await layer.timeline(times, { format: (t) => new Date(t).toISOString().slice(0, 10) }).seek(0);
  } else {
    if (!ais)
      await geoVectorLayer(
        figure,
        await parseGeoVectors(
          await fetch('/examples/assets/sciviz/geo-vector/countries.geojson').then((r) => r.text()),
        ),
        { projection: 'globe', color: [0.11, 0.28, 0.32], lineColor: [0.3, 0.48, 0.52], width: 0.8 },
      );
    let tracks, times: number[];
    if (ais) {
      const data = (await fetch(`${root}ais.json`).then((r) => r.json())) as {
        tracks: { id: string; records: { time: number; position: number[] }[] }[];
      };
      tracks = data.tracks.map((t) => ({
        id: t.id,
        times: t.records.map((r) => r.time),
        positions: t.records.flatMap((r) => r.position),
      }));
      const min = Math.min(...tracks.map((t) => t.times[0])),
        max = Math.max(...tracks.map((t) => t.times[t.times.length - 1]));
      times = Array.from({ length: 121 }, (_, i) => min + ((max - min) * i) / 120);
    } else {
      const data = await fetch(`${root}iss.json`).then((r) => r.json()),
        satellite = new SGP4(parseOMM(data[0]));
      times = Array.from({ length: 181 }, (_, i) => satellite.elements.epoch + i * 60000);
      tracks = [satelliteTrack(satellite, times)];
    }
    layer = await geoTripsLayer(figure, tracks, {
      projection: ais ? 'mercator' : 'globe',
      trail: (ais ? 60 : 90) * 60000,
      width: ais ? 4 : 3,
      radius: ais ? 6 : 8,
      lineColor: [0.2, 0.8, 1],
      color: [1, 0.68, 0.22],
      height: ais ? 0 : 15000,
      interpolation: ais ? 'linear' : 'great-circle',
    });
    await layer
      .timeline(times, { format: (t) => new Date(t).toISOString().slice(11, 19) + ' UTC' })
      .seek(ais ? 40 : 90);
  }
  await figure.ready();
  status.textContent = 'Ready. Play or scrub the timeline; drag to move the view.';
}
document.querySelector('#dataset')!.addEventListener('change', () =>
  start().catch((e) => {
    status.textContent = String(e);
    reportError(e);
  }),
);
await start();
