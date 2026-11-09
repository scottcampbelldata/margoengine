// Procedural studio environment (`@margoengine/environment/studio`): an equirect HDR image of a photo studio made on
// the CPU, a grey room (floor, walls and ceiling blended across the horizon) lit by rectangular softboxes, for product
// lighting with no HDR file to download. Pass it to `Environment.create` / `Environment.attach` as any equirect.
import type { Vec3 } from '@margoengine/core/extension';
import type { FloatImage } from './hdr.js';

/** A rectangular softbox seen from the centre of the studio. */
export interface StudioLight {
  /** Direction from the studio centre toward the light's centre (normalised for you). */
  direction: Vec3;
  /** Angular width and height in radians, across the light's horizontal and vertical axes (each in (0, PI)). */
  width: number;
  height: number;
  /** Radiance added inside the light (linear, 0 to 65,504). */
  intensity: number;
  /** Linear RGB 0..1 multiplying the intensity (default [1, 1, 1]). */
  color?: Vec3;
  /** Share of each half size over which the edge fades to 0, 0..1 (default 0.15; 0 is a hard edge). */
  softness?: number;
}
/** {@link studio} settings; invalid values throw RangeError. */
export interface StudioOptions {
  /** Equirect width in texels, a power of two 16 to 4,096; the height is half (default 512). */
  width?: number;
  /** Radiance of the floor, the walls at the horizon and the ceiling straight up, linear RGB (defaults 0.12, 0.3, 0.45 grey). */
  floor?: Vec3;
  walls?: Vec3;
  ceiling?: Vec3;
  /** Elevation band in radians over which the floor meets the walls (default 0.08, 0 to PI / 2). */
  horizon?: number;
  /** The softboxes (default {@link STUDIO_LIGHTS}: overhead, key, fill and rim). */
  lights?: readonly StudioLight[];
}

/**
 * Three-quarter product lighting, for a camera on +Z looking at the origin: a large overhead softbox, a key light to the
 * front left, a dimmer fill to the front right and a narrow rim strip behind. Margo design values.
 */
export const STUDIO_LIGHTS: readonly StudioLight[] = Object.freeze([
  { direction: [0, 1, 0], width: 1.2, height: 0.8, intensity: 4 },
  { direction: [-1, 0.6, 1], width: 0.7, height: 0.9, intensity: 8 },
  { direction: [1.2, 0.3, 0.8], width: 0.6, height: 0.8, intensity: 2.5 },
  { direction: [0.3, 0.4, -1], width: 0.25, height: 1.1, intensity: 6 },
] as StudioLight[]);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const color = (v: unknown, max = 65504): boolean =>
  Array.isArray(v) && v.length === 3 && v.every((x) => finite(x) && x >= 0 && x <= max);
const smooth = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
type Box = { d: number[]; right: number[]; up: number[]; hw: number; hh: number; soft: number; rgb: number[] };

function frame(light: StudioLight): Box {
  const scale = Math.max(...light.direction.map(Math.abs)),
    scaled = light.direction.map((x) => x / scale),
    l = Math.hypot(...scaled),
    d = scaled.map((x) => x / l),
    // Horizontal axis: up x d, or +X for a light straight above or below.
    side = Math.abs(d[1]) > 0.999 ? [1, 0, 0] : [d[2], 0, -d[0]],
    s = Math.hypot(...side),
    right = side.map((x) => x / s),
    up = [d[1] * right[2] - d[2] * right[1], d[2] * right[0] - d[0] * right[2], d[0] * right[1] - d[1] * right[0]];
  return {
    d,
    right,
    up,
    hw: light.width / 2,
    hh: light.height / 2,
    soft: light.softness ?? 0.15,
    rgb: (light.color ?? [1, 1, 1]).map((c) => c * light.intensity),
  };
}
// Coverage of direction r by a softbox: its angular coordinates about the centre (the gnomonic projection onto the
// light's plane, as angles), each faded over the last `soft` share of the half size.
function coverage(b: Box, r: readonly number[]): number {
  const c = r[0] * b.d[0] + r[1] * b.d[1] + r[2] * b.d[2];
  if (c <= 0) return 0;
  const u = Math.abs(Math.atan((r[0] * b.right[0] + r[1] * b.right[1] + r[2] * b.right[2]) / c)),
    v = Math.abs(Math.atan((r[0] * b.up[0] + r[1] * b.up[1] + r[2] * b.up[2]) / c));
  if (u >= b.hw || v >= b.hh) return 0;
  if (b.soft === 0) return 1;
  return smooth((b.hw - u) / (b.soft * b.hw)) * smooth((b.hh - v) / (b.soft * b.hh));
}

/**
 * An equirect FloatImage (RGBA, row 0 at the top, centre facing -Z, as the shaders read equirects) of a studio:
 * `Environment.attach(engine, studio())`. Pure and deterministic: the same options give the same bytes.
 */
export function studio(options: StudioOptions = {}): FloatImage {
  const width = options.width ?? 512,
    horizon = options.horizon ?? 0.08,
    lights = options.lights ?? STUDIO_LIGHTS;
  if (
    !Number.isInteger(width) ||
    width < 16 ||
    width > 4096 ||
    (width & (width - 1)) !== 0 ||
    !finite(horizon) ||
    horizon < 0 ||
    horizon > Math.PI / 2 ||
    [options.floor, options.walls, options.ceiling].some((c) => c !== undefined && !color(c)) ||
    !Array.isArray(lights) ||
    !lights.every(
      (l) =>
        l &&
        Array.isArray(l.direction) &&
        l.direction.length === 3 &&
        l.direction.every(finite) &&
        Math.hypot(...l.direction) > 0 &&
        [l.width, l.height].every((a) => finite(a) && a > 0 && a < Math.PI) &&
        finite(l.intensity) &&
        l.intensity >= 0 &&
        l.intensity <= 65504 &&
        (l.color === undefined || color(l.color, 1)) &&
        (l.softness === undefined || (finite(l.softness) && l.softness >= 0 && l.softness <= 1)),
    )
  )
    throw new RangeError(
      'Invalid studio options; pass a power-of-two width 16-4096, colours of three finite values >= 0 and lights with a direction, angular size in (0, PI) and intensity 0-65504',
    );
  const floor = options.floor ?? [0.12, 0.12, 0.12],
    walls = options.walls ?? [0.3, 0.3, 0.3],
    ceiling = options.ceiling ?? [0.45, 0.45, 0.45],
    boxes = lights.map(frame),
    height = width / 2,
    data = new Float32Array(width * height * 4),
    r = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    const theta = (Math.PI * (y + 0.5)) / height,
      elevation = Math.PI / 2 - theta,
      // Floor below the horizon band, walls at it, rising to the ceiling straight up (sin of the elevation).
      wall = horizon > 0 ? smooth((elevation + horizon / 2) / horizon) : +(elevation >= 0),
      up = Math.max(0, Math.sin(elevation));
    const base = [0, 1, 2].map((k) => {
      const room = walls[k] + (ceiling[k] - walls[k]) * up;
      return floor[k] + (room - floor[k]) * wall;
    });
    for (let x = 0; x < width; x++) {
      const phi = 2 * Math.PI * ((x + 0.5) / width - 0.5);
      r[0] = Math.sin(theta) * Math.sin(phi);
      r[1] = Math.cos(theta);
      r[2] = -Math.sin(theta) * Math.cos(phi);
      const o = (y * width + x) * 4;
      data[o] = base[0];
      data[o + 1] = base[1];
      data[o + 2] = base[2];
      data[o + 3] = 1;
      for (const b of boxes) {
        const w = coverage(b, r);
        if (w > 0) for (let k = 0; k < 3; k++) data[o + k] += w * b.rgb[k];
      }
    }
  }
  return { width, height, data };
}
