import type { Shape } from '@margoengine/geometry/shapes';
import { geometryData, type GeometryData } from '@margoengine/geometry/utils';
import { type OutlineCommand, type OutlineFillRule, outlineShapes } from './outline.js';
import { LoaderError } from './types.js';
import { type BinaryInput, toBytes } from './util.js';
import { decodeXML, readXMLTree, type XMLElement } from './xml.js';

export type { OutlineCommand, OutlineFillRule } from './outline.js';

/** Options of {@link SVGPath.toShapes}. */
export interface SVGShapeOptions {
  /** Negate y so the drawing is upright in a y-up world (SVG's y axis points down). Default false. */
  flipY?: boolean;
}

/** Options of {@link SVGPath.toStrokeGeometry}. */
export interface SVGStrokeOptions extends SVGShapeOptions {
  /** Stroke width in the element's own (pre-transform) units. Default: the path's `strokeWidth`. */
  width?: number;
  /** Straight pieces per curve segment, and per quarter turn of a round join or cap. Default 12. */
  divisions?: number;
}

/** One drawn element (path, rect, circle, ellipse, line, polyline or polygon) with its computed style. */
export interface SVGPath {
  /** Element name, for example `'rect'`. */
  element: string;
  /** The element's own `id`, when it has one. Copies drawn through `<use>` keep the referenced element's id. */
  id?: string;
  /** Outline in root user units (every transform and nested viewport applied), y down. */
  commands: OutlineCommand[];
  /** Fill colour, sRGB 0..1, or null for none or an unusable paint. */
  fill: [number, number, number] | null;
  /** Group opacity x `fill-opacity` x the paint's alpha, 0..1. */
  fillOpacity: number;
  /** `'evenodd'` or `'nonzero'` (the default). */
  fillRule: OutlineFillRule;
  /** Stroke colour, sRGB 0..1, or null for no stroke (the default). */
  stroke: [number, number, number] | null;
  /** Group opacity x `stroke-opacity` x the paint's alpha, 0..1. */
  strokeOpacity: number;
  /** Stroke width in the element's own units. Default 1, never negative. */
  strokeWidth: number;
  /** `stroke-linejoin`; values other than round and bevel are drawn as miter. */
  strokeLineJoin: 'miter' | 'round' | 'bevel';
  /** `stroke-linecap`. */
  strokeLineCap: 'butt' | 'round' | 'square';
  /** `stroke-miterlimit`, 1 or more. Default 4. */
  strokeMiterLimit: number;
  /** Filled shapes, with holes decided by containment and the fill rule. Open subpaths fill as if closed. */
  toShapes(options?: SVGShapeOptions): Shape[];
  /**
   * The stroke as flat triangles on z = 0, wound counter-clockwise, with normals +z and UVs equal to x and y. The
   * outline is built in the element's own units with its joins, caps and miter limit and then transformed, so
   * non-uniform scales and skews shape it as SVG does. Joins are trimmed on their inner side where the neighbouring
   * segments are long enough, so most pieces do not overlap; where they cannot be trimmed they overlap, which is fine
   * when opaque. Dashes are not applied. A width of 0 gives an empty geometry.
   *
   * @throws RangeError when the width is not a finite number of 0 or more, or `divisions` is not an integer of 1 or
   * more.
   */
  toStrokeGeometry(options?: SVGStrokeOptions): GeometryData;
}

/** Result of {@link parseSVG}. */
export interface LoadedSVG {
  /** Drawn elements in document order. */
  paths: SVGPath[];
  /** The root `viewBox`, when it holds exactly four numbers. */
  viewBox?: [number, number, number, number];
  /** Root width in px, when the attribute is present. */
  width?: number;
  /** Root height in px, when the attribute is present. */
  height?: number;
  /** Everything that was skipped or approximated, one line each, without repeats. */
  warnings: string[];
}

const F = 'SVG';
/** Most path commands in one `d` attribute, and in the whole document counting `<use>` copies. */
const MAX_COMMANDS = 4_000_000;
/** Deepest chain of `<use>` references followed. */
const MAX_USE_DEPTH = 32;
/** Most `href` hops followed from a gradient to the one that holds its stops. */
const MAX_GRADIENT_HOPS = 8;
const HALF_PI = Math.PI / 2;

type Point = [number, number];
type RGBA = [number, number, number, number];
/** Affine matrix [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f. */
type Affine = [number, number, number, number, number, number];
type Props = Record<string, string>;

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
/** `m` then `n` in written order: the result maps a point through `n` first. */
const compose = (m: Affine, n: Affine): Affine => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const shift = (x: number, y: number): Affine => [1, 0, 0, 1, x, y];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const NUMBERS = new RegExp(NUMBER, 'g');
const numbers = (text: string | undefined): number[] => (text?.match(NUMBERS) ?? []).map(Number);
const localName = (name: string) => name.slice(name.indexOf(':') + 1);

// ---------------------------------------------------------------------------------------------------------------
// Colours (CSS Color 3 and 4)

/** The 148 named colours of CSS Color 4 section 6.1, as name and six hex digits. */
const NAMED =
  'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 ' +
  'black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 ' +
  'chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff ' +
  'darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 ' +
  'darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 ' +
  'darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f ' +
  'darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 ' +
  'dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ' +
  'ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 ' +
  'honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa ' +
  'lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff ' +
  'lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 ' +
  'lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 ' +
  'lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 ' +
  'mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 ' +
  'mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 ' +
  'midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 ' +
  'oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa ' +
  'palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f ' +
  'pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f ' +
  'royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee ' +
  'sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa ' +
  'springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 ' +
  'violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32';
let namedColours: Map<string, string> | undefined;

function hexColour(hex: string): RGBA | null {
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  const pairs = hex.length === 6 || hex.length === 8;
  if (!pairs && hex.length !== 3 && hex.length !== 4) return null;
  const channels = pairs ? hex.length / 2 : hex.length;
  const channel = (i: number) => parseInt(pairs ? hex.slice(2 * i, 2 * i + 2) : hex[i] + hex[i], 16) / 255;
  return [channel(0), channel(1), channel(2), channels === 4 ? channel(3) : 1];
}

/** CSS Color 3 section 4.2.4: one RGB channel from the two HSL helper values and a hue in turns. */
function hueChannel(m1: number, m2: number, h: number): number {
  if (h < 0) h += 1;
  if (h > 1) h -= 1;
  if (h * 6 < 1) return m1 + (m2 - m1) * h * 6;
  if (h * 2 < 1) return m2;
  if (h * 3 < 2) return m1 + (m2 - m1) * (2 / 3 - h) * 6;
  return m1;
}

/** Reads a CSS colour (hex, rgb/rgba, hsl/hsla, a named colour or transparent); null when it is not one. */
function readColour(value: string): RGBA | null {
  const text = value.trim().toLowerCase();
  if (text === 'transparent') return [0, 0, 0, 0];
  if (text[0] === '#') return hexColour(text.slice(1));
  const call = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(text);
  if (call) {
    const parts = call[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return null;
    const values: number[] = [],
      percent: boolean[] = [];
    for (const [i, part] of parts.entries()) {
      const match = new RegExp(`^(${NUMBER})(%|deg)?$`).exec(part);
      if (!match || (match[2] === 'deg' && (i > 0 || call[1][0] !== 'h'))) return null;
      values.push(Number(match[1]));
      percent.push(match[2] === '%');
    }
    const alpha = values.length > 3 ? clamp01(percent[3] ? values[3] / 100 : values[3]) : 1;
    if (call[1][0] === 'r') {
      const c = (i: number) => clamp01(percent[i] ? values[i] / 100 : values[i] / 255);
      return [c(0), c(1), c(2), alpha];
    }
    const h = (((values[0] % 360) + 360) % 360) / 360,
      s = clamp01(values[1] / 100),
      l = clamp01(values[2] / 100);
    const m2 = l <= 0.5 ? l * (s + 1) : l + s - l * s,
      m1 = l * 2 - m2;
    return [hueChannel(m1, m2, h + 1 / 3), hueChannel(m1, m2, h), hueChannel(m1, m2, h - 1 / 3), alpha];
  }
  if (!namedColours) {
    namedColours = new Map();
    const words = NAMED.split(' ');
    for (let i = 0; i < words.length; i += 2) namedColours.set(words[i], words[i + 1]);
  }
  const hex = namedColours.get(text);
  return hex ? hexColour(hex) : null;
}

/** A number or a percentage, clamped to 0..1; 1 when the value is missing or invalid. */
function readOpacity(value: string | undefined): number {
  const match = value === undefined ? null : new RegExp(`^(${NUMBER})(%?)$`).exec(value.trim());
  return match ? clamp01(Number(match[1]) / (match[2] ? 100 : 1)) : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Lengths (CSS Values 3 section 5.2: 96 px per inch; no font context, so em = 16 px and ex = 8 px)

const UNITS = new Map<string, number>([
  ['', 1],
  ['px', 1],
  ['pt', 4 / 3],
  ['pc', 16],
  ['mm', 96 / 25.4],
  ['cm', 96 / 2.54],
  ['in', 96],
  ['em', 16],
  ['ex', 8],
]);
const LENGTH = new RegExp(`^\\s*(${NUMBER})\\s*(%|[a-zA-Z]*)\\s*$`);

/** A length in user units; `reference` is what 100% means; `fallback` when the value is missing or invalid. */
function readLength(value: string | undefined, reference: number, fallback: number): number {
  const match = value === undefined ? null : LENGTH.exec(value);
  if (!match) return fallback;
  const n = Number(match[1]);
  if (match[2] === '%') return (n * reference) / 100;
  const scale = UNITS.get(match[2].toLowerCase());
  return scale === undefined ? fallback : n * scale;
}

// ---------------------------------------------------------------------------------------------------------------
// Transforms (SVG 1.1 section 7.6)

function readTransform(text: string | undefined, warn: (text: string) => void): Affine {
  let m = IDENTITY;
  if (!text) return m;
  for (const [item, name, args] of text.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const v = numbers(args);
    const angle = ((v[0] ?? 0) * Math.PI) / 180;
    let t: Affine | undefined;
    if (name === 'matrix') {
      if (v.length === 6) t = v as Affine;
      else warn(`transform "${item.slice(0, 60)}" needs 6 numbers; ignored`);
    } else if (name === 'translate') t = shift(v[0] ?? 0, v[1] ?? 0);
    else if (name === 'scale') t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    else if (name === 'rotate') {
      const c = Math.cos(angle),
        s = Math.sin(angle);
      t = [c, s, -s, c, 0, 0];
      if (v.length >= 3) t = compose(compose(shift(v[1], v[2]), t), shift(-v[1], -v[2]));
    } else if (name === 'skewX') t = [1, 0, Math.tan(angle), 1, 0, 0];
    else t = [1, Math.tan(angle), 0, 1, 0, 0];
    if (t) m = compose(m, t);
  }
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// Elliptical arcs (SVG 1.1 appendix F.6) as cubic Béziers

/**
 * Appends the arc from (x1, y1) to (x2, y2) as cubics of at most 90 degrees each. Endpoint to centre conversion
 * follows F.6.5 with the radius correction of F.6.6; each piece uses control points at 4/3 tan(phi / 4) along the
 * unit-circle tangents (Maisonobe 2003, section 3.4.1), mapped through the radii and rotation.
 */
function appendArc(
  out: OutlineCommand[],
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  rotation: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): void {
  if (x1 === x2 && y1 === y2) return;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) {
    out.push(['L', x2, y2]);
    return;
  }
  const phi = (rotation * Math.PI) / 180,
    cos = Math.cos(phi),
    sin = Math.sin(phi);
  // F.6.5.1: the start point in a frame centred between the end points, aligned with the ellipse axes.
  const hx = (x1 - x2) / 2,
    hy = (y1 - y2) / 2;
  const px = cos * hx + sin * hy,
    py = -sin * hx + cos * hy;
  // F.6.6: grow the radii uniformly when no ellipse of this size reaches both points.
  const lambda = (px * px) / (rx * rx) + (py * py) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  // F.6.5.2: the centre in that frame.
  const a = rx * rx * py * py,
    b = ry * ry * px * px;
  const root = Math.sqrt(Math.max(0, (rx * rx * ry * ry - a - b) / (a + b))) * (large === sweep ? -1 : 1);
  const qx = (root * rx * py) / ry,
    qy = (-root * ry * px) / rx;
  // F.6.5.3: back to user space.
  const cx = cos * qx - sin * qy + (x1 + x2) / 2,
    cy = sin * qx + cos * qy + (y1 + y2) / 2;
  // F.6.5.5 and F.6.5.6: start angle and signed sweep on the unit circle.
  const start = Math.atan2((py - qy) / ry, (px - qx) / rx);
  let delta = Math.atan2((-py - qy) / ry, (-px - qx) / rx) - start;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  else if (!sweep && delta > 0) delta -= 2 * Math.PI;
  const pieces = Math.max(1, Math.ceil(Math.abs(delta) / HALF_PI - 1e-9)),
    step = delta / pieces,
    k = (4 / 3) * Math.tan(step / 4);
  const map = (ux: number, uy: number): Point => [
    cx + cos * rx * ux - sin * ry * uy,
    cy + sin * rx * ux + cos * ry * uy,
  ];
  for (let i = 0; i < pieces; i++) {
    const a0 = start + i * step,
      a1 = a0 + step;
    const c0 = Math.cos(a0),
      s0 = Math.sin(a0),
      c1 = Math.cos(a1),
      s1 = Math.sin(a1);
    const p1 = map(c0 - k * s0, s0 + k * c0),
      p2 = map(c1 + k * s1, s1 - k * c1),
      end = i === pieces - 1 ? [x2, y2] : map(c1, s1);
    out.push(['C', p1[0], p1[1], p2[0], p2[1], end[0], end[1]]);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Path data (SVG 1.1 section 8.3, SVG 2 section 9.3)

const PARAMETERS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
const PATH_NUMBER = new RegExp(NUMBER, 'y');

/** Reads `d` into absolute M, L, Q, C and Z commands, keeping everything before the first error. */
function readPathData(d: string, warn: (text: string) => void): OutlineCommand[] {
  const out: OutlineCommand[] = [];
  const length = d.length;
  let i = 0,
    command = '',
    groups = 0;
  let x = 0,
    y = 0,
    startX = 0,
    startY = 0;
  let cubic: Point | null = null,
    quad: Point | null = null;
  const skip = () => {
    while (i < length && /[\s,]/.test(d[i])) i++;
  };
  const here = () => `"${d.slice(i, i + 16)}"`;
  const stop = (message: string) => warn(`path data error, the rest of the path is skipped: ${message}`);
  const values: number[] = [];
  for (;;) {
    skip();
    if (i >= length) break;
    const char = d[i];
    const letter = /[mzlhvcsqta]/i.test(char);
    if (!out.length && !/[Mm]/.test(char)) {
      stop(`path data starts with ${here()}, not a command`);
      break;
    }
    if (letter) {
      command = char;
      i++;
      if (command === 'Z' || command === 'z') {
        out.push(['Z']);
        x = startX;
        y = startY;
        cubic = quad = null;
        continue;
      }
    } else if (command === 'Z' || command === 'z') {
      stop(`unexpected ${here()} after Z`);
      break;
    }
    const lower = command.toLowerCase(),
      relative = command === lower,
      count = PARAMETERS[lower];
    values.length = 0;
    for (let k = 0; k < count; k++) {
      skip();
      if (lower === 'a' && (k === 3 || k === 4)) {
        if (d[i] !== '0' && d[i] !== '1') {
          stop(`expected an arc flag 0 or 1 at ${here()}`);
          return out;
        }
        values.push(d[i++] === '1' ? 1 : 0);
        continue;
      }
      PATH_NUMBER.lastIndex = i;
      const match = PATH_NUMBER.exec(d);
      if (!match) {
        stop(`expected a number at ${here()}`);
        return out;
      }
      i += match[0].length;
      values.push(Number(match[0]));
    }
    if (++groups > MAX_COMMANDS)
      throw new LoaderError(F, 'limit', `path data has more than ${MAX_COMMANDS} commands; split the drawing`);
    const ox = relative ? x : 0,
      oy = relative ? y : 0;
    const v = values;
    let nextCubic: Point | null = null,
      nextQuad: Point | null = null;
    switch (lower) {
      case 'm':
        x = startX = v[0] + ox;
        y = startY = v[1] + oy;
        out.push(['M', x, y]);
        // Further pairs after a moveto are linetos.
        command = relative ? 'l' : 'L';
        break;
      case 'l':
        x = v[0] + ox;
        y = v[1] + oy;
        out.push(['L', x, y]);
        break;
      case 'h':
        x = v[0] + ox;
        out.push(['L', x, y]);
        break;
      case 'v':
        y = v[0] + oy;
        out.push(['L', x, y]);
        break;
      case 'c':
      case 's': {
        const first: Point =
          lower === 'c' ? [v[0] + ox, v[1] + oy] : cubic ? [2 * x - cubic[0], 2 * y - cubic[1]] : [x, y];
        const j = lower === 'c' ? 2 : 0;
        nextCubic = [v[j] + ox, v[j + 1] + oy];
        x = v[j + 2] + ox;
        y = v[j + 3] + oy;
        out.push(['C', first[0], first[1], nextCubic[0], nextCubic[1], x, y]);
        break;
      }
      case 'q':
      case 't': {
        nextQuad = lower === 'q' ? [v[0] + ox, v[1] + oy] : quad ? [2 * x - quad[0], 2 * y - quad[1]] : [x, y];
        const j = lower === 'q' ? 2 : 0;
        x = v[j] + ox;
        y = v[j + 1] + oy;
        out.push(['Q', nextQuad[0], nextQuad[1], x, y]);
        break;
      }
      default: {
        const ex = v[5] + ox,
          ey = v[6] + oy;
        appendArc(out, x, y, v[0], v[1], v[2], v[3] === 1, v[4] === 1, ex, ey);
        x = ex;
        y = ey;
      }
    }
    cubic = nextCubic;
    quad = nextQuad;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// CSS subset: type, class and id selectors

/** Every property the reader uses; all inherit except `opacity` and `display`. */
const PROPERTIES = new Set([
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-opacity',
  'stroke-width',
  'stroke-linejoin',
  'stroke-linecap',
  'stroke-miterlimit',
  'color',
  'visibility',
  'opacity',
  'display',
]);
/** Attributes and properties that change the drawing but are not applied; each draws a warning. */
const UNAPPLIED = [
  'clip-path',
  'mask',
  'filter',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
  'stroke-dasharray',
];

interface Rule {
  type?: string;
  id?: string;
  classes: string[];
  specificity: number;
  declarations: [string, string][];
}

/** `name: value` pairs of a declaration block, names lower-cased, values trimmed, `!important` dropped. */
function readDeclarations(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of text.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part
      .slice(colon + 1)
      .replace(/!\s*important\s*$/i, '')
      .trim();
    if (name) out.push([name, value]);
  }
  return out;
}

function readStyleSheet(css: string, rules: Rule[], warn: (text: string) => void): void {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i++;
    if (i >= css.length) break;
    if (css[i] === '@') {
      warn(`CSS @${/^@([\w-]*)/.exec(css.slice(i))?.[1] ?? ''} rule skipped`);
      const semicolon = css.indexOf(';', i),
        brace = css.indexOf('{', i);
      if (brace >= 0 && (semicolon < 0 || brace < semicolon)) {
        let depth = 0;
        for (i = brace; i < css.length; i++) {
          if (css[i] === '{') depth++;
          else if (css[i] === '}' && --depth === 0) break;
        }
        i++;
      } else i = semicolon < 0 ? css.length : semicolon + 1;
      continue;
    }
    const open = css.indexOf('{', i);
    if (open < 0) break;
    let close = css.indexOf('}', open);
    if (close < 0) close = css.length;
    const declarations = readDeclarations(css.slice(open + 1, close)).filter(([name]) => PROPERTIES.has(name));
    for (const raw of css.slice(i, open).split(',')) {
      const selector = raw.trim();
      const match = /^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)$/.exec(selector);
      if (!selector || !match) {
        if (selector)
          warn(`CSS selector "${selector.slice(0, 40)}" is not supported (only type, class and id selectors)`);
        continue;
      }
      const rule: Rule = { classes: [], specificity: 0, declarations };
      if (match[1] && match[1] !== '*') {
        rule.type = match[1];
        rule.specificity += 1;
      }
      for (const [, kind, name] of match[2].matchAll(/([.#])([\w-]+)/g)) {
        if (kind === '#') {
          rule.id = name;
          rule.specificity += 10000;
        } else {
          rule.classes.push(name);
          rule.specificity += 100;
        }
      }
      rules.push(rule);
    }
    i = close + 1;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Strokes (SVG 2 Painting, "Computing the shape of the stroke")

interface Polyline {
  points: Point[];
  closed: boolean;
}

/** Splits commands into subpaths flattened to points; curves become `divisions` equal parameter steps. */
function flatten(commands: readonly OutlineCommand[], divisions: number): Polyline[] {
  const out: Polyline[] = [];
  let points: Point[] = [],
    closed = false,
    drawn = false,
    x = 0,
    y = 0,
    startX = 0,
    startY = 0;
  const finish = () => {
    if (drawn && points.length) out.push({ points, closed });
    points = [];
    closed = drawn = false;
  };
  const add = (px: number, py: number) => {
    const last = points[points.length - 1];
    if (last[0] !== px || last[1] !== py) points.push([px, py]);
    x = px;
    y = py;
    drawn = true;
  };
  for (const c of commands) {
    if (c[0] === 'M') {
      finish();
      x = startX = c[1];
      y = startY = c[2];
      points = [[x, y]];
      continue;
    }
    // A drawing command right after Z starts a new subpath at the closed one's start.
    if (!points.length) points = [[x, y]];
    if (c[0] === 'Z') {
      closed = drawn = true;
      finish();
      x = startX;
      y = startY;
    } else if (c[0] === 'L') add(c[1], c[2]);
    else {
      const x0 = x,
        y0 = y;
      for (let i = 1; i <= divisions; i++) {
        const t = i / divisions,
          u = 1 - t;
        if (c[0] === 'Q')
          add(u * u * x0 + 2 * u * t * c[1] + t * t * c[3], u * u * y0 + 2 * u * t * c[2] + t * t * c[4]);
        else {
          const b0 = u * u * u,
            b1 = 3 * u * u * t,
            b2 = 3 * u * t * t,
            b3 = t * t * t;
          add(b0 * x0 + b1 * c[1] + b2 * c[3] + b3 * c[5], b0 * y0 + b1 * c[2] + b2 * c[4] + b3 * c[6]);
        }
      }
    }
  }
  finish();
  return out;
}

/** A turn at a polyline vertex. `inner` is +1 when the inside of the turn is on the left normal's side. */
interface Turn {
  inner: number;
  /** Where the two inner offset lines cross, when both neighbouring segments are long enough to trim to it. */
  trim?: Point;
}

/**
 * Stroke outline of one element's commands as triangles (x, y pairs, three per triangle) in local units. Segments
 * are rectangles; at a turn the inner corners of both rectangles are cut back to the crossing of their inner edges,
 * when both segments are long enough, so that segments and joins tile the stroke without overlap.
 */
function strokeTriangles(
  commands: readonly OutlineCommand[],
  half: number,
  divisions: number,
  join: SVGPath['strokeLineJoin'],
  cap: SVGPath['strokeLineCap'],
  miterLimit: number,
): number[] {
  const out: number[] = [];
  const tri = (a: Point, b: Point, c: Point) => out.push(a[0], a[1], b[0], b[1], c[0], c[1]);
  const pieces = (angle: number) => Math.max(1, Math.ceil((Math.abs(angle) / HALF_PI) * divisions - 1e-9));
  const fan = (c: Point, from: number, sweep: number) => {
    const n = pieces(sweep);
    let previous: Point = [c[0] + half * Math.cos(from), c[1] + half * Math.sin(from)];
    for (let i = 1; i <= n; i++) {
      const a = from + (sweep * i) / n;
      const next: Point = [c[0] + half * Math.cos(a), c[1] + half * Math.sin(a)];
      tri(c, previous, next);
      previous = next;
    }
  };
  const along = (p: Point, d: Point, n: Point, s: number, t: number): Point => [
    p[0] + d[0] * t + n[0] * s,
    p[1] + d[1] * t + n[1] * s,
  ];
  for (const { points, closed: z } of flatten(commands, divisions)) {
    let closed = z;
    const last = points[points.length - 1];
    if (closed && points.length > 1 && last[0] === points[0][0] && last[1] === points[0][1]) points.pop();
    if (points.length < 3) closed = false;
    const count = points.length;
    if (count === 1) {
      // Zero-length subpath: only its caps show (SVG 2, stroke-linecap).
      const p = points[0];
      if (cap === 'round') fan(p, 0, 2 * Math.PI);
      else if (cap === 'square') {
        const [x, y] = p;
        tri([x - half, y - half], [x + half, y - half], [x + half, y + half]);
        tri([x - half, y - half], [x + half, y + half], [x - half, y + half]);
      }
      continue;
    }
    const segments = closed ? count : count - 1;
    const dirs: Point[] = [],
      normals: Point[] = [],
      lengths: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = points[i],
        b = points[(i + 1) % count];
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        len = Math.hypot(dx, dy);
      dirs.push([dx / len, dy / len]);
      normals.push([-dy / len, dx / len]);
      lengths.push(len);
    }
    // Joins, on the outer side of every turn.
    const turns: (Turn | null)[] = [];
    for (let v = 0; v < count; v++) {
      turns.push(null);
      if (!closed && (v === 0 || v === count - 1)) continue;
      const a = (v - 1 + segments) % segments,
        b = v;
      const [dax, day] = dirs[a],
        [dbx, dby] = dirs[b];
      const cross = dax * dby - day * dbx,
        dot = dax * dbx + day * dby;
      if (Math.abs(cross) < 1e-12 && dot > 0) continue;
      const angle = Math.atan2(Math.abs(cross), dot),
        inner = cross > 0 ? 1 : -1,
        outer = -inner;
      const p = points[v],
        na = normals[a],
        nb = normals[b];
      const oa = along(p, dirs[a], na, outer * half, 0),
        ob = along(p, dirs[b], nb, outer * half, 0);
      const turn: Turn = { inner };
      const reach = half * Math.max(Math.sin(angle), Math.tan(angle / 2));
      if (reach <= lengths[a] / 2 && reach <= lengths[b] / 2)
        turn.trim = along(p, dirs[a], na, inner * half, -half * Math.tan(angle / 2));
      turns[v] = turn;
      if (join === 'round') {
        // The sweep follows the turn; a full reversal sweeps through the forward direction.
        fan(p, Math.atan2(oa[1] - p[1], oa[0] - p[0]), cross > 0 ? angle : -angle);
        continue;
      }
      tri(p, oa, ob);
      const cosHalf = Math.cos(angle / 2),
        bx = na[0] + nb[0],
        by = na[1] + nb[1],
        bl = Math.hypot(bx, by);
      // Miter ratio 1 / sin(theta / 2) with theta the angle between the segments, which is pi minus the turn.
      if (join === 'miter' && bl > 1e-9 && cosHalf > 1e-9 && 1 / cosHalf <= miterLimit) {
        const reachTip = (outer * half) / cosHalf / bl;
        tri(oa, [p[0] + bx * reachTip, p[1] + by * reachTip], ob);
      }
    }
    // Segment bodies: convex polygons fanned from their first corner.
    for (let i = 0; i < segments; i++) {
      const p = points[i],
        q = points[(i + 1) % count],
        d = dirs[i],
        n = normals[i];
      const polygon: Point[] = [];
      const end = turns[(i + 1) % count],
        start = turns[i];
      if (!end?.trim) polygon.push(along(q, d, n, -half, 0), along(q, d, n, half, 0));
      else if (end.inner > 0) polygon.push(along(q, d, n, -half, 0), q, end.trim);
      else polygon.push(end.trim, q, along(q, d, n, half, 0));
      if (!start?.trim) polygon.push(along(p, d, n, half, 0), along(p, d, n, -half, 0));
      else if (start.inner > 0) polygon.push(start.trim, p, along(p, d, n, -half, 0));
      else polygon.push(along(p, d, n, half, 0), p, start.trim);
      for (let k = 1; k + 1 < polygon.length; k++) tri(polygon[0], polygon[k], polygon[k + 1]);
    }
    if (closed || cap === 'butt') continue;
    // Caps beyond both ends of an open subpath.
    for (const [p, d] of [
      [points[0], [-dirs[0][0], -dirs[0][1]]],
      [points[count - 1], dirs[segments - 1]],
    ] as [Point, Point][]) {
      const n: Point = [-d[1], d[0]];
      if (cap === 'round') fan(p, Math.atan2(n[1], n[0]), -Math.PI);
      else {
        const a = along(p, d, n, half, 0),
          b = along(p, d, n, -half, 0),
          c = along(p, d, n, -half, half),
          e = along(p, d, n, half, half);
        tri(a, b, c);
        tri(a, c, e);
      }
    }
  }
  return out;
}

class DrawnPath implements SVGPath {
  element: string;
  id?: string;
  commands: OutlineCommand[];
  fill: [number, number, number] | null = null;
  fillOpacity = 1;
  fillRule: OutlineFillRule = 'nonzero';
  stroke: [number, number, number] | null = null;
  strokeOpacity = 1;
  strokeWidth = 1;
  strokeLineJoin: SVGPath['strokeLineJoin'] = 'miter';
  strokeLineCap: SVGPath['strokeLineCap'] = 'butt';
  strokeMiterLimit = 4;
  readonly #local: OutlineCommand[];
  readonly #matrix: Affine;

  constructor(element: string, id: string | undefined, local: OutlineCommand[], matrix: Affine) {
    this.element = element;
    if (id !== undefined) this.id = id;
    this.#local = local;
    this.#matrix = matrix;
    const [a, b, c, d, e, f] = matrix;
    this.commands = local.map((command) => {
      const mapped = command.slice() as OutlineCommand;
      for (let i = 1; i < mapped.length; i += 2) {
        const x = command[i] as number,
          y = command[i + 1] as number;
        mapped[i] = a * x + c * y + e;
        mapped[i + 1] = b * x + d * y + f;
      }
      return mapped;
    });
  }

  toShapes(options: SVGShapeOptions = {}): Shape[] {
    return outlineShapes(this.commands, this.fillRule, options.flipY ? (x, y) => [x, -y] : undefined);
  }

  toStrokeGeometry(options: SVGStrokeOptions = {}): GeometryData {
    const width = options.width ?? this.strokeWidth,
      divisions = options.divisions ?? 12;
    if (!Number.isFinite(width) || width < 0)
      throw new RangeError(`stroke width ${width} is invalid; pass a finite width of 0 or more`);
    if (!Number.isInteger(divisions) || divisions < 1)
      throw new RangeError(`stroke divisions ${divisions} is invalid; pass an integer of 1 or more`);
    const local =
      width === 0
        ? []
        : strokeTriangles(
            this.#local,
            width / 2,
            divisions,
            this.strokeLineJoin,
            this.strokeLineCap,
            this.strokeMiterLimit,
          );
    const [a, b, c, d, e, f] = this.#matrix,
      flip = options.flipY ? -1 : 1;
    const positions: number[] = [],
      uvs: number[] = [];
    for (let i = 0; i < local.length; i += 6) {
      const xy: number[] = [];
      for (let k = i; k < i + 6; k += 2)
        xy.push(a * local[k] + c * local[k + 1] + e, flip * (b * local[k] + d * local[k + 1] + f));
      const twice = (xy[2] - xy[0]) * (xy[5] - xy[1]) - (xy[4] - xy[0]) * (xy[3] - xy[1]);
      if (!(twice !== 0 && Number.isFinite(twice))) continue;
      const order = twice > 0 ? [0, 2, 4] : [0, 4, 2];
      for (const k of order) {
        positions.push(xy[k], xy[k + 1], 0);
        uvs.push(xy[k], xy[k + 1]);
      }
    }
    const vertices = positions.length / 3;
    const normals = new Float32Array(vertices * 3);
    for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
    return geometryData(
      positions,
      normals,
      uvs,
      Array.from({ length: vertices }, (_, i) => i),
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Document walk

/** Elements never drawn where they stand; their subtrees are skipped silently. */
const NOT_RENDERED = new Set(
  'defs symbol clipPath mask marker pattern linearGradient radialGradient style title desc metadata script filter foreignObject'.split(
    ' ',
  ),
);
const SHAPES = new Set('path rect circle ellipse line polyline polygon'.split(' '));

/** A computed style: the parent's inheritable values, overridden by the element's own declarations except `inherit`. */
function inherit(parent: Props, declared: Props): Props {
  const style: Props = Object.assign(Object.create(null), parent);
  for (const property in declared)
    if (property !== 'opacity' && property !== 'display' && declared[property] !== 'inherit')
      style[property] = declared[property];
  return style;
}

/**
 * Reads an SVG document into drawn paths with their computed styles.
 *
 * Supported: `path`, `rect`, `circle`, `ellipse`, `line`, `polyline` and `polygon`, inside `g`, `a`, `switch` (only
 * its first child whose conditions hold) and nested `svg` viewports, plus `use` of elements and `symbol`s.
 * Transforms, presentation attributes, `<style>` rules with type, class and id selectors, and the `style` attribute
 * are applied. {@link SVGPath.toShapes} gives filled shapes with holes from the fill rule, and
 * {@link SVGPath.toStrokeGeometry} gives the stroke as triangles. Coordinates are root user units (the root viewBox
 * is not applied), y down.
 *
 * Not drawn: text, images, clipping, masks, markers, filters and dashes; each is noted in `warnings`. Gradients are
 * drawn as their average stop colour. Bad path data keeps everything before the error. Everything lenient adds a
 * warning instead of throwing.
 *
 * @param input - SVG text, or its bytes (UTF-8, or UTF-16 with a byte order mark).
 * @throws LoaderError `'syntax'` for malformed XML, `'header'` when there is no `<svg>` root, and `'limit'` when one
 * path or the whole document has more than 4,000,000 commands.
 */
export function parseSVG(input: string | BinaryInput): LoadedSVG {
  const text = typeof input === 'string' ? input : decodeXML(toBytes(input, F));
  const root = readXMLTree(text, F).children.find((element) => localName(element.name) === 'svg');
  if (!root) throw new LoaderError(F, 'header', 'the document has no <svg> root element; pass an SVG file');
  const paths: DrawnPath[] = [],
    warnings: string[] = [],
    ids = new Map<string, XMLElement>(),
    rules: Rule[] = [];
  const warn = (text: string) => {
    if (!warnings.includes(text)) warnings.push(text);
  };
  const byId = (href: string | undefined) => {
    const target = href?.trim();
    return target?.startsWith('#') ? ids.get(target.slice(1)) : undefined;
  };
  // Every id (the first one wins) and every <style> sheet, before drawing starts.
  const index = (element: XMLElement) => {
    const id = element.attributes.id;
    if (id !== undefined && !ids.has(id)) ids.set(id, element);
    if (localName(element.name) === 'style') readStyleSheet(element.text, rules, warn);
    for (const child of element.children) index(child);
  };
  index(root);
  // Increasing specificity; ties keep source order (Array.prototype.sort is stable).
  rules.sort((p, q) => p.specificity - q.specificity);

  const result: LoadedSVG = { paths, warnings };
  const rootAttributes = root.attributes,
    box = numbers(rootAttributes.viewBox);
  if (box.length === 4) result.viewBox = box as [number, number, number, number];
  for (const side of ['width', 'height'] as const) {
    const size = readLength(rootAttributes[side], 100, Number.NaN);
    if (Number.isFinite(size)) result[side] = size;
  }
  // Percentages refer to the root viewport everywhere, nested viewports included.
  const refWidth = result.viewBox ? box[2] : (result.width ?? 100),
    refHeight = result.viewBox ? box[3] : (result.height ?? 100),
    refDiagonal = Math.hypot(refWidth, refHeight) / Math.SQRT2;
  let total = 0;

  /** Declared values of the used properties: presentation attributes, then style rules, then the style attribute. */
  const declare = (element: XMLElement, name: string): Props => {
    const attributes = element.attributes,
      out: Props = Object.create(null);
    for (const property of PROPERTIES)
      if (attributes[property] !== undefined) out[property] = attributes[property].trim();
    const classes = (attributes.class ?? '').split(/\s+/);
    for (const rule of rules)
      if (
        (rule.type === undefined || rule.type === name) &&
        (rule.id === undefined || rule.id === attributes.id) &&
        rule.classes.every((c) => classes.includes(c))
      )
        for (const [property, value] of rule.declarations) out[property] = value;
    const inline = readDeclarations(attributes.style ?? '');
    for (const [property, value] of inline) if (PROPERTIES.has(property)) out[property] = value;
    for (const property of UNAPPLIED) {
      const value = attributes[property] ?? inline.find(([p]) => p === property)?.[1];
      if (value !== undefined && value.trim() !== 'none')
        warn(`${property} is not applied; <${name}> drawn without it`);
    }
    return out;
  };

  /** Resolves a fill or stroke value to a colour with alpha; null for none. */
  const paint = (value: string, colour: string | undefined, kind: string): RGBA | null => {
    if (value === 'none') return null;
    if (value.toLowerCase() === 'currentcolor') return (colour && readColour(colour)) || [0, 0, 0, 1];
    const reference = /^url\(\s*(['"]?)([^'")]*)\1\s*\)\s*(.*)$/i.exec(value);
    if (!reference) {
      const parsed = readColour(value);
      if (!parsed) warn(`${kind} "${value.slice(0, 40)}" is not a colour; drawn as none`);
      return parsed;
    }
    const target = reference[2].trim();
    let element = byId(target);
    // Follow href links through gradients without stops to the one that has them.
    for (let hop = 0; element && hop <= MAX_GRADIENT_HOPS; hop++) {
      const stops = element.children.filter((child) => localName(child.name) === 'stop');
      if (stops.length) {
        const sum: RGBA = [0, 0, 0, 0];
        for (const stop of stops) {
          const inline = new Map(readDeclarations(stop.attributes.style ?? ''));
          const rgba = readColour(inline.get('stop-color') ?? stop.attributes['stop-color'] ?? 'black') ?? [0, 0, 0, 1];
          rgba[3] *= readOpacity(inline.get('stop-opacity') ?? stop.attributes['stop-opacity']);
          for (let k = 0; k < 4; k++) sum[k] += rgba[k] / stops.length;
        }
        warn(`gradient ${target} is drawn as its average stop colour`);
        return sum;
      }
      element = byId(element.attributes.href ?? element.attributes['xlink:href']);
    }
    warn(`${kind} url(${target}) is not a gradient with stops; its fallback is used`);
    return reference[3] ? paint(reference[3].trim(), colour, kind) : null;
  };

  /** The viewBox-to-viewport mapping of a nested svg or a symbol (SVG 1.1 section 7.8), after translate(x, y). */
  const viewport = (element: XMLElement, symbol: boolean, size?: Props): Affine => {
    const a = element.attributes;
    const x = symbol ? 0 : readLength(a.x, refWidth, 0),
      y = symbol ? 0 : readLength(a.y, refHeight, 0);
    const vb = numbers(a.viewBox);
    if (vb.length !== 4 || !(vb[2] > 0) || !(vb[3] > 0)) return shift(x, y);
    const width = readLength(size?.width ?? a.width, refWidth, vb[2]),
      height = readLength(size?.height ?? a.height, refHeight, vb[3]);
    const words = (a.preserveAspectRatio ?? '').trim().split(/\s+/);
    if (words[0] === 'defer') words.shift();
    const align = words[0] || 'xMidYMid';
    let sx = width / vb[2],
      sy = height / vb[3],
      tx = x,
      ty = y;
    if (align !== 'none') {
      sx = sy = words[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
      const spareX = width - vb[2] * sx,
        spareY = height - vb[3] * sy;
      tx += align.startsWith('xMin') ? 0 : align.startsWith('xMax') ? spareX : spareX / 2;
      ty += align.endsWith('YMin') ? 0 : align.endsWith('YMax') ? spareY : spareY / 2;
    }
    return [sx, 0, 0, sy, tx - vb[0] * sx, ty - vb[1] * sy];
  };

  /** A basic shape's outline in its own coordinates (SVG 1.1 chapter 9). */
  const outline = (a: Props, name: string): OutlineCommand[] => {
    if (name === 'path') return readPathData(a.d ?? '', warn);
    const out: OutlineCommand[] = [];
    const length = (key: string, reference: number) => readLength(a[key], reference, 0);
    const arc = (x0: number, y0: number, rx: number, ry: number, x1: number, y1: number) =>
      appendArc(out, x0, y0, rx, ry, 0, false, true, x1, y1);
    if (name === 'rect') {
      const x = length('x', refWidth),
        y = length('y', refHeight),
        width = length('width', refWidth),
        height = length('height', refHeight);
      if (!(width > 0 && height > 0)) return out;
      let rx = a.rx === undefined ? undefined : length('rx', refWidth),
        ry = a.ry === undefined ? undefined : length('ry', refHeight);
      rx ??= ry ?? 0;
      ry ??= rx;
      rx = Math.min(Math.max(rx, 0), width / 2);
      ry = Math.min(Math.max(ry, 0), height / 2);
      const right = x + width,
        bottom = y + height;
      if (rx === 0 || ry === 0) out.push(['M', x, y], ['L', right, y], ['L', right, bottom], ['L', x, bottom]);
      else {
        // Clockwise on screen from the end of the top-left corner, one quarter arc per corner.
        out.push(['M', x + rx, y], ['L', right - rx, y]);
        arc(right - rx, y, rx, ry, right, y + ry);
        out.push(['L', right, bottom - ry]);
        arc(right, bottom - ry, rx, ry, right - rx, bottom);
        out.push(['L', x + rx, bottom]);
        arc(x + rx, bottom, rx, ry, x, bottom - ry);
        out.push(['L', x, y + ry]);
        arc(x, y + ry, rx, ry, x + rx, y);
      }
      out.push(['Z']);
    } else if (name === 'circle' || name === 'ellipse') {
      const cx = length('cx', refWidth),
        cy = length('cy', refHeight),
        rx = name === 'circle' ? length('r', refDiagonal) : length('rx', refWidth),
        ry = name === 'circle' ? rx : length('ry', refHeight);
      if (rx > 0 && ry > 0) {
        out.push(['M', cx + rx, cy]);
        arc(cx + rx, cy, rx, ry, cx - rx, cy);
        arc(cx - rx, cy, rx, ry, cx + rx, cy);
        out.push(['Z']);
      }
    } else if (name === 'line')
      out.push(
        ['M', length('x1', refWidth), length('y1', refHeight)],
        ['L', length('x2', refWidth), length('y2', refHeight)],
      );
    else {
      const values = numbers(a.points);
      if (values.length % 2) warn(`${name} points have an odd count; the last number is ignored`);
      for (let i = 0; i + 1 < values.length; i += 2) out.push([i ? 'L' : 'M', values[i], values[i + 1]]);
      if (out.length && name === 'polygon') out.push(['Z']);
    }
    return out;
  };

  /** Draws `element` and its subtree. `chain` lists the `<use>` targets that led here; `useSize` marks a use target. */
  const visit = (
    element: XMLElement,
    parent: Props,
    matrix: Affine,
    opacity: number,
    chain: XMLElement[],
    useSize?: Props,
  ): void => {
    const name = localName(element.name);
    const symbol = name === 'symbol' && useSize !== undefined;
    if (NOT_RENDERED.has(name) && !symbol) return;
    if (name === 'text' || name === 'image')
      return warn(
        name === 'text'
          ? '<text> is not drawn; convert text to paths first'
          : '<image> is not drawn; raster images are not supported',
      );
    const container = name === 'g' || name === 'a' || name === 'switch' || name === 'svg' || symbol;
    if (!container && name !== 'use' && !SHAPES.has(name)) return warn(`<${name}> is not a drawable element; skipped`);
    const declared = declare(element, name);
    if (declared.display === 'none') return;
    const style = inherit(parent, declared),
      a = element.attributes;
    opacity *= readOpacity(declared.opacity);
    matrix = compose(matrix, readTransform(a.transform, warn));

    if (name === 'use') {
      const href = a.href ?? a['xlink:href'] ?? '',
        target = byId(href);
      if (!target) return warn(`<use> refers to "${href}", which is not an element of this document`);
      if (chain.includes(target) || chain.length >= MAX_USE_DEPTH)
        return warn(`<use> of ${href.trim()} refers to itself or nests deeper than ${MAX_USE_DEPTH}; skipped`);
      const size: Props = Object.create(null);
      if (a.width !== undefined) size.width = a.width;
      if (a.height !== undefined) size.height = a.height;
      const offset = shift(readLength(a.x, refWidth, 0), readLength(a.y, refHeight, 0));
      return visit(target, style, compose(matrix, offset), opacity, [...chain, target], size);
    }
    if (container) {
      if (name === 'svg' || symbol) matrix = compose(matrix, viewport(element, symbol, useSize));
      // switch draws only its first direct child whose conditions hold (SVG 1.1 section 5.8). No extensions are
      // supported, so a non-empty requiredExtensions fails; every other condition counts as true.
      const children =
        name === 'switch'
          ? element.children.filter((child) => !child.attributes.requiredExtensions?.trim()).slice(0, 1)
          : element.children;
      for (const child of children) visit(child, style, matrix, opacity, chain);
      return;
    }
    const local = outline(a, name);
    if (!local.length || style.visibility === 'hidden' || style.visibility === 'collapse') return;
    total += local.length;
    if (total > MAX_COMMANDS)
      throw new LoaderError(F, 'limit', `the document draws more than ${MAX_COMMANDS} commands; simplify it`);
    const path = new DrawnPath(name, a.id, local, matrix);
    const fill = paint(style.fill ?? 'black', style.color, 'fill'),
      stroke = style.stroke === undefined ? null : paint(style.stroke, style.color, 'stroke');
    path.fill = fill && [fill[0], fill[1], fill[2]];
    path.fillOpacity = opacity * readOpacity(style['fill-opacity']) * (fill ? fill[3] : 1);
    path.fillRule = style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero';
    path.stroke = stroke && [stroke[0], stroke[1], stroke[2]];
    path.strokeOpacity = opacity * readOpacity(style['stroke-opacity']) * (stroke ? stroke[3] : 1);
    path.strokeWidth = Math.max(0, readLength(style['stroke-width'], refDiagonal, 1));
    const join = style['stroke-linejoin'],
      cap = style['stroke-linecap'];
    path.strokeLineJoin = join === 'round' || join === 'bevel' ? join : 'miter';
    path.strokeLineCap = cap === 'round' || cap === 'square' ? cap : 'butt';
    const limit = Number(style['stroke-miterlimit']?.trim() || Number.NaN);
    path.strokeMiterLimit = limit >= 1 ? limit : 4;
    paths.push(path);
  };

  // The root's own viewport is not applied: drawing stays in its user units.
  const declared = declare(root, 'svg'),
    opacity = readOpacity(declared.opacity);
  for (const child of root.children) visit(child, inherit(Object.create(null), declared), IDENTITY, opacity, []);
  return result;
}
