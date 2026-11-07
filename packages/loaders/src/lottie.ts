// Lottie JSON animations: keyframes, layers, precompositions, shapes, fills, strokes, gradients and trim paths.
import type { Shape } from '@margoengine/geometry/shapes';
import { hexColor } from '@margoengine/math/color';
import { type OutlineCommand, type OutlineFillRule, outlineShapes } from './outline.js';
import { LoaderError } from './types.js';
import { toText, type BinaryInput } from './util.js';

export type { OutlineCommand, OutlineFillRule } from './outline.js';

const F = 'Lottie';
const MAX_NESTING = 64;
/** Circle by four cubic curves: the handle length of one quarter turn, 4 (sqrt 2 - 1) / 3. */
const KAPPA = 0.5522847498307936;

/** Options of {@link parseLottie}. */
export interface LottieOptions {
  /** Maximum layers, counted in every composition. Default 100,000. */
  maxLayers?: number;
}

/** A gradient paint: positions in composition units. */
export interface LottieGradient {
  kind: 'linear' | 'radial';
  start: [number, number];
  end: [number, number];
  /** `[offset, r, g, b, a]`, every number 0..1, by rising offset. */
  stops: [number, number, number, number, number][];
}

/** One filled or stroked path of a frame. */
export interface LottiePath {
  kind: 'path';
  /** Outline in composition units, y down, every transform applied. */
  commands: OutlineCommand[];
  /** Solid fill, sRGB 0..1, or null. */
  fill: [number, number, number] | null;
  /** Gradient fill or stroke paint, or null. */
  gradient: LottieGradient | null;
  /** Solid stroke, sRGB 0..1, or null. */
  stroke: [number, number, number] | null;
  /** The paint's opacity times every layer and group above it, 0..1. */
  opacity: number;
  fillRule: OutlineFillRule;
  /** Stroke width in composition units, with the average scale of the transforms applied. 0 for a fill. */
  strokeWidth: number;
  lineCap: 'butt' | 'round' | 'square';
  lineJoin: 'miter' | 'round' | 'bevel';
  miterLimit: number;
  /** Dash pattern and offset in composition units, or null. */
  dash: { pattern: number[]; offset: number } | null;
  /** The filled outline as shapes, with holes decided by the fill rule. `flipY` negates y for a y-up world. */
  toShapes(options?: { flipY?: boolean }): Shape[];
}

/** One image layer of a frame. */
export interface LottieImage {
  kind: 'image';
  /** The asset's id in {@link LottieAnimation.images}. */
  asset: string;
  /** `[a, b, c, d, e, f]` from image pixels to composition units, as `setTransform` takes it. */
  matrix: [number, number, number, number, number, number];
  opacity: number;
  width: number;
  height: number;
}

/** What {@link LottieAnimation.frame} returns: everything drawn at a frame, back to front. */
export type LottieItem = LottiePath | LottieImage;

/** An image asset of the file. */
export interface LottieImageAsset {
  id: string;
  width: number;
  height: number;
  /** The folder and file name, or the whole `data:` URL when the file embeds it. */
  path: string;
  embedded: boolean;
}

/** The part of `CanvasRenderingContext2D` that {@link LottieAnimation.draw} uses. */
export interface LottieCanvas {
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void;
  quadraticCurveTo(a: number, b: number, c: number, d: number): void;
  closePath(): void;
  fill(rule?: 'nonzero' | 'evenodd'): void;
  stroke(): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setLineDash(pattern: number[]): void;
  drawImage(image: never, x: number, y: number, width: number, height: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): LottieCanvasGradient;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): LottieCanvasGradient;
  fillStyle: unknown;
  strokeStyle: unknown;
  globalAlpha: number;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  lineDashOffset: number;
}

/** The gradient object of a {@link LottieCanvas}. */
export interface LottieCanvasGradient {
  addColorStop(offset: number, color: string): void;
}

/** Options of {@link LottieAnimation.draw}. */
export interface LottieDrawOptions {
  /** Loaded images by asset id, for `drawImage`. An image layer with none is left out. */
  images?: Record<string, unknown>;
}

/** What {@link parseLottie} returns. */
export interface LottieAnimation {
  /** The Lottie version the file names, such as `5.7.4`. */
  version: string;
  name: string;
  /** Composition size in pixels. */
  width: number;
  height: number;
  /** Frames per second. */
  frameRate: number;
  /** First frame, inclusive. */
  inFrame: number;
  /** End frame, exclusive. */
  outFrame: number;
  /** Seconds from first to end frame. */
  duration: number;
  images: LottieImageAsset[];
  /** Named time ranges, in frames. */
  markers: { name: string; time: number; duration: number }[];
  /** Features of the file that frames leave out, such as `text layer` or `mask`. Empty when none. */
  unsupported: string[];
  /** Everything drawn at `frame`, back to front. Any number: a fraction blends between keyframes. */
  frame(frame: number): LottieItem[];
  /** Draws `frame` onto a 2D canvas context, in composition units. Upload the canvas to get a texture. */
  draw(context: LottieCanvas, frame: number, options?: LottieDrawOptions): void;
}

// The file is free-form JSON, read through these narrow views.
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);
const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/** A path of cubic segments: vertices, in and out handles relative to their vertex, closed or not. */
interface Bezier {
  v: number[][];
  i: number[][];
  o: number[][];
  c: boolean;
}

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
const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
const meanScale = (m: Matrix): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

/** The y of a CSS-style cubic ease from (0,0) to (1,1) with handles (x1,y1) and (x2,y2), at x. */
function ease(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const curve = (a: number, b: number, t: number): number =>
    3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  // x rises with t for handles inside 0..1, so bisection always finds it; 40 halvings pass double precision of frames.
  let low = 0,
    high = 1;
  for (let step = 0; step < 40; step++) {
    const middle = (low + high) / 2;
    if (curve(x1, x2, middle) < x) low = middle;
    else high = middle;
  }
  return curve(y1, y2, (low + high) / 2);
}

const pick = (value: unknown, index: number, fallback: number): number =>
  Array.isArray(value) ? num(value[index] ?? value[0], fallback) : num(value, fallback);

/** A value at keyframes: numbers, arrays of numbers, or a bezier path. */
type Sample = number[] | Bezier;

const asBezier = (value: unknown): Bezier | null => {
  const source = Array.isArray(value) ? value[0] : value;
  if (!isObject(source) || !Array.isArray(source.v)) return null;
  const points = (name: string): number[][] =>
    (source.v as unknown[]).map((_, n) => {
      const point = (source[name] as unknown[] | undefined)?.[n];
      return Array.isArray(point) ? [num(point[0], 0), num(point[1], 0)] : [0, 0];
    });
  return { v: points('v'), i: points('i'), o: points('o'), c: source.c === true };
};

const asSample = (value: unknown): Sample => {
  const path = asBezier(value);
  if (path) return path;
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.map((item) => num(item, 0));
  return [0];
};

const blend = (a: Sample, b: Sample, t: (index: number) => number): Sample => {
  if (Array.isArray(a) && Array.isArray(b)) return a.map((value, n) => value + ((b[n] ?? value) - value) * t(n));
  if (Array.isArray(a) || Array.isArray(b)) return a;
  if (a.v.length !== b.v.length) return a;
  const mix = (p: number[][], q: number[][]): number[][] =>
    p.map((point, n) => [point[0]! + (q[n]![0]! - point[0]!) * t(0), point[1]! + (q[n]![1]! - point[1]!) * t(0)]);
  return { v: mix(a.v, b.v), i: mix(a.i, b.i), o: mix(a.o, b.o), c: a.c };
};

interface Key {
  time: number;
  start: Sample;
  end: Sample | null;
  hold: boolean;
  /** Ease handles per dimension: `[x1, y1, x2, y2]`. */
  easing: (dimension: number) => [number, number, number, number];
  /** Handles of a spatial curve, relative to the start and end values. */
  spatial: { out: number[]; in: number[] } | null;
  /** Distance along the spatial curve at each of its {@link CURVE_STEPS} steps, filled on first use. */
  lengths?: Float64Array;
}

/** Steps of the table that turns distance along a spatial curve into its parameter. */
const CURVE_STEPS = 128;

/**
 * A position on the spatial curve of `key`. The ease gives the share of the distance travelled, as an After Effects
 * motion path does, so a straight path with zero handles is a plain straight move.
 */
function alongCurve(key: Key, start: number[], end: number[], share: number): number[] {
  const { out, in: back } = key.spatial!,
    point = (t: number): number[] => {
      const u = 1 - t;
      return start.map((p0, n) => {
        const p3 = end[n] ?? p0;
        return u * u * u * p0 + 3 * u * u * t * (p0 + (out[n] ?? 0)) + 3 * u * t * t * (p3 + (back[n] ?? 0)) + t * t * t * p3;
      });
    };
  let lengths = key.lengths;
  if (!lengths) {
    lengths = key.lengths = new Float64Array(CURVE_STEPS + 1);
    let before = point(0);
    for (let n = 1; n <= CURVE_STEPS; n++) {
      const here = point(n / CURVE_STEPS);
      lengths[n] = lengths[n - 1]! + Math.hypot(...here.map((value, k) => value - before[k]!));
      before = here;
    }
  }
  const total = lengths[CURVE_STEPS]!;
  if (!(total > 0)) return start;
  const wanted = share * total;
  // An ease that overshoots runs on along the curve's end.
  let low = 0;
  if (wanted >= total) low = CURVE_STEPS - 1;
  else if (wanted > 0) {
    let high = CURVE_STEPS;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (lengths[middle]! <= wanted) low = middle;
      else high = middle;
    }
  }
  const span = lengths[low + 1]! - lengths[low]!,
    a = point(low / CURVE_STEPS),
    b = point((low + 1) / CURVE_STEPS),
    t = span > 0 ? (wanted - lengths[low]!) / span : 0;
  return a.map((value, k) => value + (b[k]! - value) * t);
}

/** A property: a constant, or keyframes with their easing. */
class Property {
  private readonly keys: Key[] = [];
  private readonly constant: Sample;

  constructor(raw: unknown, fallback: number[]) {
    const source = isObject(raw) ? raw : {},
      value = source.k;
    this.constant = value === undefined ? fallback : asSample(value);
    if (!Array.isArray(value) || !isObject(value[0]) || value[0].t === undefined) return;
    const keys = list(value);
    keys.forEach((key, n) => {
      const next = keys[n + 1],
        start = key.s === undefined ? asSample((keys[n - 1] ?? key).e) : asSample(key.s),
        end = key.e !== undefined ? asSample(key.e) : next?.s !== undefined ? asSample(next.s) : null,
        ein = isObject(key.i) ? key.i : {},
        eout = isObject(key.o) ? key.o : {},
        out = key.to,
        back = key.ti;
      this.keys.push({
        time: num(key.t, 0),
        start,
        end,
        hold: key.h === 1,
        easing: (d) => [pick(eout.x, d, 0), pick(eout.y, d, 0), pick(ein.x, d, 1), pick(ein.y, d, 1)],
        spatial:
          Array.isArray(out) && Array.isArray(back)
            ? { out: out.map((item) => num(item, 0)), in: back.map((item) => num(item, 0)) }
            : null,
      });
    });
  }

  get animated(): boolean {
    return this.keys.length > 0;
  }

  at(frame: number): Sample {
    const { keys } = this;
    if (!keys.length) return this.constant;
    if (frame <= keys[0]!.time) return keys[0]!.start;
    let index = keys.length - 1;
    while (index > 0 && keys[index]!.time > frame) index--;
    const key = keys[index]!,
      next = keys[index + 1];
    if (!next || key.end === null) return key.end && !next ? key.end : key.start;
    if (key.hold) return key.start;
    const span = next.time - key.time,
      x = span > 0 ? (frame - key.time) / span : 1,
      eased = (d: number): number => {
        const [x1, y1, x2, y2] = key.easing(d);
        return ease(x1, y1, x2, y2, x);
      };
    const { start, end } = key;
    if (key.spatial && Array.isArray(start) && Array.isArray(end)) return alongCurve(key, start, end, eased(0));
    return blend(start, end, eased);
  }

  numbers(frame: number): number[] {
    const value = this.at(frame);
    return Array.isArray(value) ? value : [0];
  }

  number(frame: number): number {
    return this.numbers(frame)[0] ?? 0;
  }

  path(frame: number): Bezier | null {
    const value = this.at(frame);
    return Array.isArray(value) ? null : value;
  }
}

/** A layer or group transform: anchor, position, scale, rotation, skew, opacity. */
class Transform {
  private readonly anchor: Property;
  private readonly position: Property | null;
  private readonly axes: [Property, Property] | null;
  private readonly scale: Property;
  private readonly rotation: Property;
  private readonly skew: Property;
  private readonly skewAxis: Property;
  private readonly alpha: Property;

  constructor(raw: unknown) {
    const source = isObject(raw) ? raw : {},
      position = isObject(source.p) ? source.p : {};
    this.anchor = new Property(source.a, [0, 0, 0]);
    this.axes = position.s === true ? [new Property(position.x, [0]), new Property(position.y, [0])] : null;
    this.position = this.axes ? null : new Property(source.p, [0, 0, 0]);
    this.scale = new Property(source.s, [100, 100, 100]);
    this.rotation = new Property(source.r ?? source.rz, [0]);
    this.skew = new Property(source.sk, [0]);
    this.skewAxis = new Property(source.sa, [0]);
    this.alpha = new Property(source.o, [100]);
  }

  matrix(frame: number): Matrix {
    const [ax = 0, ay = 0] = this.anchor.numbers(frame),
      [px = 0, py = 0] = this.axes
        ? [this.axes[0].number(frame), this.axes[1].number(frame)]
        : this.position!.numbers(frame),
      [sx = 100, sy = 100] = this.scale.numbers(frame),
      turn = (this.rotation.number(frame) * Math.PI) / 180,
      skew = (-this.skew.number(frame) * Math.PI) / 180,
      axis = (this.skewAxis.number(frame) * Math.PI) / 180,
      cos = Math.cos(turn),
      sin = Math.sin(turn);
    let local: Matrix = [cos, sin, -sin, cos, px, py];
    if (skew !== 0) {
      const c = Math.cos(axis),
        s = Math.sin(axis);
      local = multiply(local, [c, s, -s, c, 0, 0]);
      local = multiply(local, [1, 0, Math.tan(skew), 1, 0, 0]);
      local = multiply(local, [c, -s, s, c, 0, 0]);
    }
    local = multiply(local, [sx / 100, 0, 0, sy / 100, 0, 0]);
    return multiply(local, [1, 0, 0, 1, -ax, -ay]);
  }

  opacity(frame: number): number {
    return this.alpha.number(frame) / 100;
  }
}

/** Bezier vertices of an axis-aligned rectangle, clockwise from the top right, as After Effects draws it. */
function rectangle(cx: number, cy: number, w: number, h: number, radius: number): Bezier {
  const x = w / 2,
    y = h / 2,
    r = Math.min(radius, x, y),
    k = r * (1 - KAPPA);
  if (r <= 0) {
    const v = [
      [cx + x, cy - y],
      [cx + x, cy + y],
      [cx - x, cy + y],
      [cx - x, cy - y],
    ];
    return { v, i: v.map(() => [0, 0]), o: v.map(() => [0, 0]), c: true };
  }
  const h0 = r - k,
    v = [
      [cx + x - r, cy - y],
      [cx + x, cy - y + r],
      [cx + x, cy + y - r],
      [cx + x - r, cy + y],
      [cx - x + r, cy + y],
      [cx - x, cy + y - r],
      [cx - x, cy - y + r],
      [cx - x + r, cy - y],
    ],
    o = [
      [h0, 0],
      [0, 0],
      [0, h0],
      [0, 0],
      [-h0, 0],
      [0, 0],
      [0, -h0],
      [0, 0],
    ],
    i = [
      [0, 0],
      [0, -h0],
      [0, 0],
      [h0, 0],
      [0, 0],
      [0, h0],
      [0, 0],
      [-h0, 0],
    ];
  return { v, i, o, c: true };
}

function ellipse(cx: number, cy: number, w: number, h: number): Bezier {
  const x = w / 2,
    y = h / 2,
    kx = x * KAPPA,
    ky = y * KAPPA;
  return {
    v: [
      [cx, cy - y],
      [cx + x, cy],
      [cx, cy + y],
      [cx - x, cy],
    ],
    i: [
      [-kx, 0],
      [0, -ky],
      [kx, 0],
      [0, ky],
    ],
    o: [
      [kx, 0],
      [0, ky],
      [-kx, 0],
      [0, -ky],
    ],
    c: true,
  };
}

/** Polygon or star, its first point straight up from the centre before `rotation` (radians). */
function star(cx: number, cy: number, points: number, outer: number, inner: number | null, rotation: number): Bezier {
  const v: number[][] = [],
    corners = inner === null ? points : points * 2;
  for (let n = 0; n < corners; n++) {
    const radius = inner === null || n % 2 === 0 ? outer : inner,
      angle = rotation - Math.PI / 2 + (n * 2 * Math.PI) / corners;
    v.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return { v, i: v.map(() => [0, 0]), o: v.map(() => [0, 0]), c: true };
}

const reversed = (path: Bezier): Bezier => ({
  v: [...path.v].reverse(),
  i: [...path.o].reverse(),
  o: [...path.i].reverse(),
  c: path.c,
});

/** One cubic piece of a path as eight numbers: start, control 1, control 2, end. */
type Piece = [number, number, number, number, number, number, number, number];

function pieces(path: Bezier): Piece[] {
  const out: Piece[] = [],
    count = path.v.length,
    last = path.c ? count : count - 1;
  for (let n = 0; n < last; n++) {
    const next = (n + 1) % count,
      a = path.v[n]!,
      b = path.v[next]!,
      ho = path.o[n]!,
      hi = path.i[next]!;
    out.push([a[0]!, a[1]!, a[0]! + ho[0]!, a[1]! + ho[1]!, b[0]! + hi[0]!, b[1]! + hi[1]!, b[0]!, b[1]!]);
  }
  return out;
}

const pointOn = (p: Piece, t: number): [number, number] => {
  const u = 1 - t,
    a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  return [a * p[0] + b * p[2] + c * p[4] + d * p[6], a * p[1] + b * p[3] + c * p[5] + d * p[7]];
};

/** Chords measured along a piece. A trim lands within a hundredth of a unit on a path 100 units long. */
const CHORDS = 64;

/** Distance along a piece at each of `CHORDS` even steps of its parameter, starting at 0. */
function lengths(piece: Piece): Float64Array {
  const table = new Float64Array(CHORDS + 1);
  let [x, y] = pointOn(piece, 0);
  for (let n = 1; n <= CHORDS; n++) {
    const [nx, ny] = pointOn(piece, n / CHORDS);
    table[n] = table[n - 1]! + Math.hypot(nx - x, ny - y);
    x = nx;
    y = ny;
  }
  return table;
}

/** The parameter at `distance` along a piece: a curve's speed varies, so distance is not the parameter. */
function parameterAt(table: Float64Array, distance: number): number {
  let n = 1;
  while (n < CHORDS && table[n]! < distance) n++;
  const span = table[n]! - table[n - 1]!;
  return (n - 1 + (span > 0 ? (distance - table[n - 1]!) / span : 0)) / CHORDS;
}

/** The part of a piece between parameters `t0` and `t1`, by de Casteljau subdivision. */
function cut(p: Piece, t0: number, t1: number): Piece {
  const split = (q: Piece, t: number): [Piece, Piece] => {
    const lerp = (a: number, b: number): number => a + (b - a) * t,
      [x0, y0, x1, y1, x2, y2, x3, y3] = q,
      ax = lerp(x0, x1),
      ay = lerp(y0, y1),
      bx = lerp(x1, x2),
      by = lerp(y1, y2),
      cx = lerp(x2, x3),
      cy = lerp(y2, y3),
      dx = lerp(ax, bx),
      dy = lerp(ay, by),
      ex = lerp(bx, cx),
      ey = lerp(by, cy),
      fx = lerp(dx, ex),
      fy = lerp(dy, ey);
    return [
      [x0, y0, ax, ay, dx, dy, fx, fy],
      [fx, fy, ex, ey, cx, cy, x3, y3],
    ];
  };
  const tail = t0 > 0 ? split(p, t0)[1] : p;
  return t1 < 1 ? split(tail, (t1 - t0) / (1 - t0))[0] : tail;
}

/** The stretch of a path from `from` to `to`, as fractions of its length; `from` past `to` wraps over the end. */
function trim(parts: readonly Piece[], from: number, to: number): Piece[][] {
  const tables = parts.map(lengths),
    total = tables.reduce((sum, table) => sum + table[CHORDS]!, 0);
  if (total === 0) return [];
  const take = (a: number, b: number): Piece[] => {
    const out: Piece[] = [];
    let at = 0;
    parts.forEach((part, n) => {
      const table = tables[n]!,
        size = table[CHORDS]!,
        start = Math.max(a * total - at, 0),
        end = Math.min(b * total - at, size);
      if (size > 0 && end > start) out.push(cut(part, parameterAt(table, start), parameterAt(table, end)));
      at += size;
    });
    return out;
  };
  return from <= to ? [take(from, to)] : [take(from, 1), take(0, to)];
}

interface Run {
  pieces: Piece[];
  closed: boolean;
}

const runsOf = (path: Bezier): Run => ({ pieces: pieces(path), closed: path.c });

function commandsOf(runs: readonly Run[], matrix: Matrix): OutlineCommand[] {
  const commands: OutlineCommand[] = [];
  for (const { pieces: parts, closed } of runs) {
    if (!parts.length) continue;
    const [sx, sy] = apply(matrix, parts[0]![0], parts[0]![1]);
    commands.push(['M', sx, sy]);
    for (const p of parts) {
      const [ax, ay] = apply(matrix, p[2], p[3]),
        [bx, by] = apply(matrix, p[4], p[5]),
        [cx, cy] = apply(matrix, p[6], p[7]),
        straight = p[2] === p[0] && p[3] === p[1] && p[4] === p[6] && p[5] === p[7];
      commands.push(straight ? ['L', cx, cy] : ['C', ax, ay, bx, by, cx, cy]);
    }
    if (closed) commands.push(['Z']);
  }
  return commands;
}

/** A shape under its transforms, gathered for the styles and modifiers that follow it; a modifier rewrites `runs` in place. */
interface Gathered {
  runs: Run[];
  matrix: Matrix;
}

const CAPS = ['butt', 'round', 'square'] as const;
const JOINS = ['miter', 'round', 'bevel'] as const;

/**
 * What a shape walk gives back: paths for later paints, and the items painted, top first. An item is built after the
 * walk, because a modifier reaches every shape before it in scope, also those a style has already taken.
 */
interface Walked {
  gathered: Gathered[];
  items: (() => LottiePath | null)[];
}

/** A sequential trim: every run in turn is one line, and `span` (null for none) is the stretch of it that stays. */
function trimInTurn(shapes: Gathered[], span: readonly [number, number] | null): void {
  const sizeOf = (run: Run): number => run.pieces.reduce((sum, piece) => sum + lengths(piece)[CHORDS]!, 0),
    total = shapes.reduce((sum, shape) => sum + shape.runs.reduce((all, run) => all + sizeOf(run), 0), 0);
  const stretches: [number, number][] = !span
    ? []
    : span[0] <= span[1]
      ? [[span[0], span[1]]]
      : [
          [span[0], 1],
          [0, span[1]],
        ];
  let at = 0;
  for (const shape of shapes) {
    shape.runs = shape.runs.flatMap((run) => {
      const size = sizeOf(run),
        kept: Run[] = [];
      for (const [from, to] of size > 0 ? stretches : []) {
        const a = Math.max((from * total - at) / size, 0),
          b = Math.min((to * total - at) / size, 1);
        if (b > a) for (const pieces of trim(run.pieces, a, b)) kept.push({ pieces, closed: false });
      }
      at += size;
      return kept;
    });
  }
}

/** The shape items of one list, compiled once, then walked per frame. */
class ShapeList {
  private readonly steps: ((frame: number, state: Walked, matrix: Matrix, opacity: number) => void)[] = [];
  private transform: Transform | null = null;

  constructor(raw: unknown, note: (feature: string) => void, depth: number) {
    if (depth > MAX_NESTING) throw new LoaderError(F, 'range', 'shape groups nest too deep');
    // A list is walked first to last: paints reach the paths before them, and a group's transform covers the group.
    for (const item of list(raw)) {
      if (item.hd === true) continue;
      const compile = this.compile(item, note, depth);
      if (compile) this.steps.push(compile);
    }
  }

  private compile(item: Json, note: (feature: string) => void, depth: number): ShapeList['steps'][number] | null {
    const reverse = item.d === 3;
    const push = (make: (frame: number) => Bezier | null) => (frame: number, state: Walked, matrix: Matrix) => {
      const path = make(frame);
      if (path) state.gathered.push({ runs: [runsOf(reverse ? reversed(path) : path)], matrix });
    };
    switch (item.ty) {
      case 'gr': {
        const inner = new ShapeList(item.it, note, depth + 1);
        return (frame, state, matrix, opacity) => inner.walk(frame, state, matrix, opacity);
      }
      case 'tr':
        this.transform = new Transform(item);
        return null;
      case 'sh': {
        const shape = new Property(item.ks, [0]);
        return push((frame) => shape.path(frame));
      }
      case 'rc': {
        const position = new Property(item.p, [0, 0]),
          size = new Property(item.s, [0, 0]),
          radius = new Property(item.r, [0]);
        return push((frame) => {
          const [x = 0, y = 0] = position.numbers(frame),
            [w = 0, h = 0] = size.numbers(frame);
          return rectangle(x, y, w, h, radius.number(frame));
        });
      }
      case 'el': {
        const position = new Property(item.p, [0, 0]),
          size = new Property(item.s, [0, 0]);
        return push((frame) => {
          const [x = 0, y = 0] = position.numbers(frame),
            [w = 0, h = 0] = size.numbers(frame);
          return ellipse(x, y, w, h);
        });
      }
      case 'sr': {
        const position = new Property(item.p, [0, 0]),
          points = new Property(item.pt, [5]),
          rotation = new Property(item.r, [0]),
          outer = new Property(item.or, [0]),
          inner = new Property(item.ir, [0]),
          polygon = item.sy === 2;
        if (num((item.is as Json | undefined)?.k, 0) || num((item.os as Json | undefined)?.k, 0))
          note('star roundness');
        return push((frame) => {
          const [x = 0, y = 0] = position.numbers(frame),
            count = Math.max(3, Math.round(points.number(frame)));
          return star(
            x,
            y,
            count,
            outer.number(frame),
            polygon ? null : inner.number(frame),
            (rotation.number(frame) * Math.PI) / 180,
          );
        });
      }
      case 'fl':
      case 'st':
      case 'gf':
      case 'gs':
        return this.paint(item);
      case 'tm': {
        const start = new Property(item.s, [0]),
          end = new Property(item.e, [100]),
          offset = new Property(item.o, [0]);
        const sequential = item.m === 2;
        return (frame, state) => {
          const wrap = (v: number): number => v - Math.floor(v),
            shift = offset.number(frame) / 360,
            low = Math.min(start.number(frame), end.number(frame)) / 100,
            high = Math.max(start.number(frame), end.number(frame)) / 100;
          if (high - low >= 1) return;
          const from = wrap(low + shift),
            to = wrap(high + shift);
          if (sequential) trimInTurn(state.gathered, high <= low ? null : [from, to]);
          else
            for (const shape of state.gathered)
              shape.runs =
                high <= low
                  ? []
                  : shape.runs.flatMap((run) =>
                      trim(run.pieces, from, to).map((pieces) => ({ pieces, closed: false })),
                    );
        };
      }
      default:
        note(`shape item ${str(item.ty, 'unknown')}`);
        return null;
    }
  }

  private paint(item: Json): ShapeList['steps'][number] {
    const type = item.ty,
      stroked = type === 'st' || type === 'gs',
      gradient = type === 'gf' || type === 'gs',
      color = new Property(item.c, [0, 0, 0]),
      alpha = new Property(item.o, [100]),
      width = new Property(item.w, [1]),
      start = new Property(item.s, [0, 0]),
      end = new Property(item.e, [0, 0]),
      stops = isObject(item.g) ? new Property(item.g.k, [0]) : null,
      stopCount = isObject(item.g) ? num(item.g.p, 0) : 0,
      dashes = list(item.d).map((dash) => ({ kind: str(dash.n), value: new Property(dash.v, [0]) })),
      fillRule: OutlineFillRule = item.r === 2 ? 'evenodd' : 'nonzero',
      lineCap = CAPS[num(item.lc, 2) - 1] ?? 'round',
      lineJoin = JOINS[num(item.lj, 2) - 1] ?? 'round',
      miterLimit = num(item.ml, 4),
      radial = item.t === 2;
    return (frame, state, place, opacity) => {
      const reached = [...state.gathered];
      if (!reached.length) return;
      // Stroke width, dashes and gradient ends follow the transforms over the style, whatever the shape sits under.
      const scale = meanScale(place),
        rgb = color.numbers(frame);
      let paint: LottieGradient | null = null;
      if (gradient && stops) {
        const [sx = 0, sy = 0] = start.numbers(frame),
          [ex = 0, ey = 0] = end.numbers(frame);
        paint = {
          kind: radial ? 'radial' : 'linear',
          start: apply(place, sx, sy),
          end: apply(place, ex, ey),
          stops: gradientStops(stops.numbers(frame), stopCount),
        };
      }
      let dash: LottiePath['dash'] = null;
      if (dashes.length) {
        const pattern = dashes.filter((d) => d.kind !== 'o').map((d) => d.value.number(frame) * scale),
          offset = dashes.find((d) => d.kind === 'o')?.value.number(frame) ?? 0;
        dash = { pattern, offset: offset * scale };
      }
      const solid: [number, number, number] = [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0];
      const share = opacity * (alpha.number(frame) / 100),
        strokeWidth = stroked ? width.number(frame) * scale : 0;
      state.items.push(() => {
        const commands = reached.flatMap(({ runs, matrix }) => commandsOf(runs, matrix));
        if (!commands.length) return null;
        return makePath({
          commands,
          fill: !stroked && !gradient ? solid : null,
          gradient: paint,
          stroke: stroked && !gradient ? solid : null,
          opacity: share,
          fillRule,
          strokeWidth,
          lineCap,
          lineJoin,
          miterLimit,
          dash,
        });
      });
    };
  }

  /** Runs the list; adds its paths and paints to `state`, its paths under its own transform. */
  walk(frame: number, state: Walked, matrix: Matrix, opacity: number): void {
    const local = this.transform,
      here = local ? multiply(matrix, local.matrix(frame)) : matrix,
      alpha = local ? opacity * local.opacity(frame) : opacity,
      own: Walked = { gathered: [], items: state.items };
    for (const step of this.steps) step(frame, own, here, alpha);
    state.gathered.push(...own.gathered);
  }
}

/** Gradient stops from a flat array: `count` of offset, r, g, b, then optional pairs of offset, alpha. */
function gradientStops(flat: readonly number[], count: number): LottieGradient['stops'] {
  const stops: LottieGradient['stops'] = [],
    alphas = flat.slice(count * 4),
    alphaAt = (offset: number): number => {
      if (alphas.length < 2) return 1;
      let before = 0;
      for (let n = 0; n + 3 < alphas.length; n += 2) {
        if (alphas[n + 2]! >= offset) {
          const span = alphas[n + 2]! - alphas[n]!,
            t = span > 0 ? Math.min(1, Math.max(0, (offset - alphas[n]!) / span)) : 0;
          return alphas[n + 1]! + (alphas[n + 3]! - alphas[n + 1]!) * t;
        }
        before = n + 2;
      }
      return alphas[before + 1]!;
    };
  for (let n = 0; n < count; n++) {
    const at = flat[n * 4] ?? 0;
    stops.push([at, flat[n * 4 + 1] ?? 0, flat[n * 4 + 2] ?? 0, flat[n * 4 + 3] ?? 0, alphaAt(at)]);
  }
  return stops;
}

function makePath(fields: Omit<LottiePath, 'kind' | 'toShapes'>): LottiePath {
  return {
    kind: 'path',
    ...fields,
    toShapes(options = {}) {
      return outlineShapes(fields.commands, fields.fillRule, options.flipY ? (x, y) => [x, -y] : (x, y) => [x, y]);
    },
  };
}

/** One layer, compiled. */
interface Layer {
  index: number | null;
  parent: number | null;
  inFrame: number;
  outFrame: number;
  startTime: number;
  stretch: number;
  hidden: boolean;
  transform: Transform;
  shapes: ShapeList | null;
  solid: { width: number; height: number; color: [number, number, number] } | null;
  image: string | null;
  precomp: { layers: Layer[]; remap: Property | null; width: number; height: number } | null;
}

/** Reads layers; precompositions resolve through `assets`, refusing one that contains itself. */
class Compiler {
  layers = 0;
  readonly unsupported = new Set<string>();
  readonly note = (feature: string): void => void this.unsupported.add(feature);

  constructor(
    readonly assets: Map<string, Json>,
    readonly maxLayers: number,
  ) {}

  compile(raw: unknown, open: readonly string[]): Layer[] {
    if (open.length > MAX_NESTING) throw new LoaderError(F, 'range', 'precompositions nest too deep');
    return list(raw).flatMap((item) => {
      if (++this.layers > this.maxLayers) throw new LoaderError(F, 'limit', `more than ${this.maxLayers} layers`);
      return this.layer(item, open);
    });
  }

  private layer(item: Json, open: readonly string[]): Layer[] {
    const type = item.ty,
      layer: Layer = {
        index: typeof item.ind === 'number' ? item.ind : null,
        parent: typeof item.parent === 'number' ? item.parent : null,
        inFrame: num(item.ip, 0),
        outFrame: num(item.op, Number.POSITIVE_INFINITY),
        startTime: num(item.st, 0),
        stretch: num(item.sr, 1) || 1,
        hidden: item.hd === true,
        transform: new Transform(item.ks),
        shapes: null,
        solid: null,
        image: null,
        precomp: null,
      };
    if (Array.isArray(item.masksProperties) && item.masksProperties.length) this.note('mask');
    if (item.tt) this.note('track matte');
    if (Array.isArray(item.ef) && item.ef.length) this.note('effect');
    if (item.ddd === 1) this.note('3D layer');
    if (num(item.bm, 0) !== 0) this.note('blend mode');
    switch (type) {
      case 0: {
        const id = str(item.refId),
          asset = this.assets.get(id);
        if (!asset) throw new LoaderError(F, 'syntax', `layer refers to missing asset ${id}`);
        if (open.includes(id)) throw new LoaderError(F, 'range', `precomposition ${id} contains itself`);
        layer.precomp = {
          layers: this.compile(asset.layers, [...open, id]),
          remap: item.tm === undefined ? null : new Property(item.tm, [0]),
          width: num(item.w, 0),
          height: num(item.h, 0),
        };
        break;
      }
      case 1:
        {
          const [r = 0, g = 0, b = 0] = hexColor(str(item.sc)) ?? [];
          layer.solid = { width: num(item.sw, 0), height: num(item.sh, 0), color: [r, g, b] };
        }
        break;
      case 2:
        layer.image = str(item.refId);
        break;
      case 3:
        break;
      case 4:
        layer.shapes = new ShapeList(item.shapes, this.note, 0);
        break;
      case 5:
        this.note('text layer');
        break;
      default:
        this.note(`layer type ${String(type)}`);
    }
    return [layer];
  }
}

/** A layer's matrix through its parents. */
const parentMatrix = (layer: Layer, all: readonly Layer[], frame: number): Matrix => {
  let matrix = layer.transform.matrix(frame);
  const seen = new Set<Layer>([layer]);
  for (let at = layer; at.parent !== null; ) {
    const parent = all.find((other) => other.index === at.parent);
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    matrix = multiply(parent.transform.matrix(frame), matrix);
    at = parent;
  }
  return matrix;
};

function collect(
  layers: readonly Layer[],
  frame: number,
  rate: number,
  sizes: ReadonlyMap<string, LottieImageAsset>,
  matrix: Matrix,
  opacity: number,
  out: LottieItem[],
): void {
  // The first layer is on top, so the last is drawn first.
  for (let n = layers.length - 1; n >= 0; n--) {
    const layer = layers[n]!;
    if (layer.hidden || frame < layer.inFrame || frame >= layer.outFrame) continue;
    // A layer's own keyframes are written in the time of its composition, so `st` and `sr` move only what a
    // precomposition plays inside it: a file with `st: -44` keys its layer at 44 to 89, its own in and out frames.
    const here = multiply(matrix, parentMatrix(layer, layers, frame)),
      alpha = opacity * layer.transform.opacity(frame);
    if (layer.shapes) {
      const walked: Walked = { gathered: [], items: [] };
      layer.shapes.walk(frame, walked, here, alpha);
      // Items are in paint order, top first.
      for (const item of walked.items.reverse()) {
        const path = item();
        if (path) out.push(path);
      }
    } else if (layer.solid) {
      const { width, height, color } = layer.solid;
      out.push(
        makePath({
          commands: commandsOf([runsOf(rectangle(width / 2, height / 2, width, height, 0))], here),
          fill: color,
          gradient: null,
          stroke: null,
          opacity: alpha,
          fillRule: 'nonzero',
          strokeWidth: 0,
          lineCap: 'butt',
          lineJoin: 'miter',
          miterLimit: 4,
          dash: null,
        }),
      );
    } else if (layer.image !== null) {
      const asset = sizes.get(layer.image);
      if (asset)
        out.push({
          kind: 'image',
          asset: asset.id,
          matrix: here,
          opacity: alpha,
          width: asset.width,
          height: asset.height,
        });
    } else if (layer.precomp) {
      const { remap, layers: inner } = layer.precomp,
        time = remap ? remap.number(frame) * rate : (frame - layer.startTime) / layer.stretch;
      collect(inner, time, rate, sizes, here, alpha, out);
    }
  }
}

const cssColor = (r: number, g: number, b: number, a: number): string =>
  `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;

function trace(context: LottieCanvas, commands: readonly OutlineCommand[]): void {
  context.beginPath();
  for (const c of commands) {
    if (c[0] === 'M') context.moveTo(c[1], c[2]);
    else if (c[0] === 'L') context.lineTo(c[1], c[2]);
    else if (c[0] === 'C') context.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
    else if (c[0] === 'Q') context.quadraticCurveTo(c[1], c[2], c[3], c[4]);
    else context.closePath();
  }
}

function gradientPaint(context: LottieCanvas, { kind, start, end, stops }: LottieGradient): LottieCanvasGradient {
  const paint =
    kind === 'linear'
      ? context.createLinearGradient(start[0], start[1], end[0], end[1])
      : context.createRadialGradient(
          start[0],
          start[1],
          0,
          start[0],
          start[1],
          Math.hypot(end[0] - start[0], end[1] - start[1]),
        );
  for (const [offset, r, g, b, a] of stops) paint.addColorStop(Math.min(1, Math.max(0, offset)), cssColor(r, g, b, a));
  return paint;
}

function paintPath(context: LottieCanvas, path: LottiePath): void {
  context.save();
  context.globalAlpha = path.opacity;
  trace(context, path.commands);
  if (path.strokeWidth > 0) {
    context.lineWidth = path.strokeWidth;
    context.lineCap = path.lineCap;
    context.lineJoin = path.lineJoin;
    context.miterLimit = path.miterLimit;
    if (path.dash) {
      context.setLineDash(path.dash.pattern);
      context.lineDashOffset = path.dash.offset;
    }
    const [r = 0, g = 0, b = 0] = path.stroke ?? [];
    context.strokeStyle = path.gradient ? gradientPaint(context, path.gradient) : cssColor(r, g, b, 1);
    context.stroke();
  } else {
    const [r = 0, g = 0, b = 0] = path.fill ?? [];
    context.fillStyle = path.gradient ? gradientPaint(context, path.gradient) : cssColor(r, g, b, 1);
    context.fill(path.fillRule);
  }
  context.restore();
}

/** Whether the file's exporter wrote fill and stroke colours from 0 to 255: Bodymovin before 4.1.9. */
function bytesColours(version: string): boolean {
  if (!/^\d+\.\d+\.\d+/.test(version)) return false;
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return major < 4 || (major === 4 && (minor < 1 || (minor === 1 && patch < 9)));
}

/** Rewrites the fill and stroke colours under `value` to 0..1, in a file of {@link bytesColours}. */
function scaleColours(value: unknown): void {
  if (Array.isArray(value)) for (const item of value) scaleColours(item);
  if (!isObject(value)) return;
  if ((value.ty === 'fl' || value.ty === 'st') && isObject(value.c)) {
    const scaled = (colour: unknown): unknown =>
      Array.isArray(colour) ? colour.map((part) => (typeof part === 'number' ? part / 255 : part)) : colour;
    const keys = value.c.k;
    if (Array.isArray(keys) && isObject(keys[0]))
      for (const key of list(keys)) {
        key.s = scaled(key.s);
        key.e = scaled(key.e);
      }
    else value.c.k = scaled(keys);
  }
  for (const name of ['layers', 'assets', 'shapes', 'it']) scaleColours(value[name]);
}

/**
 * Reads a Lottie JSON animation. `frame()` gives the vector shapes of any frame, for `toShapes()` or your own drawing,
 * and `draw()` paints a frame onto a 2D canvas context, which uploads as a texture. What the file uses and a frame
 * leaves out is listed in `unsupported`.
 *
 * @throws LoaderError code `syntax` for bad JSON or a missing asset, `header` when the root is not a Lottie animation,
 * `range` for a precomposition that contains itself or nesting past 64, `limit` over `maxLayers`.
 */
export function parseLottie(input: BinaryInput | string, options: LottieOptions = {}): LottieAnimation {
  let root: unknown;
  try {
    root = JSON.parse(toText(input, F));
  } catch (error) {
    if (error instanceof LoaderError) throw error;
    throw new LoaderError(F, 'syntax', `bad JSON (${(error as Error).message})`);
  }
  if (!isObject(root) || !Array.isArray(root.layers) || typeof root.fr !== 'number' || !(root.fr > 0))
    throw new LoaderError(F, 'header', 'not a Lottie animation: it needs layers and a frame rate');
  if (bytesColours(str(root.v))) scaleColours(root);
  const assets = new Map<string, Json>(),
    images: LottieImageAsset[] = [];
  for (const asset of list(root.assets)) {
    const id = str(asset.id);
    if (Array.isArray(asset.layers)) assets.set(id, asset);
    else if (typeof asset.p === 'string') {
      const embedded = asset.e === 1 || asset.p.startsWith('data:');
      images.push({
        id,
        width: num(asset.w, 0),
        height: num(asset.h, 0),
        path: embedded ? asset.p : str(asset.u) + asset.p,
        embedded,
      });
    }
  }
  const compiler = new Compiler(assets, options.maxLayers ?? 100_000),
    layers = compiler.compile(root.layers, []),
    rate = root.fr,
    inFrame = num(root.ip, 0),
    outFrame = num(root.op, inFrame),
    sizes = new Map(images.map((image) => [image.id, image]));
  const frame = (at: number): LottieItem[] => {
    const out: LottieItem[] = [];
    collect(layers, at, rate, sizes, IDENTITY, 1, out);
    return out;
  };
  return {
    version: str(root.v),
    name: str(root.nm),
    width: num(root.w, 0),
    height: num(root.h, 0),
    frameRate: rate,
    inFrame,
    outFrame,
    duration: (outFrame - inFrame) / rate,
    images,
    markers: list(root.markers).map((marker) => ({
      name: str(marker.cm),
      time: num(marker.tm, 0),
      duration: num(marker.dr, 0),
    })),
    unsupported: [...compiler.unsupported],
    frame,
    draw(context, at, drawOptions = {}) {
      for (const item of frame(at)) {
        if (item.kind === 'path') {
          paintPath(context, item);
          continue;
        }
        const image = drawOptions.images?.[item.asset];
        if (image === undefined) continue;
        context.save();
        context.globalAlpha = item.opacity;
        context.transform(...item.matrix);
        context.drawImage(image as never, 0, 0, item.width, item.height);
        context.restore();
      }
    },
  };
}
