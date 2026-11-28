export const ambient = 26;
export const eyeHeight = .50;
export const layerDepth = .020;
export const targetAngle = -.32;
export const minAngle = -1.55;
export const maxAngle = 1.64;
export const distanceLimit = 640;
export const samples = 1024;
const radians = Math.PI / 180;

// Ciddor's standard dry-air phase refractivity at 550 nm.
const inverseWavelengthSquared = 1 / .550 ** 2;
const standardRefractivity = (5792105 / (238.0185 - inverseWavelengthSquared)
  + 167917 / (57.362 - inverseWavelengthSquared)) * 1e-8;
const densityConstant = standardRefractivity * 288.15;
const ambientKelvin = ambient + 273.15;
const ambientIndex = 1 + densityConstant / ambientKelvin;

export function refractiveIndex(height, surfaceC) {
  const kelvin = ambientKelvin + (surfaceC - ambient) * Math.exp(-height / layerDepth);
  return 1 + densityConstant / kelvin;
}

export function criticalAngle(surfaceC) {
  return Math.acos(refractiveIndex(0, surfaceC) / refractiveIndex(eyeHeight, surfaceC)) / radians;
}

export function trace(elevation, surfaceC, { path = false, stepScale = 1 } = {}) {
  let x = 0, y = eyeHeight, slope = Math.tan(elevation * radians);
  const heat = surfaceC - ambient;
  const conserved = refractiveIndex(y, surfaceC) / Math.hypot(1, slope);
  const points = path ? [[x, y]] : undefined;
  let turn = null;

  function bend(h, s) {
    const excess = heat * Math.exp(-Math.max(0, h) / layerDepth);
    const kelvin = ambientKelvin + excess;
    return (1 + s * s) * densityConstant * excess / (layerDepth * kelvin * (kelvin + densityConstant));
  }
  const finish = (kind, distance, height, angle) => ({ kind, distance, height, angle, turn, points, conserved });

  if (!heat) {
    const intercept = slope < 0 ? -y / slope : Infinity;
    const distance = Math.min(distanceLimit, intercept);
    const height = intercept <= distanceLimit ? 0 : y + distance * slope;
    points?.push([distance, height]);
    return finish(intercept < distanceLimit ? 'ground' : slope >= 0 ? 'sky' : 'far', distance, height, elevation);
  }

  while (x < distanceLimit) {
    if (slope >= 0 && y >= eyeHeight) {
      const direction = Math.acos(Math.min(1, conserved / ambientIndex)) / radians;
      points?.push([distanceLimit, y + (distanceLimit - x) * Math.tan(direction * radians)]);
      return finish(turn === null ? 'sky' : 'turned', x, y, direction);
    }
    // Integrate y'=s, s'=(1+s²)n'/n. Restrict each step near the thin boundary layer.
    const stepLimit = Math.min(8, .19 + 67 * y);
    const step = Math.min(distanceLimit - x, stepScale * Math.max(.065,
      Math.min(stepLimit, (.0010 + .105 * y) / Math.max(Math.abs(slope), .002))));
    const k1 = bend(y, slope);
    const s2 = slope + step * k1 / 2;
    const k2 = bend(y + step * slope / 2, s2);
    const s3 = slope + step * k2 / 2;
    const k3 = bend(y + step * s2 / 2, s3);
    const s4 = slope + step * k3;
    const k4 = bend(y + step * s3, s4);
    const nextSlope = slope + step * (k1 + 2 * k2 + 2 * k3 + k4) / 6;
    const nextY = y + step * (slope + 2 * s2 + 2 * s3 + s4) / 6;
    if (nextY <= 0) {
      const hit = x + step * y / (y - nextY);
      points?.push([hit, 0]);
      return finish('ground', hit, 0, Math.atan(nextSlope) / radians);
    }
    if (slope < 0 && nextSlope >= 0) {
      const crossing = -slope / (nextSlope - slope);
      const turnTemperature = densityConstant / (conserved - 1);
      const h = -layerDepth * Math.log((turnTemperature - ambientKelvin) / heat);
      turn = { distance: x + crossing * step, height: h };
      points?.push([turn.distance, turn.height]);
    }
    x += step;
    y = nextY;
    slope = nextSlope;
    points?.push([x, y]);
  }
  if (turn !== null) return finish('turned', x, y, Math.acos(Math.min(1, conserved / ambientIndex)) / radians);
  return finish(slope > 0 ? 'sky' : 'far', x, y, Math.atan(slope) / radians);
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
