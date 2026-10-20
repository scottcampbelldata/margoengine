// Light helpers (three.js PointLightHelper, SpotLightHelper, DirectionalLightHelper, HemisphereLightHelper and
// RectAreaLightHelper) and LightsHelper, which draws every light of a list in one Line. The lights are structural types,
// so lines does not import @margoengine/clustered or @margoengine/environment: pass their light objects or their `list`
// getters (Clustered.list, DirectionalLights.list, AreaLights.list) and a HemisphereLight. Each frame a helper re-reads
// its lights and rebuilds its lines only when a value it draws changed, into arrays it keeps.
import type { Vec3 } from '@margoengine/core';
import { parseColor, type ColorInput } from './color.js';
import { Line } from './line.js';
import type { HelperOptions } from './helpers.js';

/** A point light as `Clustered.setLights` takes it (only what the helper draws). */
export interface PointLightShape {
  readonly position: Vec3;
  readonly range?: number;
  readonly color?: Vec3;
}
/** A spot light as `Clustered.setLights` takes it: a point light with a direction and a cone. */
export interface SpotLightShape extends PointLightShape {
  readonly direction: Vec3;
  readonly outerAngle?: number;
  readonly innerAngle?: number;
  readonly angle?: number;
  readonly penumbra?: number;
}
/** A directional light (`@margoengine/clustered/directional`; `direction` is the way the light travels). */
export interface DirectionalLightShape {
  readonly direction: Vec3;
  readonly color?: Vec3;
}
/** A rectangle area light as `@margoengine/clustered/area` takes it. */
export interface RectAreaLightShape {
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly width: number;
  readonly height: number;
  readonly up?: Vec3;
  readonly color?: Vec3;
}
/** A hemisphere or ambient light (`@margoengine/environment` HemisphereLight: `sky`, and `ground` or none for one colour). */
export interface HemisphereLightShape {
  readonly sky: ColorInput;
  readonly ground?: ColorInput;
}
/** Any light a {@link LightsHelper} draws. */
export type LightShape =
  | PointLightShape
  | SpotLightShape
  | DirectionalLightShape
  | RectAreaLightShape
  | HemisphereLightShape;
/** Placement and look of the drawn lights. */
export interface LightHelperOptions extends HelperOptions {
  /** One colour for every line (default: each light's own colour, brightest channel scaled to 1). */
  color?: ColorInput;
  /** Radius of a point light's circles and of a hemisphere light's sphere; side of a directional light's square. Default 0.25. */
  size?: number;
  /** Length of a spot cone whose light has no range (range 0: unlimited). Default 1. */
  length?: number;
  /** Where directional and hemisphere lights (which have no position) are drawn. Default [0, 0, 0]. */
  position?: Vec3;
}

type Kind = 'point' | 'spot' | 'directional' | 'rect' | 'hemisphere';
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
/** What `light` is, by its shape, or null for anything else (an IES profile, a projector image, null). */
export function lightKind(light: unknown): Kind | null {
  if (!light || typeof light !== 'object') return null;
  const l = light as Record<string, unknown>;
  if ('sky' in l) return 'hemisphere';
  if (isVec3(l.position) && isVec3(l.direction) && typeof l.width === 'number' && typeof l.height === 'number')
    return 'rect';
  if (isVec3(l.position)) return isVec3(l.direction) ? 'spot' : 'point';
  return isVec3(l.direction) ? 'directional' : null;
}
const unit = (v: ArrayLike<number>): number[] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: number[], b: number[]): number[] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/** Two unit vectors perpendicular to unit `n` and to each other. */
function frame(n: number[]): [number[], number[]] {
  const u = unit(cross(Math.abs(n[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0], n));
  return [u, cross(n, u)];
}
/** A light colour for display: its brightest channel scaled to 1 (white when black or unset). */
function shown(color: ArrayLike<number> | undefined): number[] {
  const c = color ? [color[0], color[1], color[2]].map((v) => Math.max(0, v)) : [1, 1, 1],
    peak = Math.max(...c);
  return peak > 0 ? c.map((v) => v / peak) : [1, 1, 1];
}

/** Collects segments (two points each) and their colours into arrays that are kept and reused. */
class Segments {
  readonly positions: number[] = [];
  readonly colors: number[] = [];
  color: number[] = [1, 1, 1];
  clear(): void {
    this.positions.length = this.colors.length = 0;
  }
  line(a: ArrayLike<number>, b: ArrayLike<number>, color = this.color): void {
    this.positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    this.colors.push(color[0], color[1], color[2], color[0], color[1], color[2]);
  }
  /** A circle about `c` in the plane of unit `u`, `v`; `colorAt(point)` may colour each segment (hemisphere halves). */
  circle(c: ArrayLike<number>, u: number[], v: number[], r: number, colorAt?: (y: number) => number[]): void {
    const steps = 32;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2,
        b = ((i + 1) / steps) * Math.PI * 2,
        p = [0, 1, 2].map((k) => c[k] + (u[k] * Math.cos(a) + v[k] * Math.sin(a)) * r),
        q = [0, 1, 2].map((k) => c[k] + (u[k] * Math.cos(b) + v[k] * Math.sin(b)) * r);
      this.line(p, q, colorAt ? colorAt((p[1] + q[1]) / 2 - c[1]) : this.color);
    }
  }
}
/** Appends the lines of one light to `out`. */
function draw(out: Segments, light: LightShape, options: LightHelperOptions, fixed: number[] | null): void {
  const kind = lightKind(light),
    size = options.size ?? 0.25,
    origin = options.position ?? [0, 0, 0];
  if (!kind) return;
  out.color = fixed ?? shown((light as PointLightShape).color);
  if (kind === 'hemisphere') {
    const h = light as HemisphereLightShape,
      sky = fixed ?? shown(parseColor(h.sky) as number[]),
      ground = fixed ?? shown(parseColor(h.ground ?? h.sky) as number[]),
      half = (y: number) => (y >= 0 ? sky : ground);
    out.circle(origin, [1, 0, 0], [0, 1, 0], size, half);
    out.circle(origin, [0, 0, 1], [0, 1, 0], size, half);
    out.circle(origin, [1, 0, 0], [0, 0, 1], size, () => ground);
    out.line(origin, [origin[0], origin[1] + size * 1.5, origin[2]], sky);
    return;
  }
  if (kind === 'directional') {
    const d = unit((light as DirectionalLightShape).direction),
      [u, v] = frame(d),
      corner = (a: number, b: number) => [0, 1, 2].map((k) => origin[k] + (u[k] * a + v[k] * b) * (size / 2));
    const c = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    for (let i = 0; i < 4; i++) out.line(c[i], c[(i + 1) % 4]);
    out.line(
      origin,
      [0, 1, 2].map((k) => origin[k] + d[k] * size * 2),
    );
    return;
  }
  const p = (light as PointLightShape).position;
  if (kind === 'point') {
    out.circle(p, [1, 0, 0], [0, 1, 0], size);
    out.circle(p, [0, 0, 1], [0, 1, 0], size);
    out.circle(p, [1, 0, 0], [0, 0, 1], size);
    return;
  }
  if (kind === 'rect') {
    // The same axes as AreaLights: right = up x normal, up made perpendicular.
    const r = light as RectAreaLightShape,
      n = unit(r.direction),
      hint = r.up ?? (Math.abs(n[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0]),
      right = unit(cross([hint[0], hint[1], hint[2]], n)),
      up = cross(n, right),
      corner = (a: number, b: number) =>
        [0, 1, 2].map((k) => p[k] + (right[k] * a * r.width + up[k] * b * r.height) / 2);
    const c = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    for (let i = 0; i < 4; i++) out.line(c[i], c[(i + 1) % 4]);
    out.line(
      p,
      [0, 1, 2].map((k) => p[k] + (n[k] * Math.min(r.width, r.height)) / 2),
    );
    return;
  }
  // Spot: the outer cone to its range (or `length`), with the inner cone's rim.
  const s = light as SpotLightShape,
    d = unit(s.direction),
    [u, v] = frame(d),
    outer = Math.min(s.angle ?? s.outerAngle ?? Math.PI / 4, (85 * Math.PI) / 180),
    inner = s.angle !== undefined ? s.angle * (1 - (s.penumbra ?? 0)) : (s.innerAngle ?? 0),
    length = s.range && s.range > 0 && Number.isFinite(s.range) ? s.range : (options.length ?? 1),
    center = [0, 1, 2].map((k) => p[k] + d[k] * length),
    radius = length * Math.tan(outer);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    out.line(
      p,
      [0, 1, 2].map((k) => center[k] + (u[k] * Math.cos(a) + v[k] * Math.sin(a)) * radius),
    );
  }
  out.circle(center, u, v, radius);
  if (inner > 0 && inner < outer) out.circle(center, u, v, length * Math.tan(inner));
}
/** Numbers of `lights` a helper draws, written into `into` (reused); returns how many it wrote. */
function signature(into: number[], lights: readonly unknown[]): number {
  into.length = 0;
  for (const light of lights) {
    const kind = lightKind(light);
    into.push(kind ? kind.length : 0);
    if (!kind) continue;
    const l = light as Record<string, unknown>;
    for (const key of ['position', 'direction', 'color', 'up'] as const) {
      const v = l[key] as ArrayLike<number> | undefined;
      if (v) into.push(v[0], v[1], v[2]);
      else into.push(NaN);
    }
    for (const key of ['range', 'outerAngle', 'innerAngle', 'angle', 'penumbra', 'width', 'height'] as const)
      into.push((l[key] as number | undefined) ?? NaN);
    if (kind === 'hemisphere')
      into.push(
        ...(parseColor((l as unknown as HemisphereLightShape).sky) as number[]),
        ...(parseColor((l as unknown as HemisphereLightShape).ground ?? '#000') as number[]),
        +(l.ground === undefined),
      );
  }
  return into.length;
}

/**
 * Draws every light `lights()` returns, in one Line (segments, per-vertex colours): point lights as three circles,
 * spots as their cone, directional lights as a square with the direction they travel, rectangle lights as their outline
 * and normal, hemisphere lights as a sphere in sky and ground colours. `lights` is called each frame (return the same
 * arrays when nothing changed, as `Clustered.list` does); anything that is not a light (null, an IES profile) is
 * skipped. The Inspector's "Light helpers" toggle uses it.
 */
export class LightsHelper extends Line {
  private readonly segments = new Segments();
  private readonly seen: number[] = [];
  private readonly next: number[] = [];
  private readonly fixed: number[] | null;
  constructor(
    readonly lights: () => readonly unknown[],
    private readonly options: LightHelperOptions = {},
  ) {
    if (typeof lights !== 'function') throw new TypeError('LightsHelper takes a function returning the lights to draw');
    const { color, size, length, position, ...style } = options;
    if ((size !== undefined && !(size > 0)) || (length !== undefined && !(length > 0)))
      throw new RangeError('Light helper size and length must be above 0');
    if (position !== undefined && !isVec3(position)) throw new TypeError('Light helper position needs 3 finite values');
    super({ cap: 'butt', join: 'miter', ...style, mode: 'segments' });
    this.fixed = color === undefined ? null : (parseColor(color) as number[]);
    this.update();
  }
  override update(): boolean {
    const lights = this.lights(),
      next = this.next;
    signature(next, lights);
    let same = next.length === this.seen.length;
    for (let i = 0; same && i < next.length; i++) same = Object.is(next[i], this.seen[i]);
    if (same) return true;
    this.seen.length = 0;
    this.seen.push(...next);
    const out = this.segments;
    out.clear();
    for (const light of lights) draw(out, light as LightShape, this.options, this.fixed);
    // An empty list still needs one (degenerate) segment for the Line to exist.
    if (!out.positions.length) out.line([0, 0, 0], [0, 0, 0]);
    this.setPositions(out.positions, out.colors);
    return true;
  }
}
/** One light, live: the helpers below draw `light` as {@link LightsHelper} does and follow its changes. */
class OneLightHelper<T extends LightShape> extends LightsHelper {
  constructor(
    readonly light: T,
    options: LightHelperOptions,
    expected: Kind,
  ) {
    const list = [light];
    super(() => list, options);
    if (lightKind(light) !== expected) throw new TypeError(`Expected a ${expected} light`);
  }
}
/** A point light as three circles of radius `size` (default 0.25), like three.js `PointLightHelper`. */
export class PointLightHelper extends OneLightHelper<PointLightShape> {
  constructor(light: PointLightShape, options: LightHelperOptions = {}) {
    super(light, options, 'point');
  }
}
/** A spot light's outer cone to its range (or `length`) and the inner cone's rim, like three.js `SpotLightHelper`. */
export class SpotLightHelper extends OneLightHelper<SpotLightShape> {
  constructor(light: SpotLightShape, options: LightHelperOptions = {}) {
    super(light, options, 'spot');
  }
}
/** A directional light as a square of side `size` at `position` and a line the way it travels, like three.js `DirectionalLightHelper`. */
export class DirectionalLightHelper extends OneLightHelper<DirectionalLightShape> {
  constructor(light: DirectionalLightShape, options: LightHelperOptions = {}) {
    super(light, options, 'directional');
  }
}
/** A hemisphere light as a sphere of radius `size` at `position`, sky colour above, ground below, like three.js `HemisphereLightHelper`. */
export class HemisphereLightHelper extends OneLightHelper<HemisphereLightShape> {
  constructor(light: HemisphereLightShape, options: LightHelperOptions = {}) {
    super(light, options, 'hemisphere');
  }
}
/** A rectangle area light's outline and normal, like three.js `RectAreaLightHelper`. */
export class RectAreaLightHelper extends OneLightHelper<RectAreaLightShape> {
  constructor(light: RectAreaLightShape, options: LightHelperOptions = {}) {
    super(light, options, 'rect');
  }
}
