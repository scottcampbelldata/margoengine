// Named parametric surfaces and knots for the generic parametricGeometry builder: the Klein bottle (the classic bottle
// and the figure-8 immersion), the Möbius strip with any number of half twists, and tube knots. Formulas: Weisstein,
// "Klein Bottle" and "Möbius Strip" (MathWorld); the figure-8 immersion of the Klein bottle (Wikipedia, "Klein bottle");
// the trefoil, figure-eight and (2, n) torus knots as in Rolfsen, "Knots and Links" (1976).
import { CatmullRomCurve3 } from './curves.js';
import type { GeometryData } from './data.js';
import type { MutableVec3 } from './math.js';
import { parametricGeometry, type ParametricFunction } from './parametric.js';
import { sweepGeometry } from './sweep.js';

const TAU = Math.PI * 2;

/** Options of the named surface geometries: the grid, and a size. */
export interface SurfaceGridOptions {
  /** Columns along `u`. Default 64. */
  slices?: number;
  /** Rows along `v`. Default 32. */
  stacks?: number;
  /** Multiplies every coordinate. Default 1. */
  scale?: number;
}

/** Which Klein bottle: the classic bottle with a neck, or the figure-8 immersion (a twisted torus that crosses itself). */
export type KleinBottleKind = 'bottle' | 'figure8';

/** Options of {@link kleinBottleGeometry}. */
export interface KleinBottleOptions extends SurfaceGridOptions {
  /** Default `'bottle'`. */
  kind?: KleinBottleKind;
  /** Tube radius of the figure-8 immersion's centre circle. Default 2. */
  radius?: number;
}

/** Options of {@link mobiusStripGeometry}. */
export interface MobiusStripOptions extends SurfaceGridOptions {
  /** Radius of the centre circle. Default 1. */
  radius?: number;
  /** Width of the band across, centred on the circle. Default 0.5. */
  width?: number;
  /** Half twists: 1 is the Möbius strip, 2 a full twist (an annulus), -1 the other handedness. Default 1. */
  halfTwists?: number;
}

const finiteScale = (value: number | undefined): number => {
  const s = value ?? 1;
  if (!Number.isFinite(s) || s <= 0) throw new RangeError(`scale ${value} is invalid; pass a positive number`);
  return s;
};

/**
 * The classic Klein bottle immersion (MathWorld, "Klein Bottle"), `u` and `v` in [0, 1] mapped to its u in [0, pi] and
 * v in [0, 2 pi]. About 8 units across before `scale`. The surface closes on itself: P(0, v) = P(1, 1/2 - v).
 */
export function kleinBottleSurface(scale = 1): ParametricFunction {
  return (a, b, target) => {
    const u = a * Math.PI,
      v = b * TAU,
      cu = Math.cos(u),
      su = Math.sin(u),
      cv = Math.cos(v),
      c2 = cu * cu,
      c4 = c2 * c2,
      c6 = c4 * c2;
    target[0] = scale * ((-2 / 15) * cu * (3 * cv - 30 * su + 90 * c4 * su - 60 * c6 * su + 5 * cu * cv * su));
    target[1] =
      scale *
      ((-1 / 15) *
        su *
        (3 * cv -
          3 * c2 * cv -
          48 * c4 * cv +
          48 * c6 * cv -
          60 * su +
          5 * cu * cv * su -
          5 * cu * c2 * cv * su -
          80 * c4 * cu * cv * su +
          80 * c6 * cu * cv * su));
    target[2] = scale * ((2 / 15) * (3 + 5 * cu * su) * Math.sin(v));
  };
}

/** The figure-8 immersion of the Klein bottle: `u` and `v` in [0, 1] map to [0, 2 pi] both, `radius` of the centre circle (default 2). */
export function kleinFigure8Surface(radius = 2, scale = 1): ParametricFunction {
  return (a, b, target) => {
    const u = a * TAU,
      v = b * TAU,
      h = u / 2,
      wobble = radius + Math.cos(h) * Math.sin(v) - Math.sin(h) * Math.sin(2 * v);
    target[0] = scale * wobble * Math.cos(u);
    target[1] = scale * wobble * Math.sin(u);
    target[2] = scale * (Math.sin(h) * Math.sin(v) + Math.cos(h) * Math.sin(2 * v));
  };
}

/**
 * The Möbius strip, `u` in [0, 1] once around the circle and `v` in [0, 1] across the band. With `halfTwists` n the
 * band turns n half circles: P(u, v) = ((R + w cos(n pi u)) cos 2 pi u, (R + w cos(n pi u)) sin 2 pi u, w sin(n pi u)),
 * w = width (v - 1/2). One half twist has one edge and one side: P(0, v) = P(1, 1 - v).
 */
export function mobiusSurface(radius = 1, width = 0.5, halfTwists = 1, scale = 1): ParametricFunction {
  return (a, b, target) => {
    const u = a * TAU,
      w = width * (b - 0.5),
      t = (halfTwists * u) / 2,
      reach = radius + w * Math.cos(t);
    target[0] = scale * reach * Math.cos(u);
    target[1] = scale * reach * Math.sin(u);
    target[2] = scale * w * Math.sin(t);
  };
}

/**
 * A Klein bottle mesh. Self-intersecting by nature (it needs four dimensions to close without crossing); the seam is not
 * welded, as with `parametricGeometry`.
 */
export function kleinBottleGeometry(options: KleinBottleOptions = {}): GeometryData {
  const { kind = 'bottle', radius = 2, slices = 64, stacks = 32 } = options,
    scale = finiteScale(options.scale);
  if (kind !== 'bottle' && kind !== 'figure8') throw new TypeError(`Klein bottle kind ${kind} is unknown; use 'bottle' or 'figure8'`);
  if (!(radius > 0) || !Number.isFinite(radius)) throw new RangeError(`radius ${radius} is invalid; pass a positive number`);
  return parametricGeometry(kind === 'bottle' ? kleinBottleSurface(scale) : kleinFigure8Surface(radius, scale), slices, stacks);
}

/**
 * A Möbius strip mesh. The band has one side, so draw it double-sided; `halfTwists` 2 gives the twisted annulus.
 */
export function mobiusStripGeometry(options: MobiusStripOptions = {}): GeometryData {
  const { radius = 1, width = 0.5, halfTwists = 1, slices = 64, stacks = 4 } = options,
    scale = finiteScale(options.scale);
  if (!(radius > 0) || !(width > 0) || !Number.isFinite(radius + width))
    throw new RangeError(`radius ${radius} and width ${width} must be positive numbers`);
  if (!Number.isInteger(halfTwists) || halfTwists === 0)
    throw new RangeError(`halfTwists ${halfTwists} is invalid; pass a non-zero integer`);
  return parametricGeometry(mobiusSurface(radius, width, halfTwists, scale), slices, stacks);
}

/** The knots {@link knotGeometry} draws, as centre lines of about 1.5 to 2 units across. */
export type KnotName = 'trefoil' | 'figure-eight' | 'cinquefoil' | 'three-twist';

const knots: Record<KnotName, (t: number) => MutableVec3> = {
  // Rolfsen's trefoil.
  'trefoil': (t) => [Math.sin(t) + 2 * Math.sin(2 * t), Math.cos(t) - 2 * Math.cos(2 * t), -Math.sin(3 * t)],
  'figure-eight': (t) => [(2 + Math.cos(2 * t)) * Math.cos(3 * t), (2 + Math.cos(2 * t)) * Math.sin(3 * t), Math.sin(4 * t)],
  // The (2, 5) and (2, 7) torus knots on a torus of radius 2 and 1.
  'cinquefoil': (t) => [(2 + Math.cos((5 * t) / 2)) * Math.cos(t), (2 + Math.cos((5 * t) / 2)) * Math.sin(t), Math.sin((5 * t) / 2)],
  'three-twist': (t) => [(2 + Math.cos((7 * t) / 2)) * Math.cos(t), (2 + Math.cos((7 * t) / 2)) * Math.sin(t), Math.sin((7 * t) / 2)],
};
// The two torus knots run t over two turns, the others one.
const turns: Record<KnotName, number> = { 'trefoil': 1, 'figure-eight': 1, 'cinquefoil': 2, 'three-twist': 2 };

/** Options of {@link knotGeometry}. */
export interface KnotOptions {
  /** Radius of the tube, in the same units as the knot (about 2 across before `scale`). Default 0.25. */
  tube?: number;
  /** Rings along the knot. Default 256. */
  tubularSegments?: number;
  /** Vertices around the tube. Default 12. */
  radialSegments?: number;
  /** Multiplies every coordinate. Default 1. */
  scale?: number;
}

/**
 * A tube around a named knot: `'trefoil'`, `'figure-eight'`, `'cinquefoil'` ((2, 5) torus knot) or `'three-twist'`
 * ((2, 7)). The centre line is a closed centripetal Catmull-Rom spline through `tubularSegments` samples, swept with a
 * circle; the tube must be thin enough not to touch itself (the defaults are).
 * (`torusKnotGeometry` of the main entry draws any (p, q) torus knot.)
 */
export function knotGeometry(name: KnotName, options: KnotOptions = {}): GeometryData {
  const curve = knots[name];
  if (!curve) throw new TypeError(`knot ${String(name)} is unknown; use ${Object.keys(knots).map((k) => `'${k}'`).join(', ')}`);
  const { tube = 0.25, tubularSegments = 256, radialSegments = 12 } = options,
    scale = finiteScale(options.scale);
  if (!(tube > 0) || !Number.isFinite(tube)) throw new RangeError(`tube ${tube} is invalid; pass a positive number`);
  if (!Number.isInteger(tubularSegments) || tubularSegments < 8 || !Number.isInteger(radialSegments) || radialSegments < 3)
    throw new RangeError('tubularSegments must be an integer of at least 8 and radialSegments an integer of at least 3');
  const points: MutableVec3[] = [];
  for (let i = 0; i < tubularSegments; i++) {
    const p = curve(((i / tubularSegments) * TAU * turns[name]));
    points.push([p[0] * scale, p[1] * scale, p[2] * scale]);
  }
  const ring: [number, number][] = [];
  for (let j = 0; j < radialSegments; j++) ring.push([Math.cos((j / radialSegments) * TAU) * tube * scale, Math.sin((j / radialSegments) * TAU) * tube * scale]);
  return sweepGeometry(ring, new CatmullRomCurve3(points, true), { steps: tubularSegments, closed: true });
}
