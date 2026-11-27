// Complex craters: the flat floor, central peak and wall terraces a large impact crater has instead of a bowl.
// Clean room, from these sources only (kilometres, D the rim diameter):
// - Pike 1977, "Size-Dependence in the Shape of Fresh Impact Craters on the Moon", in Impact and Explosion Cratering
//   (Pergamon), pp. 489-509: complex lunar craters have depth, rim crest to floor, 1.044 D^0.301, rim height 0.236 D^0.399
//   and flat floor diameter 0.187 D^1.249; shape changes (flat floor, central peak, terraces) set in between about 10 and
//   30 km (abstract: NTRS 19780060140). Central peak height 0.032 D^0.900 above 27 km, as quoted from Pike 1977 by Baker
//   et al. 2012, "The transition from complex craters to multi-ring basins on the Moon", JGR Planets 117,
//   https://doi.org/10.1029/2011JE004021. The four size laws were read in secondary sources, not in Pike's paper.
// - Hale and Head 1979, "Central peaks in lunar craters: morphology and morphometry", Proc. Lunar Planet. Sci. Conf. 10
//   (NTRS 19800039542): fresh craters of 17 to 175 km have central peaks.
// - Pearce and Melosh 1986, "Terrace width variations in complex lunar craters", Geophys. Res. Lett. 13, 1419-1422,
//   https://doi.org/10.1029/GL013i013p01419: terraces widen outward and the outermost is about 0.09 D^0.87 wide.
// Authored here, not measured: the ramps between those diameters, the peak's width and outline, the number of terraces,
// the share of each that is flat bench, the wavy wall, the fade of peaks above 140 km and the 0.8 limit of the floor.
import { valueNoise } from './noise3.js';

/** The Moon's transition diameter in metres: where Pike's simple and complex depth laws meet. */
export const LUNAR_TRANSITION = 10583;
// Pike's rim height laws meet at this multiple of the diameter where the depth laws meet.
const RIM_RATIO_AT = 2.012;

const smooth = (v: number): number => {
  const t = v < 0 ? 0 : v > 1 ? 1 : v;
  return t * t * (3 - 2 * t);
};

/** The shape of one crater: lengths in metres, widths as fractions of the radius. */
export interface CraterShape {
  /** Rim crest to floor. */ depth: number;
  /** Rim crest above the surrounding ground, before the ejecta blanket. */ rim: number;
  /** Fraction of the radius that is flat floor. */ floor: number;
  /** Central peak height above the floor; 0 for none. */ peak: number;
  /** Central peak base radius as a fraction of the crater radius. */ peakWidth: number;
  /** Strength of the wall terraces, 0 for a smooth wall. */ terraces: number;
  /** Radial width of the outermost terrace as a fraction of the wall's width. */ step: number;
}

export interface ShapeLaws {
  depthRatio: number;
  rimRatio: number;
  floor: number;
  transition: number;
  peaks: number;
  terraces: number;
}

/**
 * Pike's simple laws up to the transition diameter, his complex laws past it. Another body's transition rescales the
 * lunar laws about it: a crater is shaped like the lunar crater the same multiple past the Moon's transition.
 */
export function craterShape(diameter: number, laws: ShapeLaws, out: CraterShape): CraterShape {
  const { transition } = laws,
    simpleAt = (d: number, ratio: number) => ratio * (d / 1000) ** 1.01 * 1000,
    rimTransition = transition * RIM_RATIO_AT;
  out.depth =
    diameter <= transition
      ? simpleAt(diameter, laws.depthRatio)
      : simpleAt(transition, laws.depthRatio) * (diameter / transition) ** 0.301;
  out.rim =
    diameter <= rimTransition
      ? simpleAt(diameter, laws.rimRatio)
      : simpleAt(rimTransition, laws.rimRatio) * (diameter / rimTransition) ** 0.399;
  out.floor = laws.floor;
  out.peak = out.peakWidth = out.terraces = out.step = 0;
  if (diameter <= transition) return out;
  // The lunar-equivalent diameter in kilometres and the length scale from lunar metres to this body's.
  const scale = transition / LUNAR_TRANSITION,
    D = diameter / scale / 1000,
    pikeFloor = Math.min(0.8, 0.187 * Math.max(D, 20) ** 0.249),
    onset = smooth((D - LUNAR_TRANSITION / 1000) / (20 - LUNAR_TRANSITION / 1000));
  out.floor = laws.floor + (Math.max(laws.floor, pikeFloor) - laws.floor) * onset;
  const peak = 0.032 * D ** 0.9 * 1000 * scale * smooth((D - 17) / 10) * (1 - smooth((D - 140) / 60));
  out.peak = Math.min(0.8 * out.depth, peak * laws.peaks);
  out.peakWidth = Math.min(0.22, 0.8 * out.floor);
  out.terraces = laws.terraces * smooth((D - 15) / 10);
  const wall = ((1 - out.floor) * diameter) / 2;
  out.step = Math.min(0.5, (0.09 * D ** 0.87 * 1000 * scale) / wall);
  return out;
}

// Height fraction of a terraced wall at t (0 at the floor's edge, 1 at the rim). Terraces start at the rim, each three
// quarters as wide as the one outside it, at most four; each is a flat bench with a scarp above it up to the smooth wall
// t^2.
function benches(t: number, step: number): number {
  for (let i = 0, top = 1, width = step; i < 4 && top > 0; i++, width *= 0.75) {
    const low = Math.max(0, top - width);
    if (t >= low) return low * low + (top * top - low * low) * smooth(((t - low) / (top - low) - 0.55) / 0.45);
    top = low;
  }
  return t * t;
}

/**
 * Height inside the rim of a crater (`s` the distance from its centre over its radius, below 1): `floorHeight` on the
 * floor, `crest` at the rim, with the shape's peak and terraces. (u, v, w) is the sample in lengths of 0.12 crater
 * diameters, offset per crater: the noise that makes walls and peaks irregular. The floor and rim heights are exact.
 */
export function craterInterior(
  s: number,
  floorHeight: number,
  crest: number,
  shape: CraterShape,
  u: number,
  v: number,
  w: number,
): number {
  let height = floorHeight;
  if (s > shape.floor) {
    let t = (s - shape.floor) / (1 - shape.floor);
    if (shape.terraces > 0) {
      // Slumped blocks: the benches wander, change width around the wall and break off in places.
      const wander = 0.4 * valueNoise(u * 0.6, v * 0.6, w * 0.6, 11) + 0.16 * valueNoise(u * 1.8, v * 1.8, w * 1.8, 31);
      t = Math.min(1, Math.max(0, t + wander * t * (1 - t)));
      const plain = t * t,
        strength = shape.terraces * smooth(1.1 + 1.6 * valueNoise(u * 0.45, v * 0.45, w * 0.45, 23)),
        step = shape.step * (1 + 0.6 * valueNoise(u * 0.8, v * 0.8, w * 0.8, 29));
      height += (crest - floorHeight) * (plain + (benches(t, step) - plain) * strength);
    } else height += (crest - floorHeight) * t * t;
  }
  if (shape.peak > 0 && s < shape.peakWidth * 1.6) {
    const q = (s / shape.peakWidth) * (1 + 0.35 * valueNoise(u * 2, v * 2, w * 2, 13));
    if (q < 1) height += shape.peak * (1 - q * q) ** 2 * (1 + 0.25 * valueNoise(u * 5, v * 5, w * 5, 17) * q);
  }
  return height;
}
