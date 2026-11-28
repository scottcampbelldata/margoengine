import { heatedAirLayer, layeredElevation, traceGradedRay } from '@margoengine/optics/refraction';

export const ambient = 26;
export const eyeHeight = .50;
export const layerDepth = .020;
export const targetAngle = -.32;
export const minAngle = -1.55;
export const maxAngle = 1.64;
export const distanceLimit = 640;
export const samples = 1024;
const radians = Math.PI / 180;

// Air over the road: Ciddor refractivity at 550 nm and a temperature excess that falls off over layerDepth.
let cached;
function air(surfaceC) {
  if (cached?.surfaceC !== surfaceC) cached = { surfaceC, medium: heatedAirLayer({ ambient, surface: surfaceC, depth: layerDepth }) };
  return cached.medium;
}

export const refractiveIndex = (height, surfaceC) => air(surfaceC).index(height);

/** Elevation, degrees, of the ray that just grazes the road: steeper rays reach the asphalt. */
export function criticalAngle(surfaceC) {
  const medium = air(surfaceC);
  return layeredElevation(medium.index(0), medium.index(eyeHeight)) / radians;
}

export function trace(elevation, surfaceC, { path = false } = {}) {
  const medium = air(surfaceC);
  const ray = traceGradedRay(medium, {
    height: eyeHeight, elevation: elevation * radians, distance: distanceLimit, ceiling: eyeHeight, path,
  });
  const { distance, height, turn, points } = ray;
  const result = (kind, angle) => ({ kind, distance, height, angle, turn, points, conserved: ray.invariant });
  if (ray.kind === 'ground') return result('ground', ray.elevation / radians);
  if (ray.kind === 'ceiling' || turn) {
    const angle = layeredElevation(ray.invariant, medium.farIndex) / radians;
    if (ray.kind === 'ceiling') points?.push([distanceLimit, height + (distanceLimit - distance) * Math.tan(angle * radians)]);
    return result(turn ? 'turned' : 'sky', angle);
  }
  return result(ray.elevation > 0 ? 'sky' : 'far', ray.elevation / radians);
}

export function rayTable(surfaceC, data = new Uint8Array(samples * 4)) {
  for (let i = 0; i < samples; i++) {
    const elevation = minAngle + (maxAngle - minAngle) * i / (samples - 1);
    const ray = trace(elevation, surfaceC);
    const sky = ray.kind === 'sky' || ray.kind === 'turned';
    const value = sky ? (ray.angle - minAngle) / (maxAngle - minAngle) : ray.distance / distanceLimit;
    const encoded = Math.round(Math.max(0, Math.min(1, value)) * 65535);
    data[i * 4] = encoded >> 8;
    data[i * 4 + 1] = encoded & 255;
    data[i * 4 + 2] = sky ? 255 : 0;
    data[i * 4 + 3] = ray.kind === 'turned' ? 255 : 0;
  }
  return data;
}
