// Clean-room DragonBones 5.x data reader. Written from the public format description only (docs/clean-room.md,
// "DragonBones reader"); no DragonBones runtime or other engine source was read.
import { fault } from '../../shared/errors.js';

/** A JSON value retained from a DragonBones export, including user data. */
export type DragonBonesValue = null | boolean | number | string | DragonBonesValue[] | DragonBonesObject;
/** A JSON object from a DragonBones export. */
export interface DragonBonesObject {
  [key: string]: DragonBonesValue | undefined;
}
/** Reader resource limits. Defaults: 1,000,000 JSON values and vertices; 64 levels of nesting. */
export interface DragonBonesReadOptions {
  maxValues?: number;
  maxVertices?: number;
  /** Checked before parsing, between armatures and between animations. */
  signal?: AbortSignal;
}

/** @internal */
export const bad = (message: string): never => {
  throw fault('failed', `Invalid DragonBones data: ${message}`, 'sprite-options');
};
/** @internal */
export const isObj = (v: unknown): v is DragonBonesObject => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @internal */
export const o = (v: DragonBonesValue | undefined, what: string): DragonBonesObject =>
  isObj(v) ? v : bad(`${what} must be an object`);
/** @internal */
export const list = (v: DragonBonesValue | undefined, what: string): DragonBonesValue[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : bad(`${what} must be an array`);
/** @internal */
export const objs = (v: DragonBonesValue | undefined, what: string): DragonBonesObject[] =>
  list(v, what).map((x) => o(x, what));
/** @internal */
export const n = (v: DragonBonesValue | undefined, fallback: number, what: string): number =>
  v === undefined || v === null
    ? fallback
    : typeof v === 'number' && Number.isFinite(v)
      ? v
      : bad(`${what} must be a finite number`);
/** @internal */
export const s = (v: DragonBonesValue | undefined, fallback: string, what: string): string =>
  v === undefined || v === null ? fallback : typeof v === 'string' ? v : bad(`${what} must be a string`);
/** @internal Booleans; exporters also write the strings "true" and "false" (seen in DragonBones 5.5 files). */
export const b = (v: DragonBonesValue | undefined, fallback: boolean, what: string): boolean =>
  v === undefined || v === null
    ? fallback
    : typeof v === 'boolean'
      ? v
      : v === 'true' || v === 'false'
        ? v === 'true'
        : bad(`${what} must be a boolean`);
/** @internal */
export const nums = (v: DragonBonesValue | undefined, what: string): number[] =>
  list(v, what).map((x) => n(x, NaN, what));
/** @internal Nonnegative safe integer. */
export const int = (v: DragonBonesValue | undefined, fallback: number, what: string): number => {
  const x = n(v, fallback, what);
  return Number.isSafeInteger(x) && x >= 0 ? x : bad(`${what} must be a nonnegative integer`);
};

/** @internal Copy plain JSON (string or value) under the value and depth limits. */
export function copyJSON(input: unknown, options: DragonBonesReadOptions): DragonBonesObject {
  options.signal?.throwIfAborted();
  const limit = options.maxValues ?? 1_000_000;
  if (!Number.isSafeInteger(limit) || limit < 1) bad('invalid resource limit');
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (bytes[0] === 0x44 && bytes[1] === 0x42 && bytes[2] === 0x44 && bytes[3] === 0x54)
      bad('binary (.dbbin) data is not read; its public description leaves timeline tags undefined, so export JSON');
    input = new TextDecoder().decode(bytes);
  }
  let count = 0;
  const copy = (v: unknown, depth: number): DragonBonesValue => {
    if (++count > limit || depth > 64) bad('JSON resource limit exceeded');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : bad('numbers must be finite');
    if (Array.isArray(v)) return v.map((x) => copy(x, depth + 1));
    if (isObj(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null))
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x, depth + 1)]));
    return bad('input must contain only JSON values');
  };
  let source = input;
  if (typeof input === 'string') {
    if (input.length > limit * 128) bad('JSON text resource limit exceeded');
    try {
      source = JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input);
    } catch (e) {
      if (e instanceof SyntaxError) bad('malformed JSON text');
      throw e;
    }
  }
  return o(copy(source, 0), 'the document');
}

/** A 2D affine matrix [a, b, c, d, tx, ty]: x' = a x + c y + tx, y' = b x + d y + ty (y down). */
export type Matrix = [number, number, number, number, number, number];
/** @internal DragonBones transform: rotation skY, skew skX - skY, degrees clockwise in y-down space. */
export const RAD = Math.PI / 180;
export function transformMatrix(t: DragonBonesObject | undefined, what: string): Matrix {
  const x = n(t?.x, 0, what),
    y = n(t?.y, 0, what),
    skX = n(t?.skX, 0, what) * RAD,
    skY = n(t?.skY, 0, what) * RAD,
    scX = n(t?.scX, 1, what),
    scY = n(t?.scY, 1, what);
  return [scX * Math.cos(skY), scX * Math.sin(skY), -scY * Math.sin(skX), scY * Math.cos(skX), x, y];
}
/** @internal */
export const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
/** @internal */
export const linear = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
/** @internal */
export function invert(m: Matrix, what: string): Matrix {
  const d = m[0] * m[3] - m[1] * m[2];
  if (!(Math.abs(d) > 1e-12)) bad(`${what} is singular`);
  const a = m[3] / d,
    bb = -m[1] / d,
    c = -m[2] / d,
    dd = m[0] / d;
  return [a, bb, c, dd, -(a * m[4] + c * m[5]), -(bb * m[4] + dd * m[5])];
}
/** @internal Matrix from a six-number pose array. */
export function poseMatrix(v: number[], at: number, what: string): Matrix {
  if (at + 6 > v.length) bad(`${what} is truncated`);
  return [v[at], v[at + 1], v[at + 2], v[at + 3], v[at + 4], v[at + 5]];
}

/** @internal Colour transform (multipliers 0..100, offsets -255..255) to RRGGBBAA, and whether offsets were used. */
export function colorHex(c: DragonBonesObject | undefined, what: string): { hex: string; offset: boolean } {
  const m = (k: string) => Math.max(0, Math.min(1, n(c?.[k], 100, what) / 100));
  const hex = ['rM', 'gM', 'bM', 'aM']
    .map((k) =>
      Math.round(m(k) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
  return { hex, offset: ['rO', 'gO', 'bO', 'aO'].some((k) => n(c?.[k], 0, what) !== 0) };
}

/**
 * @internal Spine-style normalized cubic controls for a key's interpolation to the next key, 'stepped', or
 * undefined for linear. A `curve` of four numbers is one cubic from (0, 0) to (1, 1). A number `tweenEasing` is the
 * classic tween ease: 0 linear; -1..1 blends linear with quadratic ease in (negative) or out (positive),
 * f(t) = t + e t (1 - t); 1..2 blends linear with ease in and out (smoothstep). An absent or null tweenEasing with no
 * curve holds the value (no tween), as the format describes for null.
 */
export function curveOf(k: DragonBonesObject, what: string): number[] | 'stepped' | undefined {
  if (k.curve !== undefined && k.curve !== null) {
    const c = nums(k.curve, `${what} curve`);
    if (c.length !== 4) bad(`${what} curve must have four control values, found ${c.length}`);
    return c;
  }
  if (k.tweenEasing === undefined || k.tweenEasing === null) return 'stepped';
  const e = n(k.tweenEasing, 0, `${what} tweenEasing`);
  if (e === 0) return undefined;
  if (e <= 1) {
    const q = Math.max(-1, e);
    return [1 / 3, (1 + q) / 3, 2 / 3, (2 + q) / 3];
  }
  const io = Math.min(1, e - 1);
  return [1 / 3, (1 - io) / 3, 2 / 3, 2 / 3 + io / 3];
}
