import provenance from './assets/provenance.json';
import atlasURL from './assets/atlas.png?url';
import windURL from './assets/wind.bin?url';

export const openingDay = 3;
export const dates = provenance.dates.map((date) => Date.parse(date + 'T00:00:00Z'));
export const dimensions = [...provenance.dims, 1];
const [west, east, south, north] = provenance.extentDegrees;
const midLat = (south + north) * .5;
const cosDegrees = (degrees) => Math.cos(degrees * Math.PI / 180);
export const chartWidth = 1.42;
export const chartHeight = chartWidth * (north - south) / ((east - west) * cosDegrees(midLat));
export const bounds = [-chartWidth / 2, chartWidth / 2, -chartHeight / 2, chartHeight / 2, 0, 0];

export function chartPoint(lon, lat) {
  return [(lon - (west + east) * .5) * chartWidth / (east - west),
    (lat - midLat) * chartHeight / (north - south)];
}

async function file(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('The NOAA wind file could not load (' + response.status + ').');
  return response;
}

export async function loadWind(signal) {
  const response = await file(windURL, signal);
  const data = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  signal.throwIfAborted();
  const [nx, ny] = dimensions;
  if (data.byteLength !== dates.length * nx * ny * 4) throw new Error('NOAA wind dimensions do not match the archive.');
  const view = new DataView(data);
  const size = nx * ny;
  return dates.map((_, day) => {
    const physicalU = new Float32Array(size);
    const physicalV = new Float32Array(size);
    const projectedU = new Float32Array(size);
    let maxSpeed = 0;
    for (let j = 0; j < ny; j++) {
      const sampleLat = south + j * (north - south) / (ny - 1);
      const correction = cosDegrees(midLat) / cosDegrees(sampleLat);
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const u = view.getInt16((day * size * 2 + k) * 2, true) * provenance.encodingStep;
        const v = view.getInt16(((day * 2 + 1) * size + k) * 2, true) * provenance.encodingStep;
        physicalU[k] = u;
        physicalV[k] = v;
        projectedU[k] = u * correction;
        maxSpeed = Math.max(maxSpeed, Math.hypot(u, v));
      }
    }
    return {
      direction: { u: projectedU, v: physicalV, dims: dimensions, bounds },
      physical: { u: physicalU, v: physicalV, dims: dimensions, bounds },
      maxSpeed,
    };
  });
}

export async function loadAtlas(signal) {
  const chart = new Image();
  const cancel = () => chart.removeAttribute('src');
  signal.addEventListener('abort', cancel, { once: true });
  try {
    chart.src = atlasURL;
    await chart.decode();
    signal.throwIfAborted();
    const image = await createImageBitmap(chart, { colorSpaceConversion: 'none' });
    if (signal.aborted) {
      image.close();
      signal.throwIfAborted();
    }
    return image;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

