import firstURL from './assets/ktlx-20130520.deflate?url';
import extraURL from './assets/ktlx-20130520-extra.deflate?url';

const earthRadius = 6371;
const effectiveRadius = earthRadius * 4 / 3;
const radians = Math.PI / 180;
const openingCuts = new Set([1, 8]);
export const extent = 48;
export const elevationExaggeration = 4;
export const palette = ['#153650','#286477','#479f96','#b1cb7c','#f4d373','#e68059','#ce515f','#f8c6db'];

export function beam(range, elevation) {
  const angle = elevation * radians;
  const height = Math.hypot(range * Math.cos(angle), effectiveRadius + range * Math.sin(angle)) - effectiveRadius;
  const arc = effectiveRadius * Math.asin(range * Math.cos(angle) / (effectiveRadius + height));
  return [arc, height];
}

export function coordinates(range, elevation, bearing) {
  const [arc, height] = beam(range, elevation);
  const direction = bearing * radians;
  return [arc * Math.sin(direction), height, arc * Math.cos(direction)];
}

export function geodesic(latitude, longitude, targetLat, targetLon) {
  const phi = latitude * radians, next = targetLat * radians, d = (targetLon - longitude) * radians;
  const east = Math.sin(d) * Math.cos(next);
  const north = Math.cos(phi) * Math.sin(next) - Math.sin(phi) * Math.cos(next) * Math.cos(d);
  const cos = Math.sin(phi) * Math.sin(next) + Math.cos(phi) * Math.cos(next) * Math.cos(d);
  const range = earthRadius * Math.atan2(Math.hypot(east, north), cos);
  const direction = Math.atan2(east, north);
  return [range * Math.sin(direction), range * Math.cos(direction)];
}

async function packet(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error('The archived radar measurements could not be read.');
  return new Response(response.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
}

function decode(grid, input, start, first) {
  const {bearingCount, gateCount, sweeps, codeScale, codeOffset} = grid;
  const view = new DataView(input);
  const sweepBytes = bearingCount * (2 + gateCount);
  let cursor = start;
  for (const sweep of sweeps) {
    if (openingCuts.has(sweep.cut) !== first) continue;
    if (cursor + sweepBytes > input.byteLength) throw new Error('The radar data are incomplete.');
    sweep.elevations = Float32Array.from({length:bearingCount}, (_, i) => view.getInt16(cursor + 2 * i, true) / 1000);
    sweep.gates = new Uint8Array(input, cursor + bearingCount * 2, bearingCount * gateCount);
    sweep.peak = (sweep.gates.reduce((a, b) => Math.max(a, b)) - codeOffset) / codeScale;
    cursor += sweepBytes;
  }
  if (cursor !== input.byteLength) throw new Error('The radar data contain an unexpected packet.');
  return grid;
}

export async function readOpening(signal) {
  const input = await packet(firstURL, signal);
  const headerLength = new DataView(input).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(input, 4, headerLength)));
  return decode(header, input, headerLength + 4, true);
}

export async function readExtra(grid, signal) {
  return decode(grid, await packet(extraURL, signal), 0, false);
}

export function reflectivity(grid, sweep, bearing, gate) {
  const code = sweep.gates[bearing * grid.gateCount + gate];
  return code >= 2 ? (code - grid.codeOffset) / grid.codeScale : NaN;
}
