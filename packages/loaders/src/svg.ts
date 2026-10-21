import { geometryData, type GeometryData, type Shape } from '@margoengine/geometry';
import { LoaderError } from './types.js';
import { toBytes, type BinaryInput } from './util.js';
import { decodeXML, readXMLTree, type XMLElement } from './xml.js';
import { outlineShapes, type OutlineCommand, type OutlineFillRule } from './outline.js';

export type { OutlineCommand, OutlineFillRule } from './outline.js';

const F = 'SVG';
/** Commands one document may expand to (through `<use>` copies as well). */
const MAX_COMMANDS = 4_000_000;
const MAX_USE_DEPTH = 32;

/** SVG affine matrix `[a, b, c, d, e, f]`: x' = a x + c y + e, y' = b x + d y + f. */
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Options of `SVGPath.toShapes`. */
export interface SVGShapeOptions {
  /** Negates y so the drawing is upright in a y-up world (SVG's y axis points down). Default false. */
  flipY?: boolean;
}

/** Options of `SVGPath.toStrokeGeometry`. */
export interface SVGStrokeOptions extends SVGShapeOptions {
  /** Stroke width in the element's own units. Default the path's `strokeWidth`. */
  width?: number;
  /** Straight pieces per curve (and per quarter turn of a round join or cap). Default 12. */
  divisions?: number;
}

/** One drawn SVG element (`path`, `rect`, `circle`, `ellipse`, `line`, `polyline` or `polygon`) with its style. */
export interface SVGPath {
  /** Element name. */
  element: string;
  /** The element's `id`, when it has one. */
  id?: string;
  /** Outline in root user units (every `transform` and nested viewport applied), y down as in the file. */
  commands: OutlineCommand[];
  /** Fill colour, sRGB 0..1, or null for `fill="none"`. Gradients and patterns are approximated (see `warnings`). */
  fill: [number, number, number] | null;
  /** `fill-opacity` times the colour's alpha and the `opacity` of the element and its groups, 0..1. */
  fillOpacity: number;
  /** `fill-rule`: holes by winding (`'nonzero'`, the default) or by parity (`'evenodd'`). */
  fillRule: OutlineFillRule;
  /** Stroke colour, sRGB 0..1, or null for no stroke (the default). */
  stroke: [number, number, number] | null;
  /** `stroke-opacity` times the colour's alpha and the group opacities, 0..1. */
  strokeOpacity: number;
  /** `stroke-width` in the element's own units (its transform scales it). Default 1. */
  strokeWidth: number;
  strokeLineJoin: 'miter' | 'round' | 'bevel';
  strokeLineCap: 'butt' | 'round' | 'square';
  strokeMiterLimit: number;
  /** The fill as geometry `Shape`s with holes, ready for `shapeGeometry` or `extrudeGeometry`. */
  toShapes(options?: SVGShapeOptions): Shape[];
  /**
   * The stroke as flat triangles on z = 0 (normals +z, UVs = x y), with the path's joins, caps and miter limit,
   * computed in the element's own units and then transformed, so non-uniform scales and skews shape it as SVG does.
   * Pieces may overlap (fine when opaque). Empty when the width is 0. Dashes are not applied.
   */
  toStrokeGeometry(options?: SVGStrokeOptions): GeometryData;
}

/** The result of `parseSVG`. */
export interface LoadedSVG {
  /** Every drawn shape element in document order. */
  paths: SVGPath[];
  /** Root `viewBox` `[x, y, width, height]`, when present. Paths stay in these user units (no viewport scaling). */
  viewBox?: [number, number, number, number];
  /** Root `width` and `height` in px, when present. */
  width?: number;
  height?: number;
  /** Content that was skipped or approximated: text, images, gradients, unsupported selectors, bad path data. */
  warnings: string[];
}

const NAMED =
  'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32';
let named: Map<string, string> | undefined;

type RGBA = [number, number, number, number];
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const NUMBERS = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/** CSS colour (`#rgb[a]`, `#rrggbb[aa]`, `rgb[a]()`, `hsl[a]()`, a name, `transparent`), or undefined when invalid. */
function parseColor(value: string): RGBA | undefined {
  const text = value.trim().toLowerCase();
  if (text === 'transparent') return [0, 0, 0, 0];
  if (text[0] === '#') {
    const hex = text.slice(1);
    if (!/^[0-9a-f]+$/.test(hex) || ![3, 4, 6, 8].includes(hex.length)) return undefined;
    const short = hex.length < 6,
      channel = (i: number) =>
        short ? parseInt(hex[i] + hex[i], 16) / 255 : parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255;
    return [channel(0), channel(1), channel(2), hex.length === 4 || hex.length === 8 ? channel(3) : 1];
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(text);
  if (fn) {
    const parts = fn[2]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map((part) => ({ value: parseFloat(part), percent: part.endsWith('%') }));
    if (parts.length < 3 || parts.some((p) => !Number.isFinite(p.value))) return undefined;
    const alpha = parts[3] ? (parts[3].percent ? parts[3].value / 100 : parts[3].value) : 1,
      clamp = (v: number) => Math.min(1, Math.max(0, v));
    if (fn[1].startsWith('rgb'))
      return [...parts.slice(0, 3).map((p) => clamp(p.percent ? p.value / 100 : p.value / 255)), clamp(alpha)] as RGBA;
    const h = (((parts[0].value % 360) + 360) % 360) / 360,
      s = clamp(parts[1].value / 100),
      l = clamp(parts[2].value / 100),
      q = l < 0.5 ? l * (1 + s) : l + s - l * s,
      p = 2 * l - q,
      hue = (t: number) => {
        t = ((t % 1) + 1) % 1;
        return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
      };
    return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3), clamp(alpha)];
  }
  named ??= new Map(NAMED.split(',').map((entry) => entry.split(':') as [string, string]));
  const hex = named.get(text);
  return hex ? parseColor(`#${hex}`) : undefined;
}

/** Properties children inherit. */
const INHERITED = [
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
];
const PROPERTIES = new Set([...INHERITED, 'opacity', 'display']);
/** Elements whose content is never drawn where it stands. */
const SKIPPED = new Set([
  'defs',
  'symbol',
  'clipPath',
  'mask',
  'marker',
  'pattern',
  'linearGradient',
  'radialGradient',
  'style',
  'title',
  'desc',
  'metadata',
  'script',
  'filter',
  'foreignObject',
]);

interface Rule {
  tag?: string;
  id?: string;
  classes: string[];
  specificity: number;
  order: number;
  declarations: [string, string][];
}

const declarations = (text: string): [string, string][] =>
  text
    .split(';')
    .map((part) => {
      const colon = part.indexOf(':');
      return [
        part.slice(0, colon).trim().toLowerCase(),
        part
          .slice(colon + 1)
          .replace(/!important/i, '')
          .trim(),
      ] as [string, string];
    })
    .filter(([name, value]) => name && value && PROPERTIES.has(name));

/** Simple `<style>` rules: type, class and id selectors and their compounds; other selectors are reported. */
function parseCSS(text: string, rules: Rule[], warnings: string[]): void {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  let pos = 0;
  while (pos < css.length) {
    const open = css.indexOf('{', pos);
    if (open < 0) break;
    const head = css.slice(pos, open).trim();
    let depth = 1,
      close = open + 1;
    for (; close < css.length && depth; close++) depth += css[close] === '{' ? 1 : css[close] === '}' ? -1 : 0;
    const body = css.slice(open + 1, close - 1);
    pos = close;
    if (head.startsWith('@')) {
      warnings.push(`CSS ${head.split(/\s/)[0]} rule skipped`);
      continue;
    }
    const found = declarations(body);
    for (const selector of head.split(',').map((s) => s.trim())) {
      const match = /^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)$/.exec(selector);
      if (!selector || !match) {
        warnings.push(`CSS selector "${selector.slice(0, 40)}" is not supported (only type, class and id selectors)`);
        continue;
      }
      const parts = match[2].match(/[.#][\w-]+/g) ?? [],
        id = parts.find((p) => p[0] === '#')?.slice(1),
        classes = parts.filter((p) => p[0] === '.').map((p) => p.slice(1)),
        tag = match[1] && match[1] !== '*' ? match[1] : undefined;
      rules.push({
        tag,
        id,
        classes,
        specificity: (id ? 100 : 0) + classes.length * 10 + (tag ? 1 : 0),
        order: rules.length,
        declarations: found,
      });
    }
  }
}

type Style = Record<string, string>;

/** Length in px: user units, px, pt, pc, mm, cm, in, em (16 px), ex, or % of `reference`. */
function length(value: string | undefined, reference = 100, fallback = 0): number {
  if (value === undefined) return fallback;
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex|%)?\s*$/.exec(value);
  if (!match) return fallback;
  const number = Number(match[1]);
  switch (match[2]) {
    case 'pt':
      return (number * 4) / 3;
    case 'pc':
      return number * 16;
    case 'mm':
      return (number * 96) / 25.4;
    case 'cm':
      return (number * 96) / 2.54;
    case 'in':
      return number * 96;
    case 'em':
      return number * 16;
    case 'ex':
      return number * 8;
    case '%':
      return (number * reference) / 100;
    default:
      return number;
  }
}

const numbers = (text: string | undefined): number[] => (text ? (text.match(NUMBERS) ?? []).map(Number) : []);

/** A `transform` attribute's list, composed left to right. */
function parseTransform(text: string | undefined, warnings: string[]): Matrix {
  let m = IDENTITY;
  if (!text) return m;
  const pattern = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const v = numbers(match[2]),
      rad = ((v[0] ?? 0) * Math.PI) / 180;
    let t: Matrix;
    switch (match[1]) {
      case 'matrix':
        if (v.length !== 6) {
          warnings.push(`transform "${match[0].slice(0, 60)}" needs 6 numbers; ignored`);
          continue;
        }
        t = v as Matrix;
        break;
      case 'translate':
        t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
        break;
      case 'scale':
        t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const cos = Math.cos(rad),
          sin = Math.sin(rad),
          cx = v[1] ?? 0,
          cy = v[2] ?? 0;
        t = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(rad), 1, 0, 0];
        break;
      default:
        t = [1, Math.tan(rad), 0, 1, 0, 0];
    }
    m = multiply(m, t);
  }
  return m;
}

/** Endpoint arc to cubic Béziers of at most 90 degrees (SVG implementation notes, F.6.5 and F.6.6). */
function arcTo(
  out: OutlineCommand[],
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  angle: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): void {
  if (x1 === x2 && y1 === y2) return;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry) {
    out.push(['L', x2, y2]);
    return;
  }
  const phi = (angle * Math.PI) / 180,
    cos = Math.cos(phi),
    sin = Math.sin(phi),
    dx = (x1 - x2) / 2,
    dy = (y1 - y2) / 2,
    px = cos * dx + sin * dy,
    py = -sin * dx + cos * dy,
    lambda = (px * px) / (rx * rx) + (py * py) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px,
    den = rx * rx * py * py + ry * ry * px * px,
    coef = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den)),
    cxp = (coef * rx * py) / ry,
    cyp = (-coef * ry * px) / rx,
    cx = cos * cxp - sin * cyp + (x1 + x2) / 2,
    cy = sin * cxp + cos * cyp + (y1 + y2) / 2,
    ux = (px - cxp) / rx,
    uy = (py - cyp) / ry,
    vx = (-px - cxp) / rx,
    vy = (-py - cyp) / ry,
    start = Math.atan2(uy, ux);
  let delta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9)),
    step = delta / pieces,
    k = (4 / 3) * Math.tan(step / 4),
    map = (ex: number, ey: number): [number, number] => [
      cx + rx * cos * ex - ry * sin * ey,
      cy + rx * sin * ex + ry * cos * ey,
    ];
  for (let i = 0; i < pieces; i++) {
    const a = start + i * step,
      b = a + step,
      [c1x, c1y] = map(Math.cos(a) - k * Math.sin(a), Math.sin(a) + k * Math.cos(a)),
      [c2x, c2y] = map(Math.cos(b) + k * Math.sin(b), Math.sin(b) - k * Math.cos(b)),
      [ex, ey] = i === pieces - 1 ? [x2, y2] : map(Math.cos(b), Math.sin(b));
    out.push(['C', c1x, c1y, c2x, c2y, ex, ey]);
  }
}

/** Path data (`d`) to absolute M L Q C Z commands. Stops at the first error, keeping what came before (SVG rule). */
function parsePathData(d: string, warnings: string[]): OutlineCommand[] {
  const out: OutlineCommand[] = [];
  let pos = 0,
    command = '',
    x = 0,
    y = 0,
    sx = 0,
    sy = 0,
    // Last control point of a C/S or Q/T, for the reflected S and T.
    lastCubic: [number, number] | null = null,
    lastQuad: [number, number] | null = null;
  const skip = () => {
    while (pos < d.length && /[\s,]/.test(d[pos])) pos++;
  };
  const num = (): number => {
    skip();
    NUMBER.lastIndex = pos;
    const match = NUMBER.exec(d);
    if (!match) throw new LoaderError(F, 'syntax', `expected a number at "${d.slice(pos, pos + 16)}"`);
    pos = NUMBER.lastIndex;
    return Number(match[0]);
  };
  const flag = (): boolean => {
    skip();
    const c = d[pos++];
    if (c !== '0' && c !== '1')
      throw new LoaderError(F, 'syntax', `expected an arc flag 0 or 1 at "${d.slice(pos - 1, pos + 15)}"`);
    return c === '1';
  };
  try {
    for (;;) {
      skip();
      if (pos >= d.length) break;
      if (/[MmZzLlHhVvCcSsQqTtAa]/.test(d[pos])) command = d[pos++];
      else if (!command)
        throw new LoaderError(F, 'syntax', `path data starts with "${d.slice(pos, pos + 16)}", not a command`);
      else if (command === 'Z' || command === 'z')
        throw new LoaderError(F, 'syntax', `unexpected "${d.slice(pos, pos + 16)}" after Z`);
      const relative = command === command.toLowerCase(),
        ox = relative ? x : 0,
        oy = relative ? y : 0;
      let cubic: [number, number] | null = null,
        quad: [number, number] | null = null;
      switch (command.toUpperCase()) {
        case 'M':
          x = sx = ox + num();
          y = sy = oy + num();
          out.push(['M', x, y]);
          // Further pairs after a move are lines.
          command = relative ? 'l' : 'L';
          break;
        case 'Z':
          out.push(['Z']);
          x = sx;
          y = sy;
          break;
        case 'L':
          x = ox + num();
          y = oy + num();
          out.push(['L', x, y]);
          break;
        case 'H':
          x = ox + num();
          out.push(['L', x, y]);
          break;
        case 'V':
          y = oy + num();
          out.push(['L', x, y]);
          break;
        case 'C':
        case 'S': {
          const upper = command.toUpperCase(),
            [c1x, c1y] =
              upper === 'C'
                ? [ox + num(), oy + num()]
                : lastCubic
                  ? [2 * x - lastCubic[0], 2 * y - lastCubic[1]]
                  : [x, y],
            c2x = ox + num(),
            c2y = oy + num();
          x = ox + num();
          y = oy + num();
          out.push(['C', c1x, c1y, c2x, c2y, x, y]);
          cubic = [c2x, c2y];
          break;
        }
        case 'Q':
        case 'T': {
          let cx = x,
            cy = y;
          if (command.toUpperCase() === 'Q') {
            cx = ox + num();
            cy = oy + num();
          } else if (lastQuad) {
            cx = 2 * x - lastQuad[0];
            cy = 2 * y - lastQuad[1];
          }
          x = ox + num();
          y = oy + num();
          out.push(['Q', cx, cy, x, y]);
          quad = [cx, cy];
          break;
        }
        case 'A': {
          const rx = num(),
            ry = num(),
            angle = num(),
            large = flag(),
            sweep = flag(),
            ex = ox + num(),
            ey = oy + num();
          arcTo(out, x, y, rx, ry, angle, large, sweep, ex, ey);
          x = ex;
          y = ey;
          break;
        }
      }
      lastCubic = cubic;
      lastQuad = quad;
      if (out.length > MAX_COMMANDS) throw new LoaderError(F, 'limit', `path data exceeds ${MAX_COMMANDS} commands`);
    }
  } catch (error) {
    if (!(error instanceof LoaderError) || error.code !== 'syntax') throw error;
    warnings.push(`path data error, the rest of the path is skipped: ${error.message}`);
  }
  return out;
}

function ellipse(cx: number, cy: number, rx: number, ry: number): OutlineCommand[] {
  if (!(rx > 0 && ry > 0)) return [];
  const out: OutlineCommand[] = [['M', cx + rx, cy]];
  arcTo(out, cx + rx, cy, rx, ry, 0, false, true, cx - rx, cy);
  arcTo(out, cx - rx, cy, rx, ry, 0, false, true, cx + rx, cy);
  out.push(['Z']);
  return out;
}

function transformCommands(commands: readonly OutlineCommand[], m: Matrix): OutlineCommand[] {
  const p = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  return commands.map((c): OutlineCommand => {
    switch (c[0]) {
      case 'M':
      case 'L':
        return [c[0], ...p(c[1], c[2])];
      case 'Q':
        return ['Q', ...p(c[1], c[2]), ...p(c[3], c[4])];
      case 'C':
        return ['C', ...p(c[1], c[2]), ...p(c[3], c[4]), ...p(c[5], c[6])];
      default:
        return ['Z'];
    }
  });
}

/** Flattens commands into polylines: each with its points (x y pairs) and whether it was closed by Z. */
function polylines(commands: readonly OutlineCommand[], divisions: number): { points: number[]; closed: boolean }[] {
  const out: { points: number[]; closed: boolean }[] = [];
  let current: number[] = [],
    drawn = false,
    x = 0,
    y = 0;
  const push = (px: number, py: number) => {
    const n = current.length;
    if (!n || current[n - 2] !== px || current[n - 1] !== py) current.push(px, py);
  };
  const finish = (closed: boolean) => {
    if (
      closed &&
      current.length > 2 &&
      current[0] === current[current.length - 2] &&
      current[1] === current[current.length - 1]
    )
      current.length -= 2;
    // A lone move draws nothing; a zero-length segment still draws its caps.
    if (drawn && current.length >= 2) out.push({ points: current, closed: closed && current.length >= 6 });
    drawn = false;
  };
  for (const c of commands) {
    switch (c[0]) {
      case 'M':
        finish(false);
        current = [];
        x = c[1];
        y = c[2];
        push(x, y);
        break;
      case 'L':
        x = c[1];
        y = c[2];
        push(x, y);
        drawn = true;
        break;
      case 'Q':
        drawn = true;
        for (let i = 1; i <= divisions; i++) {
          const t = i / divisions,
            u = 1 - t;
          push(u * u * x + 2 * u * t * c[1] + t * t * c[3], u * u * y + 2 * u * t * c[2] + t * t * c[4]);
        }
        x = c[3];
        y = c[4];
        break;
      case 'C':
        drawn = true;
        for (let i = 1; i <= divisions; i++) {
          const t = i / divisions,
            u = 1 - t;
          push(
            u * u * u * x + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5],
            u * u * u * y + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
          );
        }
        x = c[5];
        y = c[6];
        break;
      case 'Z': {
        const start = current.slice(0, 2);
        drawn = drawn || current.length > 0;
        finish(true);
        current = start;
        if (start.length) [x, y] = start;
        break;
      }
    }
  }
  finish(false);
  return out;
}

/** Stroke triangles (x y per vertex, three vertices per triangle) of one polyline. */
function strokePolyline(
  points: number[],
  closed: boolean,
  half: number,
  join: SVGPath['strokeLineJoin'],
  cap: SVGPath['strokeLineCap'],
  miterLimit: number,
  divisions: number,
  out: number[],
): void {
  const n = points.length / 2;
  const fan = (cx: number, cy: number, from: number, sweep: number) => {
    const steps = Math.max(1, Math.ceil((Math.abs(sweep) / (Math.PI / 2)) * divisions));
    for (let i = 0; i < steps; i++) {
      const a = from + (sweep * i) / steps,
        b = from + (sweep * (i + 1)) / steps;
      out.push(
        cx,
        cy,
        cx + half * Math.cos(a),
        cy + half * Math.sin(a),
        cx + half * Math.cos(b),
        cy + half * Math.sin(b),
      );
    }
  };
  if (n === 1) {
    // A zero-length subpath draws only round or square caps.
    const [px, py] = points;
    if (cap === 'round') fan(px, py, 0, 2 * Math.PI);
    else if (cap === 'square')
      out.push(
        px - half,
        py - half,
        px + half,
        py - half,
        px + half,
        py + half,
        px - half,
        py - half,
        px + half,
        py + half,
        px - half,
        py + half,
      );
    return;
  }
  const segments = closed ? n : n - 1,
    dir: [number, number][] = [];
  for (let i = 0; i < segments; i++) {
    const ax = points[i * 2],
      ay = points[i * 2 + 1],
      bx = points[((i + 1) % n) * 2],
      by = points[((i + 1) % n) * 2 + 1],
      l = Math.hypot(bx - ax, by - ay);
    dir.push([(bx - ax) / l, (by - ay) / l]);
    const nx = (-(by - ay) / l) * half,
      ny = ((bx - ax) / l) * half;
    out.push(
      ax + nx,
      ay + ny,
      ax - nx,
      ay - ny,
      bx + nx,
      by + ny,
      bx + nx,
      by + ny,
      ax - nx,
      ay - ny,
      bx - nx,
      by - ny,
    );
  }
  // Joins at interior vertices (and at the closing vertex).
  for (let v = closed ? 0 : 1; v < (closed ? n : n - 1); v++) {
    const [d0x, d0y] = dir[(v - 1 + segments) % segments],
      [d1x, d1y] = dir[v],
      cross = d0x * d1y - d0y * d1x,
      dot = d0x * d1x + d0y * d1y;
    if (Math.abs(cross) < 1e-12 && dot > 0) continue;
    const px = points[v * 2],
      py = points[v * 2 + 1],
      // The outer side is opposite the turn.
      s = cross > 0 ? -1 : 1,
      ax = -d0y * s,
      ay = d0x * s,
      bx = -d1y * s,
      by = d1x * s;
    if (join === 'round') {
      const from = Math.atan2(ay, ax);
      let sweep = Math.atan2(by, bx) - from;
      if (sweep > Math.PI) sweep -= 2 * Math.PI;
      if (sweep < -Math.PI) sweep += 2 * Math.PI;
      fan(px, py, from, sweep);
      continue;
    }
    out.push(px, py, px + ax * half, py + ay * half, px + bx * half, py + by * half);
    if (join === 'miter') {
      const mx = ax + bx,
        my = ay + by,
        ml = Math.hypot(mx, my),
        cosHalf = ml / 2;
      // Miter length / stroke width = 1 / sin(theta / 2) = 1 / cos(half the angle between the normals).
      if (ml > 1e-12 && 1 / cosHalf <= miterLimit) {
        const tip = half / cosHalf;
        out.push(
          px + ax * half,
          py + ay * half,
          px + (mx / ml) * tip,
          py + (my / ml) * tip,
          px + bx * half,
          py + by * half,
        );
      }
    }
  }
  if (closed || cap === 'butt') return;
  for (const [index, d, sign] of [
    [0, dir[0], -1],
    [n - 1, dir[segments - 1], 1],
  ] as const) {
    const px = points[index * 2],
      py = points[index * 2 + 1],
      nx = -d[1] * half,
      ny = d[0] * half;
    if (cap === 'round') fan(px, py, Math.atan2(ny, nx), sign * -Math.PI);
    else {
      const ex = d[0] * half * sign,
        ey = d[1] * half * sign;
      out.push(px + nx, py + ny, px - nx, py - ny, px + nx + ex, py + ny + ey);
      out.push(px + nx + ex, py + ny + ey, px - nx, py - ny, px - nx + ex, py - ny + ey);
    }
  }
}

class Drawn implements SVGPath {
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
  constructor(
    element: string,
    private readonly local: OutlineCommand[],
    private readonly matrix: Matrix,
  ) {
    this.element = element;
    this.commands = transformCommands(local, matrix);
  }
  toShapes(options: SVGShapeOptions = {}): Shape[] {
    return outlineShapes(this.commands, this.fillRule, options.flipY ? (x, y) => [x, -y] : undefined);
  }
  toStrokeGeometry(options: SVGStrokeOptions = {}): GeometryData {
    const width = options.width ?? this.strokeWidth,
      divisions = options.divisions ?? 12;
    if (!Number.isFinite(width) || width < 0) throw new RangeError(`stroke width ${width} must be 0 or more`);
    if (!Number.isInteger(divisions) || divisions < 1)
      throw new RangeError(`divisions ${divisions} must be a positive integer`);
    const flat: number[] = [];
    if (width > 0)
      for (const line of polylines(this.local, divisions))
        strokePolyline(
          line.points,
          line.closed,
          width / 2,
          this.strokeLineJoin,
          this.strokeLineCap,
          this.strokeMiterLimit,
          divisions,
          flat,
        );
    const m = this.matrix,
      sign = options.flipY ? -1 : 1,
      positions: number[] = [],
      uvs: number[] = [];
    for (let i = 0; i < flat.length; i += 6) {
      const tri: number[] = [];
      for (let k = 0; k < 6; k += 2) {
        const x = flat[i + k],
          y = flat[i + k + 1];
        tri.push(m[0] * x + m[2] * y + m[4], sign * (m[1] * x + m[3] * y + m[5]));
      }
      const area = (tri[2] - tri[0]) * (tri[5] - tri[1]) - (tri[4] - tri[0]) * (tri[3] - tri[1]);
      if (!(Math.abs(area) > 0)) continue;
      // Counter-clockwise, facing +z.
      const order = area > 0 ? [0, 2, 4] : [0, 4, 2];
      for (const o of order) {
        positions.push(tri[o], tri[o + 1], 0);
        uvs.push(tri[o], tri[o + 1]);
      }
    }
    const count = positions.length / 3,
      normals = new Float32Array(count * 3);
    for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
    return geometryData(
      positions,
      normals,
      uvs,
      Array.from({ length: count }, (_, i) => i),
    );
  }
}

/**
 * Parses an SVG document (three.js `SVGLoader`): `path` with every command (M L H V C S Q T A Z, absolute and
 * relative), `rect` (rounded too), `circle`, `ellipse`, `line`, `polyline` and `polygon`, inside nested `g`, `a`,
 * `svg` viewports and `use` copies of `defs` or `symbol` content, with `transform` lists (matrix, translate, scale,
 * rotate, skewX, skewY). Styles come from presentation attributes, `style` attributes and simple `<style>` rules, with
 * inheritance: fill and stroke colours, their opacities, `opacity`, `fill-rule`, stroke width, joins, caps and miter
 * limit, `display` and `visibility`. Each path's `toShapes()` gives filled `Shape`s with holes from its fill rule, and
 * `toStrokeGeometry()` the stroke outline as triangles. Coordinates are root user units, y down. Text, images,
 * clipping, masks, markers, filters and dashes are not drawn (gradients become their average stop colour); each is
 * listed in `warnings`. Malformed XML throws a `LoaderError`.
 */
export function parseSVG(input: string | BinaryInput): LoadedSVG {
  const text = typeof input === 'string' ? input : decodeXML(toBytes(input, F)),
    tree = readXMLTree(text, F),
    warnings: string[] = [],
    warn = (message: string) => {
      if (!warnings.includes(message)) warnings.push(message);
    };
  const root = tree.children.find((e) => e.name === 'svg');
  if (!root) throw new LoaderError(F, 'header', 'the document has no <svg> root element; pass an SVG file');
  const byId = new Map<string, XMLElement>(),
    rules: Rule[] = [];
  const index = (element: XMLElement) => {
    if (element.attributes.id && !byId.has(element.attributes.id)) byId.set(element.attributes.id, element);
    if (element.name === 'style') parseCSS(element.text, rules, warnings);
    for (const child of element.children) index(child);
  };
  index(root);
  const viewBox = numbers(root.attributes.viewBox),
    box = viewBox.length === 4 ? (viewBox as [number, number, number, number]) : undefined,
    width = root.attributes.width !== undefined ? length(root.attributes.width) : undefined,
    height = root.attributes.height !== undefined ? length(root.attributes.height) : undefined,
    viewW = box?.[2] ?? width ?? 100,
    viewH = box?.[3] ?? height ?? 100,
    diagonal = Math.hypot(viewW, viewH) / Math.SQRT2;
  const paths: SVGPath[] = [];
  let total = 0;

  const styleOf = (element: XMLElement, parent: Style): Style => {
    const style: Style = Object.create(null);
    for (const name of INHERITED) if (parent[name] !== undefined) style[name] = parent[name];
    const set = (name: string, value: string) => {
      style[name] = value === 'inherit' ? parent[name] : value;
    };
    for (const name of PROPERTIES)
      if (element.attributes[name] !== undefined) set(name, element.attributes[name].trim());
    const classes = (element.attributes.class ?? '').split(/\s+/).filter(Boolean);
    const matching = rules
      .filter(
        (rule) =>
          (!rule.tag || rule.tag === element.name) &&
          (!rule.id || rule.id === element.attributes.id) &&
          rule.classes.every((c) => classes.includes(c)),
      )
      .sort((a, b) => a.specificity - b.specificity || a.order - b.order);
    for (const rule of matching) for (const [name, value] of rule.declarations) set(name, value);
    if (element.attributes.style) for (const [name, value] of declarations(element.attributes.style)) set(name, value);
    return style;
  };

  const paint = (value: string | undefined, current: string | undefined, what: string): RGBA | null => {
    if (value === undefined || value === 'none') return null;
    if (value.toLowerCase() === 'currentcolor') return paint(current ?? 'black', undefined, what);
    const url = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)\s*(.*)$/.exec(value);
    if (url) {
      let gradient = byId.get(url[1]);
      for (let hops = 0; gradient && hops < 8; hops++) {
        const stops = gradient.children.filter((c) => c.name === 'stop');
        if (stops.length) {
          const colors = stops.map((stop) => {
            const own = styleOfStop(stop),
              color = parseColor(own.color ?? 'black') ?? [0, 0, 0, 1];
            return [color[0], color[1], color[2], color[3] * own.opacity] as RGBA;
          });
          warn(`gradient #${url[1]} is drawn as its average stop colour`);
          return colors
            .reduce((sum, c) => sum.map((v, i) => v + c[i]) as RGBA, [0, 0, 0, 0] as RGBA)
            .map((v) => v / colors.length) as RGBA;
        }
        const href = gradient.attributes.href ?? gradient.attributes['xlink:href'];
        gradient = href?.startsWith('#') ? byId.get(href.slice(1)) : undefined;
      }
      warn(`${what} url(#${url[1]}) is not a gradient with stops; its fallback is used`);
      return url[2] ? paint(url[2], current, what) : null;
    }
    const color = parseColor(value);
    if (!color) warn(`${what} "${value.slice(0, 40)}" is not a colour; drawn as none`);
    return color ?? null;
  };
  const styleOfStop = (stop: XMLElement): { color?: string; opacity: number } => {
    const own: Style = Object.create(null);
    for (const name of ['stop-color', 'stop-opacity'])
      if (stop.attributes[name] !== undefined) own[name] = stop.attributes[name];
    for (const part of (stop.attributes.style ?? '').split(';')) {
      const colon = part.indexOf(':'),
        name = part.slice(0, colon).trim();
      if (name === 'stop-color' || name === 'stop-opacity') own[name] = part.slice(colon + 1).trim();
    }
    return { color: own['stop-color'], opacity: opacity(own['stop-opacity']) };
  };
  const opacity = (value: string | undefined): number => {
    if (value === undefined) return 1;
    const number = value.trim().endsWith('%') ? parseFloat(value) / 100 : parseFloat(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 1;
  };

  const viewport = (element: XMLElement): Matrix => {
    const x = length(element.attributes.x, viewW),
      y = length(element.attributes.y, viewH),
      box = numbers(element.attributes.viewBox);
    let m: Matrix = [1, 0, 0, 1, x, y];
    if (box.length === 4 && box[2] > 0 && box[3] > 0) {
      const w = length(element.attributes.width, viewW, box[2]),
        h = length(element.attributes.height, viewH, box[3]),
        aspect = (element.attributes.preserveAspectRatio ?? 'xMidYMid meet').trim().split(/\s+/);
      let sx = w / box[2],
        sy = h / box[3],
        tx = 0,
        ty = 0;
      if (aspect[0] !== 'none') {
        sx = sy = aspect[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
        const align = aspect[0];
        tx = align.includes('xMid') ? (w - box[2] * sx) / 2 : align.includes('xMax') ? w - box[2] * sx : 0;
        ty = align.includes('YMid') ? (h - box[3] * sy) / 2 : align.includes('YMax') ? h - box[3] * sy : 0;
      }
      m = multiply(m, [sx, 0, 0, sy, tx - box[0] * sx, ty - box[1] * sy]);
    }
    return m;
  };

  const shapeCommands = (element: XMLElement): OutlineCommand[] | undefined => {
    const a = element.attributes;
    switch (element.name) {
      case 'path':
        return parsePathData(a.d ?? '', warnings);
      case 'rect': {
        const x = length(a.x, viewW),
          y = length(a.y, viewH),
          w = length(a.width, viewW),
          h = length(a.height, viewH);
        if (!(w > 0 && h > 0)) return [];
        let rx = length(a.rx, viewW, NaN),
          ry = length(a.ry, viewH, NaN);
        if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
        if (Number.isNaN(ry)) ry = rx;
        rx = Math.min(Math.max(rx, 0), w / 2);
        ry = Math.min(Math.max(ry, 0), h / 2);
        if (!rx || !ry) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
        const out: OutlineCommand[] = [
          ['M', x + rx, y],
          ['L', x + w - rx, y],
        ];
        arcTo(out, x + w - rx, y, rx, ry, 0, false, true, x + w, y + ry);
        out.push(['L', x + w, y + h - ry]);
        arcTo(out, x + w, y + h - ry, rx, ry, 0, false, true, x + w - rx, y + h);
        out.push(['L', x + rx, y + h]);
        arcTo(out, x + rx, y + h, rx, ry, 0, false, true, x, y + h - ry);
        out.push(['L', x, y + ry]);
        arcTo(out, x, y + ry, rx, ry, 0, false, true, x + rx, y);
        out.push(['Z']);
        return out;
      }
      case 'circle': {
        const r = length(a.r, diagonal);
        return ellipse(length(a.cx, viewW), length(a.cy, viewH), r, r);
      }
      case 'ellipse':
        return ellipse(length(a.cx, viewW), length(a.cy, viewH), length(a.rx, viewW), length(a.ry, viewH));
      case 'line':
        return [
          ['M', length(a.x1, viewW), length(a.y1, viewH)],
          ['L', length(a.x2, viewW), length(a.y2, viewH)],
        ];
      case 'polyline':
      case 'polygon': {
        const v = numbers(a.points);
        if (v.length % 2) warn(`${element.name} points have an odd count; the last number is ignored`);
        const out: OutlineCommand[] = [];
        for (let i = 0; i + 1 < v.length; i += 2) out.push([i ? 'L' : 'M', v[i], v[i + 1]]);
        if (element.name === 'polygon' && out.length) out.push(['Z']);
        return out;
      }
      default:
        return undefined;
    }
  };

  const visit = (element: XMLElement, parent: Style, groupOpacity: number, matrix: Matrix, uses: XMLElement[]) => {
    if (SKIPPED.has(element.name) && !(element.name === 'symbol' && uses.length)) return;
    const style = styleOf(element, parent);
    if (style.display === 'none') return;
    let m = multiply(matrix, parseTransform(element.attributes.transform, warnings));
    const alpha = groupOpacity * opacity(style.opacity);
    switch (element.name) {
      case 'svg':
        if (element !== root) m = multiply(m, viewport(element));
        for (const child of element.children) visit(child, style, alpha, m, uses);
        return;
      case 'symbol':
        m = multiply(m, viewport({ ...element, attributes: { ...element.attributes, x: '0', y: '0' } }));
        for (const child of element.children) visit(child, style, alpha, m, uses);
        return;
      case 'g':
      case 'a':
      case 'switch':
        for (const child of element.children) visit(child, style, alpha, m, uses);
        return;
      case 'use': {
        const href = element.attributes.href ?? element.attributes['xlink:href'],
          target = href?.startsWith('#') ? byId.get(href.slice(1)) : undefined;
        if (!target) {
          warn(`<use> refers to "${String(href).slice(0, 40)}", which is not an element of this document`);
          return;
        }
        if (uses.includes(target) || uses.length >= MAX_USE_DEPTH) {
          warn(`<use> of #${href?.slice(1)} refers to itself or nests deeper than ${MAX_USE_DEPTH}; skipped`);
          return;
        }
        m = multiply(m, [1, 0, 0, 1, length(element.attributes.x, viewW), length(element.attributes.y, viewH)]);
        // A symbol's viewport takes the use's width and height.
        const sized =
          target.name === 'symbol' || target.name === 'svg'
            ? {
                ...target,
                attributes: {
                  ...target.attributes,
                  width: element.attributes.width ?? target.attributes.width,
                  height: element.attributes.height ?? target.attributes.height,
                },
              }
            : target;
        visit(sized, style, alpha, m, [...uses, target]);
        return;
      }
      case 'text':
      case 'image':
        warn(`<${element.name}> is not drawn; convert text to paths first`);
        return;
    }
    const local = shapeCommands(element);
    if (!local) {
      if (element.name !== 'svg') warn(`<${element.name}> is not a drawable element; skipped`);
      return;
    }
    if (!local.length || style.visibility === 'hidden' || style.visibility === 'collapse') return;
    total += local.length;
    if (total > MAX_COMMANDS) throw new LoaderError(F, 'limit', `the drawing exceeds ${MAX_COMMANDS} path commands`);
    const path = new Drawn(element.name, local, m),
      fill = paint(style.fill ?? 'black', style.color, 'fill'),
      stroke = paint(style.stroke, style.color, 'stroke');
    if (element.attributes.id) path.id = element.attributes.id;
    path.fill = fill && [fill[0], fill[1], fill[2]];
    path.fillOpacity = alpha * opacity(style['fill-opacity']) * (fill?.[3] ?? 1);
    path.fillRule = style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero';
    path.stroke = stroke && [stroke[0], stroke[1], stroke[2]];
    path.strokeOpacity = alpha * opacity(style['stroke-opacity']) * (stroke?.[3] ?? 1);
    path.strokeWidth = Math.max(0, length(style['stroke-width'], diagonal, 1));
    const join = style['stroke-linejoin'],
      cap = style['stroke-linecap'],
      limit = Number(style['stroke-miterlimit']);
    path.strokeLineJoin = join === 'round' || join === 'bevel' ? join : 'miter';
    path.strokeLineCap = cap === 'round' || cap === 'square' ? cap : 'butt';
    path.strokeMiterLimit = limit >= 1 ? limit : 4;
    paths.push(path);
  };
  visit(root, Object.create(null), 1, IDENTITY, []);
  const result: LoadedSVG = { paths, warnings };
  if (box) result.viewBox = box;
  if (width !== undefined) result.width = width;
  if (height !== undefined) result.height = height;
  return result;
}
