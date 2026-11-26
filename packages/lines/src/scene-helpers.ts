// Debug helpers for things that light or sound a scene without a mesh: LightProbeHelper draws a light probe as a wire
// sphere coloured by its spherical-harmonic irradiance, PositionalAudioHelper draws a positional sound's Web Audio
// cones and its reference and maximum distances. The sources are structural, so this entry imports neither
// @margoengine/environment nor @margoengine/audio: an `Environment`'s `sh.irradiance` or `irradianceAt`, a
// `LightProbes.irradianceAt` and a `PositionalAudio` fit as they are.
// Sources: Ravi Ramamoorthi and Pat Hanrahan, An Efficient Representation for Irradiance Environment Maps, SIGGRAPH
// 2001 (the 9 L2 basis constants and the clamped-cosine band factors pi, 2pi/3, pi/4); W3C Web Audio API, PannerNode
// (coneInnerAngle and coneOuterAngle are whole cone angles in degrees about the orientation, 360 = no cone).
import type { Vec3 } from '@margoengine/core';
import { parseColor, type ColorInput } from './color.js';
import type { HelperOptions } from './helpers.js';
import { Line } from './line.js';

const LINK = '; see https://margoengine.com/errors#scene-helpers';
const isVec3 = (v: unknown): v is ArrayLike<number> =>
  !!v &&
  typeof (v as ArrayLike<number>).length === 'number' &&
  (v as ArrayLike<number>).length === 3 &&
  Number.isFinite((v as ArrayLike<number>)[0]) &&
  Number.isFinite((v as ArrayLike<number>)[1]) &&
  Number.isFinite((v as ArrayLike<number>)[2]);
const unit = (v: ArrayLike<number>): number[] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** Two unit vectors perpendicular to unit `n` and to each other. */
function frame(n: number[]): [number[], number[]] {
  const a = Math.abs(n[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0],
    u = unit([a[1] * n[2] - a[2] * n[1], a[2] * n[0] - a[0] * n[2], a[0] * n[1] - a[1] * n[0]]);
  return [u, [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]];
}
const style = (options: HelperOptions) => ({
  cap: 'butt' as const,
  join: 'miter' as const,
  ...options,
});
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** L2 basis constants, coefficient order (l,m) = (0,0), (1,-1), (1,0), (1,1), (2,-2), (2,-1), (2,0), (2,1), (2,2). */
const BASIS = [
  0.282094792, 0.488602512, 0.488602512, 0.488602512, 1.092548431, 1.092548431, 0.315391565, 1.092548431, 0.546274215,
];
/** Clamped-cosine convolution per band, divided by pi: 1, 2/3, 1/4 (Ramamoorthi and Hanrahan 2001). */
const BAND = [1, 2 / 3, 2 / 3, 2 / 3, 0.25, 0.25, 0.25, 0.25, 0.25];

/**
 * Irradiance of 4 (L1) or 9 (L2) RGB spherical-harmonic coefficients (12 or 27 floats, coefficient-major:
 * `k * 3 + channel`, the layout of `Environment.sh`) in unit direction `n`, into `out`. `convolve` applies the
 * clamped-cosine band factors first, for radiance coefficients.
 */
export function shIrradiance(
  sh: ArrayLike<number>,
  n: ArrayLike<number>,
  convolve = false,
  out: number[] = [0, 0, 0],
): number[] {
  const [x, y, z] = [n[0], n[1], n[2]],
    b = [1, y, z, x, x * y, y * z, 3 * z * z - 1, x * z, x * x - y * y],
    count = sh.length / 3;
  out[0] = out[1] = out[2] = 0;
  for (let k = 0; k < count; k++) {
    const w = BASIS[k] * b[k] * (convolve ? BAND[k] : 1);
    for (let c = 0; c < 3; c++) out[c] += sh[k * 3 + c] * w;
  }
  return out;
}

/** What a {@link LightProbeHelper} shades by: SH coefficients, or a function giving the irradiance in a direction. */
export type LightProbeSource = ArrayLike<number> | ((normal: Vec3) => ArrayLike<number> | null);
/** Options for {@link LightProbeHelper}. */
export type LightProbeHelperOptions = {
  /** Centre of the sphere (a probe's position). Default [0, 0, 0]; the helper's `position` can be edited later. */
  position?: Vec3;
  /** Sphere radius. Default 0.25. */
  size?: number;
  /** Colour scale: a number multiplies the irradiance, 'auto' scales the brightest point to 1. Default 'auto'. */
  exposure?: number | 'auto';
  /** The coefficients are radiance, so apply the clamped-cosine convolution first. Default false (irradiance, as `Environment.sh.irradiance`). */
  convolve?: boolean;
} & HelperOptions;

const ROWS = 16,
  COLUMNS = 24;

/**
 * A light probe as a wire sphere (7 latitude rings, 12 meridians) whose every point is coloured by the probe's
 * irradiance in that point's normal direction, so the sphere reads like a diffuse ball lit by the probe. Pass 12 or
 * 27 SH coefficients (`environment.sh.irradiance`) or a function (`(n) => probes.irradianceAt(position, n)`).
 * `update()` re-reads the source each frame and rebuilds only when a colour or the position changed.
 */
export class LightProbeHelper extends Line {
  /** The sphere's centre; edit it to move the helper. */
  readonly position: Float64Array;
  private readonly size: number;
  private readonly exposure: number | 'auto';
  private readonly convolve: boolean;
  private readonly normals: number[][] = [];
  private readonly seen: number[] = [];
  private readonly next: number[] = [];
  constructor(
    readonly source: LightProbeSource,
    {
      position = [0, 0, 0],
      size = 0.25,
      exposure = 'auto',
      convolve = false,
      ...options
    }: LightProbeHelperOptions = {},
  ) {
    if (typeof source !== 'function' && !(source && (source.length === 12 || source.length === 27)))
      throw new TypeError(`LightProbeHelper needs 12 or 27 SH coefficients or a function of the normal${LINK}`);
    if (!(size > 0) || !Number.isFinite(size) || (exposure !== 'auto' && !(exposure >= 0 && Number.isFinite(exposure))))
      throw new RangeError(`LightProbeHelper size must be above 0 and exposure 'auto' or 0 and above${LINK}`);
    if (!isVec3(position)) throw new TypeError(`LightProbeHelper position needs 3 finite values${LINK}`);
    super({ ...style(options), mode: 'segments' });
    this.position = Float64Array.from(position);
    this.size = size;
    this.exposure = exposure;
    this.convolve = convolve;
    for (let r = 0; r <= ROWS; r++)
      for (let c = 0; c < COLUMNS; c++) {
        const t = (r / ROWS) * Math.PI,
          p = (c / COLUMNS) * Math.PI * 2;
        this.normals.push([Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p)]);
      }
    this.update();
  }
  override update(): boolean {
    const next = this.next,
      rgb = [0, 0, 0];
    next.length = 0;
    let peak = 0;
    for (const n of this.normals) {
      const value =
        typeof this.source === 'function'
          ? this.source(n as unknown as Vec3)
          : shIrradiance(this.source, n, this.convolve, rgb);
      for (let c = 0; c < 3; c++) {
        const v = value ? Math.max(0, Number(value[c]) || 0) : 0;
        next.push(v);
        peak = Math.max(peak, v);
      }
    }
    const scale = this.exposure === 'auto' ? (peak > 0 ? 1 / peak : 1) : this.exposure;
    for (let i = 0; i < next.length; i++) next[i] = Math.min(1, next[i] * scale);
    next.push(this.position[0], this.position[1], this.position[2]);
    if (same(next, this.seen)) return true;
    this.seen.length = 0;
    this.seen.push(...next);
    const positions: number[] = [],
      colors: number[] = [],
      at = (r: number, c: number) => {
        const i = r * COLUMNS + (c % COLUMNS),
          n = this.normals[i];
        for (let k = 0; k < 3; k++) positions.push(this.position[k] + n[k] * this.size);
        colors.push(next[i * 3], next[i * 3 + 1], next[i * 3 + 2]);
      };
    for (let r = 2; r < ROWS; r += 2)
      for (let c = 0; c < COLUMNS; c++) {
        at(r, c);
        at(r, c + 1);
      }
    for (let c = 0; c < COLUMNS; c += 2)
      for (let r = 0; r < ROWS; r++) {
        at(r, c);
        at(r + 1, c);
      }
    this.setPositions(positions, colors);
    return true;
  }
}

/** The fields of a `PositionalAudio` (`@margoengine/audio`) the helper reads. */
export interface PositionalAudioShape {
  readonly worldPosition: ArrayLike<number>;
  /** The way the sound faces (the panner's orientation). */
  readonly worldDirection: ArrayLike<number>;
  readonly refDistance: number;
  readonly maxDistance: number;
  /** Whole cone angles in degrees, as a Web Audio PannerNode holds them; 360 means no cone. */
  readonly panner: {
    readonly coneInnerAngle: number;
    readonly coneOuterAngle: number;
  };
}
/** Options for {@link PositionalAudioHelper}. */
export type PositionalAudioHelperOptions = {
  /** Length of the cone lines. Default the reference distance, or 1 when it is 0. */
  length?: number;
  /** Inner cone (full gain) colour. Default a warm yellow. */
  innerColor?: ColorInput;
  /** Outer cone (where the gain reaches coneOuterGain) colour. Default orange. */
  outerColor?: ColorInput;
  /** Reference and maximum distance spheres colour. Default a sky blue. */
  distanceColor?: ColorInput;
} & HelperOptions;

/** Web Audio's default maxDistance: a sound left at it has no real limit, so its sphere is not drawn. */
const UNSET_MAX_DISTANCE = 10000;

/**
 * A positional sound's Web Audio cones and distances: the inner and outer cones (8 lines each from the source and a
 * rim, at `length`; a cone wider than 180 degrees opens backwards, 360 draws nothing), and the reference and maximum
 * distances as spheres of three circles (the maximum only below Web Audio's 10,000 default). `update()` follows the
 * sound and rebuilds only when a drawn value changed.
 */
export class PositionalAudioHelper extends Line {
  private readonly colorsOf: {
    inner: number[];
    outer: number[];
    distance: number[];
  };
  private readonly length?: number;
  private readonly seen: number[] = [];
  private readonly next: number[] = [];
  constructor(
    readonly audio: PositionalAudioShape,
    {
      length,
      innerColor = '#ffd24a',
      outerColor = '#f0931e',
      distanceColor = '#5ec8ff',
      ...options
    }: PositionalAudioHelperOptions = {},
  ) {
    if (!audio || !isVec3(audio.worldPosition) || !isVec3(audio.worldDirection) || !audio.panner)
      throw new TypeError(`PositionalAudioHelper needs a PositionalAudio or its shape${LINK}`);
    if (length !== undefined && !(length > 0 && Number.isFinite(length)))
      throw new RangeError(`PositionalAudioHelper length must be above 0${LINK}`);
    super({ ...style(options), mode: 'segments' });
    const rgb = (c: ColorInput) => Array.from(parseColor(c) as ArrayLike<number>).slice(0, 3);
    this.colorsOf = {
      inner: rgb(innerColor),
      outer: rgb(outerColor),
      distance: rgb(distanceColor),
    };
    this.length = length;
    this.update();
  }
  override update(): boolean {
    const a = this.audio,
      next = this.next;
    next.length = 0;
    next.push(...Array.from(a.worldPosition), ...Array.from(a.worldDirection));
    next.push(a.refDistance, a.maxDistance, a.panner.coneInnerAngle, a.panner.coneOuterAngle);
    if (same(next, this.seen)) return true;
    this.seen.length = 0;
    this.seen.push(...next);
    const positions: number[] = [],
      colors: number[] = [],
      p = [next[0], next[1], next[2]],
      d = unit([next[3], next[4], next[5]]),
      [u, v] = frame(d),
      line = (x: number[], y: number[], color: number[]) => {
        positions.push(x[0], x[1], x[2], y[0], y[1], y[2]);
        colors.push(...color, ...color);
      },
      circle = (c: number[], e1: number[], e2: number[], r: number, color: number[]) => {
        for (let i = 0; i < 32; i++) {
          const a0 = (i / 32) * Math.PI * 2,
            a1 = ((i + 1) / 32) * Math.PI * 2;
          line(
            [0, 1, 2].map((k) => c[k] + (e1[k] * Math.cos(a0) + e2[k] * Math.sin(a0)) * r),
            [0, 1, 2].map((k) => c[k] + (e1[k] * Math.cos(a1) + e2[k] * Math.sin(a1)) * r),
            color,
          );
        }
      },
      ref = Math.max(0, a.refDistance),
      length = this.length ?? (ref > 0 ? ref : 1);
    const cone = (degrees: number, color: number[]) => {
      if (!Number.isFinite(degrees) || degrees >= 360) return;
      const half = (Math.max(0, degrees) / 360) * Math.PI,
        along = Math.cos(half) * length,
        radius = Math.sin(half) * length,
        center = [0, 1, 2].map((k) => p[k] + d[k] * along);
      for (let i = 0; i < 8; i++) {
        const t = (i / 8) * Math.PI * 2;
        line(
          p,
          [0, 1, 2].map((k) => center[k] + (u[k] * Math.cos(t) + v[k] * Math.sin(t)) * radius),
          color,
        );
      }
      if (radius > 1e-9) circle(center, u, v, radius, color);
    };
    cone(a.panner.coneInnerAngle, this.colorsOf.inner);
    cone(a.panner.coneOuterAngle, this.colorsOf.outer);
    const sphere = (r: number) => {
      circle(p, [1, 0, 0], [0, 1, 0], r, this.colorsOf.distance);
      circle(p, [0, 0, 1], [0, 1, 0], r, this.colorsOf.distance);
      circle(p, [1, 0, 0], [0, 0, 1], r, this.colorsOf.distance);
    };
    if (ref > 0) sphere(ref);
    if (a.maxDistance > 0 && a.maxDistance < UNSET_MAX_DISTANCE && a.maxDistance !== ref) sphere(a.maxDistance);
    // An omnidirectional sound at distance 0 still needs one (degenerate) segment for the Line to exist.
    if (!positions.length) line(p, p, this.colorsOf.distance);
    this.setPositions(positions, colors);
    return true;
  }
}
