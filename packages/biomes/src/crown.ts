// What cover.ts and fuel.ts both read of a species and a region sample: the mean crown area of a species and a sample's
// value of a suitability field. Display maths, floats (neither enters a digest).
import type { SpeciesRule } from './define.js';
import type { BiomeSample } from './sample.js';

/**
 * The mean square of a species' crown multiplier: crowns grow as size^0.75 (`SizeDistribution`), so the mean over the
 * size distribution of size^1.5, by 64 midpoints of its inverse CDF. Display maths, floats.
 */
export function meanCrownArea(rule: SpeciesRule): number {
  const s = rule.size;
  if (!s) return 1;
  let sum = 0;
  if (s.kind === 'reverse-j') {
    const top = s.max ** (4 / 3), // float division: option maths
      low = top / 10, // float division
      rate = 10 * Math.log(s.q),
      reach = 1 - Math.exp(-rate * (top - low));
    for (let i = 0; i < 64; i++) sum += (low - Math.log(1 - ((i + 0.5) / 64) * reach) / rate) ** 1.5; // float division
  } else
    for (let i = 0; i < 64; i++)
      sum += Math.min(3 * s.scale, s.scale * (-Math.log(1 - (i + 0.5) / 64)) ** (1 / s.shape)) ** 1.5; // float division
  return sum / 64; // float division
}

/** A region sample's value of a suitability field, in the units of a tile layer (`Dimension`). */
export function stored(s: BiomeSample, layer: string): number {
  switch (layer) {
    case 'temperature':
      return s.temperature * 100;
    case 'coldest':
      return s.coldest * 100;
    case 'warmest':
      return s.warmest * 100;
    case 'gdd5':
      return s.gdd5;
    case 'season':
      return s.season;
    case 'treeline':
      return s.treeline * 100;
    case 'alpha':
      return s.alpha * 255;
    case 'exposure':
      return s.exposure * 255;
    case 'soil':
      return s.soil * 100;
    case 'curvature':
      return (s.curvature ?? 0) * 10000;
    case 'rainfall':
      return s.rainfall;
    case 'moisture':
      return s.moisture * 255;
    case 'slope':
      return s.slope * 256;
    case 'height':
      return s.height * 1000;
    default:
      return s.waterDistance * 10;
  }
}
