// Scientific colour maps, each computed from its published definition (no colour tables copied from other projects):
// - cubehelix: D. A. Green, "A colour scheme for the display of astronomical intensity images", Bull. Astr. Soc. India
//   39, 289 (2011): brightness rises monotonically while the hue rotates; the formula and its constants are in the paper.
// - coolwarm: K. Moreland, "Diverging color maps for scientific visualization", ISVC 2009: interpolation between two
//   endpoints through a white midpoint in the Msh polar form of CIELAB, with the paper's hue adjustment.
// - aurora, ember, glacier, gray, phase: paths through OKLab (B. Ottosson, "A perceptual color space for image
//   processing", 2020) whose lightness changes linearly (sequential maps) or stays constant (the cyclic phase map),
//   so equal data steps look like equal colour steps, with chroma pulled in until each colour fits the sRGB gamut.
import { LinearToSRGB, SRGBToLinear, hexColor } from '@margoengine/math/color';
import { rangeError, typeError } from '../../shared/errors.js';

/** An sRGB colour as three numbers in [0, 1]. */
export type SRGB = readonly [number, number, number];

/** The built-in colour maps. */
export type ColormapName = 'aurora' | 'ember' | 'glacier' | 'gray' | 'cubehelix' | 'coolwarm' | 'phase';

/** How a map is meant to be read: ordered data, data around a centre, or angles. */
export type ColormapKind = 'sequential' | 'diverging' | 'cyclic';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// The sRGB transfer functions (IEC 61966-2-1), from @margoengine/math.
const encodeSRGB = LinearToSRGB,
  decodeSRGB = SRGBToLinear;

/** OKLab of a linear-light sRGB colour (Ottosson 2020). */
export function linearToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Linear-light sRGB of an OKLab colour (Ottosson 2020); may fall outside [0, 1]. */
export function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

// OKLCh to encoded sRGB, halving the chroma step by step (binary search) until the colour is inside the gamut.
function oklch(L: number, C: number, hueDegrees: number): SRGB {
  const h = (hueDegrees * Math.PI) / 180,
    inside = (c: number) =>
      oklabToLinear(L, c * Math.cos(h), c * Math.sin(h)).every((v) => v >= -1e-6 && v <= 1 + 1e-6);
  let c = C;
  if (!inside(c)) {
    let lo = 0,
      hi = C;
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      if (inside(mid)) lo = mid;
      else hi = mid;
    }
    c = lo;
  }
  const rgb = oklabToLinear(L, c * Math.cos(h), c * Math.sin(h));
  return [encodeSRGB(clamp01(rgb[0])), encodeSRGB(clamp01(rgb[1])), encodeSRGB(clamp01(rgb[2]))];
}

/**
 * Cubehelix (Green 2011) at fraction `t`: `start` colour (0..3: blue, red, green), `rotations` around the hue circle,
 * `hue` (saturation) and `gamma`. The defaults are the paper's: 0.5, -1.5, 1, 1.
 */
export function cubehelix(t: number, start = 0.5, rotations = -1.5, hue = 1, gamma = 1): SRGB {
  const lambda = clamp01(t) ** gamma,
    amplitude = (hue * lambda * (1 - lambda)) / 2,
    phi = 2 * Math.PI * (start / 3 + rotations * clamp01(t)),
    cos = Math.cos(phi),
    sin = Math.sin(phi);
  return [
    clamp01(lambda + amplitude * (-0.14861 * cos + 1.78277 * sin)),
    clamp01(lambda + amplitude * (-0.29227 * cos - 0.90649 * sin)),
    clamp01(lambda + amplitude * (1.97294 * cos)),
  ];
}

// CIELAB (D65 white) and Moreland's Msh form, for the diverging map.
const D65 = [0.95047, 1, 1.08883];
function srgbToLab([r, g, b]: SRGB): [number, number, number] {
  const [R, G, B] = [r, g, b].map(decodeSRGB);
  const xyz = [
    0.4124564 * R + 0.3575761 * G + 0.1804375 * B,
    0.2126729 * R + 0.7151522 * G + 0.072175 * B,
    0.0193339 * R + 0.119192 * G + 0.9503041 * B,
  ].map((v, k) => v / D65[k]);
  const f = (v: number) => (v > 216 / 24389 ? Math.cbrt(v) : ((24389 / 27) * v + 16) / 116);
  const [fx, fy, fz] = xyz.map(f);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function labToSrgb(L: number, a: number, b: number): SRGB {
  const fy = (L + 16) / 116,
    fx = fy + a / 500,
    fz = fy - b / 200;
  const inv = (v: number) => (v ** 3 > 216 / 24389 ? v ** 3 : (116 * v - 16) / (24389 / 27));
  const [X, Y, Z] = [inv(fx), inv(fy), inv(fz)].map((v, k) => v * D65[k]);
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
  return lin.map((v) => clamp01(encodeSRGB(clamp01(v)))) as unknown as SRGB;
}
type Msh = [number, number, number];
const toMsh = (rgb: SRGB): Msh => {
  const [L, a, b] = srgbToLab(rgb),
    M = Math.hypot(L, a, b);
  return [M, Math.acos(L / M), Math.atan2(b, a)];
};
const fromMsh = ([M, s, h]: Msh): SRGB =>
  labToSrgb(M * Math.cos(s), M * Math.sin(s) * Math.cos(h), M * Math.sin(s) * Math.sin(h));
// Moreland's hue adjustment when interpolating a saturated colour toward an unsaturated one.
function adjustHue([M, s, h]: Msh, unsaturatedM: number): number {
  if (M >= unsaturatedM - 0.1) return h;
  const spin = (s * Math.sqrt(unsaturatedM ** 2 - M ** 2)) / (M * Math.sin(s));
  return h > -Math.PI / 3 ? h + spin : h - spin;
}

/** Moreland's diverging interpolation between two sRGB endpoints at fraction `t` (0.5 is the white midpoint). */
export function diverging(t: number, low: SRGB, high: SRGB): SRGB {
  let a = toMsh(low),
    b = toMsh(high),
    x = clamp01(t);
  // Both saturated and far apart in hue: go through an unsaturated midpoint.
  if (a[1] > 0.05 && b[1] > 0.05 && Math.abs(a[2] - b[2]) > Math.PI / 3) {
    const middle = Math.max(a[0], b[0], 88);
    if (x < 0.5) {
      b = [middle, 0, 0];
      x *= 2;
    } else {
      a = [middle, 0, 0];
      x = 2 * x - 1;
    }
  }
  if (a[1] < 0.05 && b[1] > 0.05) a = [a[0], a[1], adjustHue(b, a[0])];
  else if (b[1] < 0.05 && a[1] > 0.05) b = [b[0], b[1], adjustHue(a, b[0])];
  return fromMsh([(1 - x) * a[0] + x * b[0], (1 - x) * a[1] + x * b[1], (1 - x) * a[2] + x * b[2]]);
}

// Endpoints from Moreland's paper (cool #3b4cc0, warm #b40426).
const COOL: SRGB = [59 / 255, 76 / 255, 192 / 255],
  WARM: SRGB = [180 / 255, 4 / 255, 38 / 255];

interface Definition {
  readonly kind: ColormapKind;
  readonly sample: (t: number) => SRGB;
  readonly about: string;
}

// Sequential OKLCh paths: lightness L0 -> L1 linearly, hue h0 -> h1, chroma peaking mid-map.
const path = (L0: number, L1: number, h0: number, h1: number, chroma: number) => (t: number) =>
  oklch(L0 + (L1 - L0) * t, chroma * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, t * 1.1))), h0 + (h1 - h0) * t);

const DEFINITIONS: Record<ColormapName, Definition> = {
  aurora: {
    kind: 'sequential',
    about: 'deep violet through blue and green to pale yellow; lightness rises linearly (the default)',
    sample: path(0.27, 0.95, 290, 105, 0.17),
  },
  ember: {
    kind: 'sequential',
    about: 'near black through purple, red and orange to pale yellow; lightness rises linearly',
    sample: path(0.16, 0.97, 300, 95, 0.2),
  },
  glacier: {
    kind: 'sequential',
    about: 'navy through blue and cyan to white; lightness rises linearly',
    sample: path(0.22, 0.98, 265, 195, 0.13),
  },
  gray: { kind: 'sequential', about: 'black to white, linear in perceived lightness', sample: (t) => oklch(t, 0, 0) },
  cubehelix: { kind: 'sequential', about: "Green's cubehelix with the paper's defaults", sample: (t) => cubehelix(t) },
  coolwarm: {
    kind: 'diverging',
    about: "Moreland's cool-warm, blue through white to red",
    sample: (t) => diverging(t, COOL, WARM),
  },
  phase: {
    kind: 'cyclic',
    about: 'a full hue turn at constant lightness and chroma; the ends meet, for angles and phases',
    sample: (t) => oklch(0.7, 0.12, 30 + 360 * t),
  },
};

/** Names of the built-in colour maps. */
export const colormapNames = Object.keys(DEFINITIONS) as ColormapName[];

/** A colour map: `sample(t)` for t in [0, 1], tables for the GPU, and reversed copies. */
export class Colormap {
  readonly #sample: (t: number) => SRGB;
  /** Name (a built-in name, or `custom`). */
  readonly name: string;
  /** Sequential, diverging or cyclic. */
  readonly kind: ColormapKind;

  /** @param sample sRGB colour at t in [0, 1]. */
  constructor(name: string, kind: ColormapKind, sample: (t: number) => SRGB) {
    if (typeof sample !== 'function')
      throw typeError('Colormap needs a sample(t) function returning [r, g, b]', 'sciviz');
    this.name = name;
    this.kind = kind;
    this.#sample = sample;
  }

  /** The sRGB colour at `t` (clamped to [0, 1]; a cyclic map wraps). */
  sample(t: number): SRGB {
    const x = this.kind === 'cyclic' ? t - Math.floor(t) : clamp01(t);
    return this.#sample(Number.isFinite(x) ? x : 0);
  }

  /**
   * `n` evenly spaced RGBA colours, 4 floats each (alpha 1): sRGB-encoded by default, or linear light with
   * `linear: true` (what shaders that blend and light want).
   */
  table(n = 256, options: { readonly linear?: boolean } = {}): Float32Array {
    if (!Number.isInteger(n) || n < 2)
      throw rangeError(`Colormap table size must be a whole number of at least 2, got ${n}`, 'sciviz');
    const out = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      const rgb = this.sample(this.kind === 'cyclic' ? k / n : k / (n - 1));
      for (let c = 0; c < 3; c++) out[k * 4 + c] = options.linear ? decodeSRGB(rgb[c]) : rgb[c];
      out[k * 4 + 3] = 1;
    }
    return out;
  }

  /** The same map read backwards. */
  reversed(): Colormap {
    return new Colormap(`${this.name}-reversed`, this.kind, (t) => this.#sample(1 - t));
  }

  /** A CSS linear-gradient string (default left to right; `'to top'` for a vertical bar), for colour bars and legends. */
  css(stops = 16, direction = 'to right'): string {
    const colours = Array.from({ length: stops }, (_, k) => {
      const [r, g, b] = this.sample(k / (stops - 1)).map((v) => Math.round(v * 255));
      return `rgb(${r} ${g} ${b}) ${((k / (stops - 1)) * 100).toFixed(1)}%`;
    });
    return `linear-gradient(${direction}, ${colours.join(', ')})`;
  }
}

const hex = (value: string): SRGB => {
  const rgba = hexColor(value.trim());
  if (!rgba) throw typeError(`Colour ${value} is not #rrggbb`, 'sciviz');
  return [rgba[0], rgba[1], rgba[2]];
};

/**
 * A colour map: a built-in name (default `'aurora'`), an existing Colormap, or your own stops as `#rrggbb` strings
 * or `[r, g, b]` (evenly spaced, or `[t, colour]` pairs), interpolated in OKLab.
 * @example colormap('coolwarm'); colormap(['#000004', '#b63679', '#fcfdbf']); colormap([[0, '#00f'], ...]);
 */
export function colormap(
  source: ColormapName | Colormap | readonly (string | SRGB | readonly [number, string | SRGB])[] = 'aurora',
): Colormap {
  if (source instanceof Colormap) return source;
  if (typeof source === 'string') {
    const definition = DEFINITIONS[source];
    if (!definition)
      throw typeError(
        `Unknown colour map ${source}; use one of ${colormapNames.join(', ')}, or your own stops`,
        'sciviz',
      );
    return new Colormap(source, definition.kind, definition.sample);
  }
  if (!Array.isArray(source) || source.length < 2)
    throw typeError('A custom colour map needs at least two stops', 'sciviz');
  const stops = source.map((stop, k) => {
    const paired =
      Array.isArray(stop) &&
      stop.length === 2 &&
      typeof stop[0] === 'number' &&
      (typeof stop[1] === 'string' || Array.isArray(stop[1]));
    const t = paired ? (stop[0] as number) : k / (source.length - 1),
      colour = paired ? stop[1] : stop;
    const rgb = typeof colour === 'string' ? hex(colour) : (colour as SRGB);
    if (!Number.isFinite(t) || rgb.length !== 3)
      throw typeError('Colour map stops are [t, colour] pairs or colours', 'sciviz');
    return { t, lab: linearToOklab(decodeSRGB(rgb[0]), decodeSRGB(rgb[1]), decodeSRGB(rgb[2])) };
  });
  stops.sort((a, b) => a.t - b.t);
  return new Colormap('custom', 'sequential', (t) => {
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1].t) k++;
    const a = stops[k],
      b = stops[k + 1],
      f = b.t > a.t ? clamp01((t - a.t) / (b.t - a.t)) : 0;
    const lin = oklabToLinear(
      ...([0, 1, 2].map((c) => a.lab[c] + (b.lab[c] - a.lab[c]) * f) as [number, number, number]),
    );
    return [encodeSRGB(clamp01(lin[0])), encodeSRGB(clamp01(lin[1])), encodeSRGB(clamp01(lin[2]))];
  });
}

/** What each built-in map is for. */
export function describeColormap(name: ColormapName): { kind: ColormapKind; about: string } {
  const d = DEFINITIONS[name];
  if (!d) throw typeError(`Unknown colour map ${name}`, 'sciviz');
  return { kind: d.kind, about: d.about };
}
