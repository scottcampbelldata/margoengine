import { Figure } from '@margoengine/sciviz';
import {
  geoVectorLayer,
  parseGeoVectors,
  prepareGeoVectors,
  joinGeoData,
  greatCircleArc,
  geoBins,
} from '@margoengine/sciviz/geo-vector';
import { unproject, type Projection } from '@margoengine/sciviz/geo';
const canvas = document.querySelector<HTMLCanvasElement>('#map')!;
const status = document.querySelector<HTMLElement>('#status')!;
const projection = document.querySelector<HTMLSelectElement>('#projection')!;
const dataset = document.querySelector<HTMLSelectElement>('#dataset')!;
const mode = document.querySelector<HTMLSelectElement>('#mode')!;
let figure: Figure;
let generation = 0;
export function currentFigure(): Figure {
  return figure;
}
export async function start(): Promise<void> {
  const current = ++generation;
  figure?.dispose();
  status.textContent = 'Loading vectors...';
  const data = await parseGeoVectors(
    await fetch(`/examples/assets/sciviz/geo-vector/${dataset.value}.geojson`).then((r) => r.text()),
  );
  const table = (await fetch(`/examples/assets/sciviz/geo-vector/${dataset.value}-values.json`).then((r) =>
    r.json(),
  )) as { rows: { key: string; value: number }[] };
  if (current !== generation) return;
  figure = await Figure.create(canvas, {
    axes: false,
    controls: true,
    limits: [-1, 1, -1, 1, -1, 1],
    aspect: [1, 1, 1],
  });
  figure.engine.camera.position =
    projection.value === 'globe' ? (dataset.value === 'states' ? [-1, 4, 6] : [5, 2, 4]) : [0, 2.4, 0.001];
  const values = joinGeoData(data.features, table.rows, {
    featureKey: 'key',
    rowKey: (row) => row.key,
    value: (row) => Math.log10(row.value + 1),
  });
  const mapProjection = projection.value as Projection;
  await geoVectorLayer(figure, data, {
    projection: mapProjection,
    values,
    labels: mode.value === 'choropleth' ? 'name' : undefined,
    opacity: mode.value === 'choropleth' ? 1 : 0.25,
    width: 0.8,
    attribution: 'Natural Earth / US Census Bureau: public domain',
  });
  if (mode.value !== 'choropleth') {
    const geometry = await prepareGeoVectors(data, { projection: 'plate' });
    const anchors = geometry.labels.map((l) => ({
      name: String(data.features[l.feature].properties?.name),
      coordinate: unproject(l.position[0], l.position[1], 'plate'),
    }));
    if (mode.value === 'points') {
      const arc = greatCircleArc(anchors[0].coordinate, anchors[1].coordinate, { arch: 400000 });
      const coordinates = Array.from({ length: arc.length / 3 }, (_, i) => [...arc.slice(i * 3, i * 3 + 3)]);
      const points = await parseGeoVectors({
        type: 'FeatureCollection',
        features: [
          ...anchors.map((a) => ({
            type: 'Feature',
            properties: { name: a.name },
            geometry: { type: 'Point', coordinates: a.coordinate },
          })),
          { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } },
        ],
      });
      await geoVectorLayer(figure, points, {
        projection: mapProjection,
        height: 15000,
        radius: 4,
        width: 3,
        color: [1, 0.65, 0.15],
        lineColor: [1, 0.8, 0.3],
      });
    } else {
      const bins = geoBins(
        anchors.flatMap((a) => a.coordinate),
        { shape: mode.value as 'hexagon' | 'square', projection: 'plate', size: 0.07 },
      );
      const polygons = await parseGeoVectors({
        type: 'FeatureCollection',
        features: bins.map((bin) => {
          const ring = bin.polygon.map(([x, y]) => unproject(x, y, 'plate'));
          ring.push(ring[0]);
          // Polar cells are clipped to the geographic latitude domain before projection.
          for (const p of ring) p[1] = Math.max(-90, Math.min(90, p[1]));
          return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
        }),
      });
      await geoVectorLayer(figure, polygons, {
        projection: mapProjection,
        height: 15000,
        values: bins.map((b) => b.count),
        width: 0.5,
      });
    }
  }
  await figure.ready();
  status.textContent = `Ready. ${data.features.length} source features; ${mode.value}; ${mapProjection}.`;
}
for (const select of [projection, dataset, mode])
  select.addEventListener('change', () => {
    void start().catch((e: unknown) => {
      status.textContent = String(e);
    });
  });
await start();
