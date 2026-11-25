import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Vec3 } from '@margoengine/core/extension';
import { AccumulatedShadows, type AccumulatedShadowOptions } from './accumulate.js';
import { rangeError } from '../../shared/errors.js';

/** One disk light, parallel to the receiver, with normalized relative visibility weight. */
export interface AccumulatedLight {
  /** World centre above the caster slab. Required. */
  position: Vec3;
  /** World radius, 0..1e6. Default 2. */
  radius?: number;
  /** Relative nonnegative weight, at most 1e6. Default 1. */
  intensity?: number;
  /**
   * Shadow bias in world units along the light's ray (drei's RandomizedLight `bias`, converted to world units):
   * positive also lets casters up to this far behind the plane shade it, negative drops casters within that distance
   * in front of it. -1e6..1e6. Default 0.
   */
  bias?: number;
  /**
   * Half side of the light's square shadow camera window in world units, perpendicular to the light's axis through
   * the plane centre (drei's `size`): receiver points outside it get no shadow from this light. Unset: no window.
   */
  size?: number;
  /**
   * Texels per side of that window (drei's `mapSize`, needs `size`): each receiver point filters the shadows of the
   * rays through its four nearest map texel centres, weighted bilinearly (2 x 2 percentage-closer filtering, Reeves,
   * Salesin and Cook 1987). Integer 1..16384. Unset: exact.
   */
  mapSize?: number;
  /**
   * Shadow camera near and far distances from the light along its axis (drei's `near` and `far`), as planes parallel
   * to the receiver at those distances on each sample's axis through the plane centre, measured from the light's
   * centre distance (a disk's radius does not move them): casters outside do not cast. Default 0 and Infinity.
   */
  near?: number;
  far?: number;
}
/** Several soft lights mixed with cosine-weighted sky occlusion. */
export interface AmbientShadowOptions extends AccumulatedShadowOptions {
  /** 0..64 disks. Default one disk from lightPosition/lightRadius; copied on construction. */
  lights?: readonly AccumulatedLight[];
  /** Sky share of total visibility, 0..1. Default 0.5. All-sky permits an empty lights array. */
  ambient?: number;
}

// Independent prime-base radical inverses decorrelate light selection, radius and azimuth.
function inverse(value: number, base: number): number {
  let sum = 0,
    weight = 1 / base;
  while (value > 0) {
    sum += (value % base) * weight;
    value = Math.floor(value / base);
    weight /= base;
  }
  return sum;
}

/** Progressive multi-light and hemispherical floor visibility; one projection per frame. */
export class AmbientShadows extends AccumulatedShadows {
  override readonly name = 'ambient-shadows';
  declare readonly options: AmbientShadowOptions;
  private readonly projected = new Float32Array(16);

  /** Copies disk positions; receiver and accumulation defaults are unchanged. */
  constructor(options: AmbientShadowOptions = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw rangeError('Invalid ambient shadow options; pass an options object', 'arguments');
    super({
      ...options,
      ...(Array.isArray(options?.lights)
        ? {
            lights: options.lights.map((l) => ({
              ...l,
              position: Array.isArray(l?.position) ? [...l.position] : l?.position,
            })),
          }
        : {}),
    });
  }
  /** Attach to the default scene; a secondary scene can use new AmbientShadows(options). */
  static override attach(engine: EngineKernel, options: AmbientShadowOptions = {}): AmbientShadows {
    const shadow = new AmbientShadows(options);
    engineRuntime(engine).use(shadow);
    return shadow;
  }
  private disks(s: ReturnType<AmbientShadows['settings']>): readonly AccumulatedLight[] {
    return this.options.lights === undefined
      ? [
          {
            position: (this.options.lightPosition ?? s.normal.map((v) => 8 * v)) as Vec3,
            radius: this.options.lightRadius ?? 2,
          },
        ]
      : this.options.lights;
  }
  protected override validateLighting(s: ReturnType<AmbientShadows['settings']>): void {
    const disks = this.disks(s),
      ambient = this.options.ambient ?? 0.5;
    const valid =
      Array.isArray(disks) &&
      disks.length <= 64 &&
      [...disks].every(
        (l) =>
          l &&
          Array.isArray(l.position) &&
          l.position.length === 3 &&
          [0, 1, 2].every((i) => Number.isFinite(l.position[i]) && Math.abs(l.position[i]) <= 1e6) &&
          Math.fround(s.normal.reduce((sum, v, i) => sum + v * (l.position[i] - [s.x, s.ground, s.z][i]), 0)) >
            Math.fround(s.height) &&
          Number.isFinite(l.radius ?? 2) &&
          (l.radius ?? 2) >= 0 &&
          (l.radius ?? 2) <= 1e6 &&
          Number.isFinite(l.intensity ?? 1) &&
          (l.intensity ?? 1) >= 0 &&
          (l.intensity ?? 1) <= 1e6 &&
          Number.isFinite(l.bias ?? 0) &&
          Math.abs(l.bias ?? 0) <= 1e6 &&
          (l.size === undefined || (Number.isFinite(l.size) && l.size > 0 && l.size <= 1e6)) &&
          (l.mapSize === undefined ||
            (l.size !== undefined && Number.isInteger(l.mapSize) && l.mapSize >= 1 && l.mapSize <= 16384)) &&
          Number.isFinite(l.near ?? 0) &&
          (l.near ?? 0) >= 0 &&
          !((l.far ?? Infinity) <= (l.near ?? 0)) &&
          !Number.isNaN(l.far ?? Infinity),
      );
    if (
      !Number.isFinite(ambient) ||
      ambient < 0 ||
      ambient > 1 ||
      !valid ||
      (ambient < 1 && !disks.some((l) => (l.intensity ?? 1) > 0))
    )
      throw rangeError(
        'Invalid ambient shadow lights; use ambient 0..1 and up to 64 finite nonnegative weighted disks above the caster slab, with a positive disk weight unless ambient is 1, bias within 1e6, size 0..1e6, mapSize 1..16384 with a size, and near 0 or more below far',
        'arguments',
      );
  }
  protected override lightingKey(s: ReturnType<AmbientShadows['settings']>): string {
    return [
      this.options.ambient ?? 0.5,
      ...this.disks(s).flatMap((l) => [
        ...l.position,
        l.radius ?? 2,
        l.intensity ?? 1,
        l.bias ?? 0,
        l.size ?? 0,
        l.mapSize ?? 0,
        l.near ?? 0,
        l.far ?? Infinity,
      ]),
    ].join('|');
  }
  protected override projection(s: ReturnType<AmbientShadows['settings']>): Float32Array {
    const index = this.samples + 1,
      ambient = this.options.ambient ?? 0.5,
      pick = inverse(index, 2),
      r = Math.sqrt(inverse(index, 3)),
      angle = 2 * Math.PI * inverse(index, 5),
      center = [s.x, s.ground, s.z],
      disks = this.disks(s),
      total = disks.reduce((sum, l) => sum + (l.intensity ?? 1), 0);
    const choose = (u: number) => {
      let weight = u * total,
        selected = disks[disks.length - 1];
      for (const disk of disks) {
        weight -= disk.intensity ?? 1;
        if (weight < 0) {
          selected = disk;
          break;
        }
      }
      return selected;
    };
    let h: number, x: number, z: number, point: boolean, selected: AccumulatedLight | undefined;
    if (pick < ambient) {
      // Cosine hemisphere: disk radius sqrt(u), height sqrt(1-u). No finite sky dome or horizon cutoff. The sample
      // takes the shadow camera of a light chosen by weight, as drei's lights jiggle over the sky with their own.
      h = Math.sqrt(1 - r * r);
      x = r * Math.cos(angle);
      z = r * Math.sin(angle);
      point = false;
      selected = disks.length && total > 0 ? choose(inverse(index, 7)) : undefined;
    } else {
      selected = choose((pick - ambient) / (1 - ambient));
      const light = selected;
      const local = (axis: readonly number[]) =>
        axis.reduce((sum, v, i) => sum + v * (light.position[i] - center[i]), 0);
      h = local(s.normal);
      x = local(s.u) + (light.radius ?? 2) * r * Math.cos(angle);
      z = local(s.v) + (light.radius ?? 2) * r * Math.sin(angle);
      point = true;
    }
    // Casters between heights low and high above the plane cast: the slab, cut by the light's bias and its near and
    // far planes. The shadow camera stands as far from the plane centre as the light's centre, on the sample's axis
    // through the plane centre (cos: that axis' slope to the plane), so a disk's spread does not move its planes.
    const distance = Math.hypot(x, h, z),
      cos = h / distance,
      reach = selected ? Math.hypot(...[0, 1, 2].map((i) => selected!.position[i] - center[i])) : Infinity,
      top = reach * cos;
    let low = -(selected?.bias ?? 0) * cos,
      high = s.height;
    if (selected && (point || selected.near !== undefined || selected.far !== undefined)) {
      high = Math.min(high, top - (selected.near ?? 0) * cos);
      low = Math.max(low, top - (selected.far ?? Infinity) * cos);
    }
    const m = this.projected;
    m.fill(0);
    // depth: z/w runs 0..1 from low to high; w is the distance below the light (point) or h (parallel).
    const k = point ? (h - high) / (high - low) : h / (high - low);
    for (let i = 0; i < 3; i++) {
      m[i * 4] = (2 * (h * s.u[i] - x * s.normal[i])) / s.width;
      m[i * 4 + 1] = (2 * (h * s.v[i] - z * s.normal[i])) / s.depth;
      m[i * 4 + 2] = k * s.normal[i];
      m[i * 4 + 3] = point ? -s.normal[i] : 0;
    }
    for (let row = 0; row < 4; row++)
      m[12 + row] = (row === 3 ? h : 0) - center.reduce((sum, v, i) => sum + v * m[i * 4 + row], 0);
    m[14] -= k * low;
    // No caster can lie between the planes: clip everything.
    if (!(high > low)) {
      for (let i = 0; i < 3; i++) m[i * 4 + 2] = 0;
      m[14] = -1;
    }
    const l = [x / distance, cos, z / distance];
    if (selected?.size === undefined) this.window = undefined;
    else {
      let e1 = [l[2], 0, -l[0]];
      const n1 = Math.hypot(...e1);
      e1 = n1 > 1e-9 ? e1.map((v) => v / n1) : [1, 0, 0];
      const e2 = [l[1] * e1[2] - l[2] * e1[1], l[2] * e1[0] - l[0] * e1[2], l[0] * e1[1] - l[1] * e1[0]];
      this.window = { light: l, e1, e2, size: selected.size, map: selected.mapSize ?? 0 };
    }
    return m;
  }
}
