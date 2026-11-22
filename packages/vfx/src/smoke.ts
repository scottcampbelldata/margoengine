/// <reference lib="esnext.disposable" preserve="true" />
// A smoke column from one call: soft lit puffs that rise by the buoyant plume law, widen as they entrain air, lean
// with the wind and level off in stable air. Sources (papers, read as text; no code; docs/clean-room.md "Smoke column"):
// - B. R. Morton, G. I. Taylor and J. S. Turner, "Turbulent gravitational convection from maintained and instantaneous
//   sources", Proc. R. Soc. Lond. A 234(1196), 1-23, 1956, https://doi.org/10.1098/rspa.1956.0011: the plume above a
//   point source of buoyancy in calm air entrains at a rate alpha w (alpha 0.093), so its radius grows as
//   (6/5) alpha z and its rise speed falls as z^(-1/3).
// - G. A. Briggs, "Plume Rise", USAEC Critical Review Series TID-25075, 1969, https://www.osti.gov/biblio/4743102: the
//   buoyancy flux F = g Q_H / (pi c_p rho T) of a heat emission Q_H (eq. 4.20), MTT's entrainment constant 0.093
//   (eq. 4.22); in a wind U the bent-over plume's "2/3 law" rise 1.6 F^(1/3) U^(-1) x^(2/3) (eq. 4.31), whose
//   characteristic radius is gamma z with gamma about 0.5 (eq. 4.23); in stable air of stability s = (g / T) dtheta/dz
//   the final rise 5.0 F^(1/4) s^(-3/8) in calm air (eq. 4.25) and 2.9 (F / (U s))^(1/3) in a wind (eq. 5.7).
//
// The column's rise at age t is the lower of the calm plume (MTT, from a virtual origin z0 = r0 / ((6/5) alpha) below
// a source of radius r0) and the bent-over plume (Briggs, x = U t, from the virtual origin where gamma z = r0), capped
// at the stable final rise: a plume rises straight off its source, bends over as the wind takes it and levels off
// where it is no lighter than the air. Each puff is a `VFX` particle; its speed over life follows the column's rise
// speed and its size the column's radius (`overLife`), so the column of puffs is the plume. The horizontal velocity
// relaxes toward the wind (`VFXOptions.wind`), so the column leans atan(U / w). A puff is a parcel of air, so in calm
// air too its horizontal velocity relaxes, toward rest, with the same 0.25 s time constant (Crowe et al., Multiphase
// Flows with Droplets and Particles, 2nd ed., CRC 2011, eq. 1.5): the curl-noise churn then stirs the column instead
// of adding up, over a minute's life, into a walk of hundreds of metres that laid the smoke along the ground and over
// the camera as a dark veil (KB-FIRE-SMOKEVEIL1).
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import {
  VFX,
  type FogLike,
  type VFXLightSource,
  type VFXLit,
  type VFXOptions,
  type VFXTexture,
  type VFXWind,
} from '@margoengine/vfx/base';
import { curves } from '@margoengine/vfx/curves';
import { soft } from '@margoengine/vfx/soft';
import { lit } from '@margoengine/vfx/lit';
import { overLife } from '@margoengine/vfx/over-life';
import { nodes } from '@margoengine/vfx/nodes';
import { schedule } from '@margoengine/vfx/schedule';
import { textureFeature } from '@margoengine/vfx/texture';

type Vec3 = readonly [number, number, number];

/**
 * Still-air drag on a puff's horizontal velocity, per second: the 0.25 s relaxation `VFXOptions.wind` gives toward a
 * wind, here toward rest when there is none.
 */
const STILL_AIR_DRAG = 4;
/** MTT 1956's entrainment constant for a plume in calm air (Briggs 1969 eq. 4.22). */
export const PLUME_ENTRAINMENT = 0.093;
/** Briggs 1969's radius of a bent-over plume over its rise (eq. 4.23, about 0.5 from the TVA photographs). */
export const BENT_PLUME_RADIUS = 0.5;
/** Briggs 1969's "2/3 law" constant: rise 1.6 F^(1/3) U^(-1) x^(2/3) (eq. 4.31). */
export const TWO_THIRDS_LAW = 1.6;
/** Briggs 1969's final rise in stable calm air, 5.0 F^(1/4) s^(-3/8) (eq. 4.25). */
export const STABLE_CALM_RISE = 5.0;
/** Briggs 1969's final rise in stable air with a wind, 2.9 (F / (U s))^(1/3) (eq. 5.7). */
export const STABLE_WIND_RISE = 2.9;
const GRAVITY = 9.81,
  AIR_DENSITY = 1.225,
  AIR_HEAT = 1005;
/** Samples of the speed and size curves over a puff's life (the most `overLife` takes). */
const SAMPLES = 32;
/** Seconds a new puff takes to show fully: smoke leaves the flames already dense (KB-VFX-SMOKEROPE1: the old ramp was a fifth of the life, 12 s of a 60 s life). */
export const SMOKE_FADE_IN = 1;
/**
 * The share of a fire's heat it radiates (Drysdale, An Introduction to Fire Dynamics, 3rd ed., Wiley 2011, ch. 2: 0.2
 * to 0.4 for hydrocarbon and wood flames; McGrattan, Baum and Hamins, NISTIR 6546, 2000: about 0.3 falling for very
 * large fires). The column's glow from below radiates this over the convective 0.7 of the release.
 */
export const RADIANT_FRACTION = 0.3;

/**
 * A puff's opacity over its normalized life: full after {@link SMOKE_FADE_IN} seconds whatever the lifetime (within the
 * 32 samples' spacing: a long life starts part-opaque, with the fade's mean opacity over its first sample), then
 * the column's old shape (full to 0.4 of the life, 0.85 at 0.6, 0.5 at 0.8, gone at the end), 32 samples.
 */
export function smokeAlphaCurve(lifetime: number): number[] {
  const out: number[] = [],
    tail = [1, 1, 1, 0.85, 0.5, 0];
  for (let k = 0; k < SAMPLES; k++) {
    const u = k / (SAMPLES - 1),
      x = u * 5,
      i = Math.min(4, Math.floor(x)),
      shape = tail[i]! + (tail[i + 1]! - tail[i]!) * (x - i);
    out.push(Math.max(0, Math.min(1, Math.min(1, (u * lifetime) / SMOKE_FADE_IN) * shape)));
  }
  // The first interval of a long life is wider than the fade: its start takes the value whose straight line to the
  // next sample has the fade's mean opacity there (1 - F / spacing), so a puff is not hidden for a whole sample.
  out[0] = Math.max(0, 1 - SMOKE_FADE_IN / (lifetime / (SAMPLES - 1)));
  return out;
}

/**
 * Buoyancy flux F, m^4/s^3, of a heat emission: F = g Q / (pi c_p rho T) (Briggs 1969 eq. 4.20), with sea-level air
 * (rho 1.225 kg/m^3, c_p 1,005 J/(kg K)). A 1 MW fire gives about 8.8.
 * @param heat Convective heat release, watts, 0 or more.
 * @param airTemperature Air temperature, kelvin. Default 288.15.
 */
export function buoyancyFlux(heat: number, airTemperature = 288.15): number {
  if (!(heat >= 0 && Number.isFinite(heat)))
    throw new RangeError('Smoke heat must be a finite number of watts, 0 or more');
  if (!(airTemperature > 0 && Number.isFinite(airTemperature)))
    throw new RangeError('Smoke airTemperature must be a finite temperature above 0 K');
  return (GRAVITY * heat) / (Math.PI * AIR_DENSITY * AIR_HEAT * airTemperature);
}

/**
 * The stability s, 1/s^2, of air whose potential temperature rises `lapse` kelvin a metre: s = (g / T) dtheta/dz
 * (Briggs 1969). Neutral air is 0; an isothermal layer (dtheta/dz about 0.0098 K/m) gives about 3.3e-4.
 */
export function airStability(lapse: number, airTemperature = 288.15): number {
  if (!Number.isFinite(lapse) || lapse < 0)
    throw new RangeError('Smoke lapse must be a finite rise of 0 or more kelvin a metre');
  return (GRAVITY / airTemperature) * lapse;
}

/** The column at one age, from {@link plumeRise}. */
export interface PlumePoint {
  /** Height above the source, metres. */
  rise: number;
  /** Rise speed, m/s. */
  speed: number;
  /** Column radius, metres. */
  radius: number;
  /** True where the bent-over plume (the wind's) is the lower one. */
  bent: boolean;
  /** True where the column has reached its final rise in stable air. */
  level: boolean;
}

/**
 * The smoke column `seconds` after a puff left the source: the lower of the calm plume of MTT 1956 and the bent-over
 * plume of Briggs 1969, capped at Briggs' final rise in stable air (see the module notes), with its radius.
 * @param flux Buoyancy flux, m^4/s^3 ({@link buoyancyFlux}), 0 or more.
 * @param wind Wind speed, m/s, 0 or more (0 is calm: no bending).
 * @param radius Source radius, metres, above 0.
 * @param stability Air stability s, 1/s^2, 0 or more ({@link airStability}); 0 is neutral (no ceiling). Default 0.
 */
export function plumeRise(
  seconds: number,
  flux: number,
  wind: number,
  radius: number,
  stability = 0,
  out?: PlumePoint,
): PlumePoint {
  const a = PLUME_ENTRAINMENT,
    W = Math.cbrt((25 * flux) / (48 * a * a)),
    z0 = radius / (1.2 * a),
    t = Math.max(0, seconds),
    Z = t > 0 ? ((4 / 3) * W * t + z0 ** (4 / 3)) ** 0.75 : z0,
    calm = Z - z0,
    calmSpeed = W / Math.cbrt(Z),
    p = out ?? { rise: 0, speed: 0, radius: 0, bent: false, level: false };
  p.rise = calm;
  p.speed = calmSpeed;
  p.radius = 1.2 * a * Z;
  p.bent = false;
  p.level = false;
  if (wind > 1e-6) {
    // The bent-over plume from its own virtual origin: the 2/3 law's radius gamma z is r0 a time tv before the
    // source, so the column leaves the source at its width and at a finite speed.
    const k = TWO_THIRDS_LAW * Math.cbrt(flux / wind),
      zv = radius / BENT_PLUME_RADIUS,
      tv = (zv / k) ** 1.5,
      bent = k * (t + tv) ** (2 / 3) - zv,
      bentSpeed = ((2 / 3) * k) / Math.cbrt(t + tv);
    // At the source both rises are 0: the slower one is the one the column follows from there.
    if (t > 0 ? bent < calm : bentSpeed < calmSpeed) {
      p.rise = bent;
      p.speed = bentSpeed;
      p.radius = BENT_PLUME_RADIUS * (bent + zv);
      p.bent = true;
    }
  }
  if (stability > 0) {
    const ceiling =
      wind > 1e-6
        ? Math.min(
            STABLE_WIND_RISE * Math.cbrt(flux / (wind * stability)),
            STABLE_CALM_RISE * flux ** 0.25 * stability ** -0.375,
          )
        : STABLE_CALM_RISE * flux ** 0.25 * stability ** -0.375;
    if (p.rise >= ceiling) {
      // Levelled off: the column spreads at the height it reached and stops rising.
      p.rise = ceiling;
      p.speed = 0;
      p.level = true;
    }
  }
  return p;
}

/** Where the smoke comes from: a `Fire` of `@margoengine/vfx/fire` (its flames' position and wind). */
export interface SmokeSource {
  /** Hearth flames. */
  readonly particles: { readonly flames?: VFX };
  /** The flame volume of a large fire (`Fire` with a `flameLength`). */
  readonly flame?: { readonly options: { readonly position: Vec3; readonly wind?: VFXWind } };
}
/** Where a fire's flames are and the wind they lean in. */
const flameOf = (fire: SmokeSource | undefined): { position?: Vec3; wind?: VFXWind } | undefined =>
  (fire?.particles.flames?.options as { position?: Vec3; wind?: VFXWind } | undefined) ?? fire?.flame?.options;

/**
 * `Smoke.attach` settings. `position` or `fire` is required. Read every frame (change a field and the next frame shows
 * it) except `lifetime`, `prewarm`, `texture`, `lights`, `shadows` and `depth`, which are read at attach.
 */
export interface SmokeOptions {
  /** The source, world units (the top of the fire). Default: the fire's flames' position. */
  position?: Vec3;
  /**
   * A `Fire` to feed the column: the column stands on its flames and follows their wind (the fire's own, or the one a
   * `WeatherDrive` writes) unless the smoke has a wind of its own. Default none.
   */
  fire?: SmokeSource;
  /** Convective heat release, watts, 0 or more: it sets the rise. Default 5,000,000 (a house fire); 20,000 with `fire` (a wood hearth). */
  heat?: number;
  /** Source radius, metres, above 0. Default 2; 0.3 with `fire`. */
  radius?: number;
  /** Air temperature, kelvin, for the buoyancy flux. Default 288.15. */
  airTemperature?: number;
  /**
   * Air stability s = (g / T) dtheta/dz, 1/s^2, 0 or more ({@link airStability}): above 0 the column levels off at
   * Briggs' final rise and spreads there. Default 0 (neutral air, no ceiling).
   */
  stability?: number;
  /**
   * The wind, `[x, z]` m/s or `{sample(x, y, z, t)}` (a `WindField` fits): the column bends over by Briggs' law and
   * leans atan(U / w). Default none, and then a `WeatherDrive` in the scene writes the weather's wind; a wind given
   * here overrides the weather (the rule of `Fire`).
   */
  wind?: VFXWind;
  /** Seconds a puff lives: the column's height is its rise at this age. Above 0, at most 3,600. Read at attach. Default 60. */
  lifetime?: number;
  /** Puffs born a second, above 0 (at most the capacity, `rate x lifetime`, that attach made). Default 20. */
  rate?: number;
  /** Smoke colour, linear RGB 0..1. Default [0.3, 0.29, 0.28] (wood smoke grey). */
  color?: Vec3;
  /** Opacity of a puff, 0..1. Default 0.5. */
  opacity?: number;
  /** Curl-noise churn, m/s^2, 0 or more. Default 0.4 (0 for a smooth column). */
  turbulence?: number;
  /** Fill the column before the first frame (simulated in steps of 0.1 s, or a 600th of a long life). Read at attach. Default true. */
  prewarm?: boolean;
  /**
   * The fire's glow on the column from below: the puffs are lit by a point source at the source position radiating
   * {@link RADIANT_FRACTION} of the fire's release (0.3 / 0.7 of `heat`), over the source radius (`VFXLit.glow`), so
   * the column over a fire is lit orange from below, at night with no other light. A multiplier of that power, 0 (off)
   * to 10. Read every frame. Default 1.
   */
  glow?: number;
  /** A puff sprite (RGBA8 sRGB, alpha the coverage), multiplied by the colour. Read at attach. Default: a soft disc. */
  texture?: VFXTexture;
  /** Point and spot lights on the puffs (`Clustered` of `@margoengine/clustered`). Read at attach. Default: the sun and ambient only. */
  lights?: VFXLightSource;
  /** Sun shadows on the puffs (`Shadows` of `@margoengine/shadows`). Read at attach. Default none. */
  shadows?: VFXLightSource;
  /** The scene depth (`DepthTexture` of `@margoengine/post/depth`): puffs fade 1 m before surfaces. Read at attach. Default: hard-edged. */
  depth?: () => GPUTexture | undefined;
}

const windSpeed = (wind: unknown, at: Vec3, time: number): number => {
  if (!wind) return 0;
  if (typeof wind === 'object' && 'sample' in (wind as object)) {
    const v = (wind as { sample(x: number, y: number, z: number, t: number): readonly number[] }).sample(
      at[0],
      at[1],
      at[2],
      time,
    );
    return Math.hypot(v[0], v[2]);
  }
  const v = wind as readonly number[];
  return Math.hypot(v[0], v[1]);
};
const unit = (v: number, label: string, min: number, max: number, open = false): number => {
  if (!(Number.isFinite(v) && (open ? v > min : v >= min) && v <= max))
    throw new RangeError(
      `Smoke ${label} is ${v}; pass a finite number ${open ? 'above' : 'from'} ${min} ${open ? 'and at most' : 'to'} ${max}`,
    );
  return v;
};

let nextId = 0;

/**
 * A smoke column: lit soft puffs (`@margoengine/vfx` particles with `lit`, `overLife` and `curves`) that rise by the
 * plume law of MTT 1956 and Briggs 1969 for the given heat, widen as they rise, lean with the wind and level off in
 * stable air. The wind is read each frame (its own, the fire's, or the weather's through a `WeatherDrive`), and the
 * column's speed and size curves are rewritten in place: no GPU object is made after attach. The same frames give the
 * same pictures.
 * @throws TypeError for a missing source or a position that is not three numbers; RangeError for an option out of range.
 * A plugin of the scene it is attached to: disposing that scene disposes the smoke.
 */
export class Smoke implements EnginePlugin {
  readonly name = 'vfx-smoke:' + nextId++;
  /** The puffs (`smoke.effect.setFog(fog)` fogs them). */
  readonly effect: VFX;
  /** Read every frame; see {@link SmokeOptions}. */
  readonly options: SmokeOptions;
  /** Puff slots, `rate x lifetime` at attach. */
  readonly capacity: number;
  private engine?: Engine;
  private disposed = false;
  private clock = 0;
  private readonly lifetime: number;
  private readonly speed: number[] = new Array(SAMPLES).fill(1);
  private readonly size: number[] = new Array(SAMPLES).fill(1);
  private readonly point: PlumePoint = { rise: 0, speed: 0, radius: 0, bent: false, level: false };
  private readonly key = [NaN, NaN, NaN, NaN, NaN];
  private readonly velocity: [number, number, number] = [0, 0, 0];
  private readonly extent: [number, number, number] = [0, 0, 0];
  private readonly rgba: [number, number, number, number] = [0, 0, 0, 0];
  private readonly at: [number, number, number] = [0, 0, 0];
  private ownWind: VFXWind | undefined;
  /** The still-air drag on the puffs' horizontal velocity, per second, as a node constant: 0 while a wind applies. */
  private readonly still: [number, number, number] = [-STILL_AIR_DRAG, 0, -STILL_AIR_DRAG];
  private readonly lit: VFXLit;
  private readonly glowAt: [number, number, number] = [0, 0, 0];
  private constructor(engine: EngineKernel, options: SmokeOptions) {
    const fire = options.fire;
    if (fire && !fire.particles?.flames && !fire.flame?.options)
      throw new TypeError('Invalid Smoke fire; pass a Fire from @margoengine/vfx/fire');
    this.options = options;
    this.lifetime = unit(options.lifetime ?? 60, 'lifetime', 0, 3600, true);
    if (options.prewarm !== undefined && typeof options.prewarm !== 'boolean')
      throw new TypeError('Smoke prewarm must be true or false');
    const rate = unit(options.rate ?? 20, 'rate', 0, 100000, true);
    this.capacity = Math.max(64, Math.ceil(rate * this.lifetime * 1.05) + 16);
    this.lit = {
      wrap: 0.6,
      ...(options.lights ? { lights: options.lights } : {}),
      ...(options.shadows ? { shadows: options.shadows } : {}),
    };
    this.check();
    this.write();
    const vfx: VFXOptions = {
      capacity: this.capacity,
      rate,
      position: [...this.at],
      velocity: [...this.velocity],
      spread: 0,
      gravity: [0, 0, 0],
      color: [...this.rgba],
      size: 2 * this.radius(),
      lifetime: [this.lifetime, this.lifetime],
      ground: -1e9,
      turbulence: this.options.turbulence ?? 0.4,
      frequency: 1 / (8 * this.radius()),
      emissionExtent: [...this.extent],
      angularVelocity: 0.05,
      ...(options.wind ? { wind: options.wind } : {}),
      ...(options.texture ? { texture: options.texture } : {}),
      curves: { alpha: smokeAlphaCurve(this.lifetime) },
      overLife: { speed: this.speed, size: this.size },
      lit: this.lit,
      ...(options.depth ? { softness: 1, depth: options.depth } : {}),
      ...((options.prewarm ?? true)
        ? { schedule: { prewarm: this.lifetime, step: Math.max(0.1, this.lifetime / 600) } }
        : {}),
      nodes: {
        graph: [
          { op: 'attribute', value: 'velocity' },
          { op: 'const', value: this.still },
          { op: 'mul', inputs: [0, 1] },
          { op: 'force', inputs: [2] },
        ],
      },
    };
    this.ownWind = options.wind;
    this.calm(vfx.wind ?? flameOf(fire)?.wind);
    this.effect = VFX.attach(engine, vfx, { curves, soft, lit, overLife, schedule, texture: textureFeature, nodes });
  }
  /** Turns the still-air drag on when no wind moves the puffs (none, [0, 0], or a field that is calm here now). */
  private calm(wind: VFXWind | undefined): void {
    let x = 0,
      z = 0;
    if (wind && 'sample' in wind) {
      const v = wind.sample(this.at[0], this.at[1], this.at[2], this.clock);
      x = v[0];
      z = v[2];
    } else if (wind) {
      x = wind[0];
      z = wind[1];
    }
    this.still[0] = this.still[2] = x === 0 && z === 0 ? -STILL_AIR_DRAG : 0;
  }
  private heat(): number {
    return this.options.heat ?? (this.options.fire ? 20000 : 5e6);
  }
  private radius(): number {
    return this.options.radius ?? (this.options.fire ? 0.3 : 2);
  }
  /** Checks every frame-read option and copies the source, colour and extent into place (no allocation). */
  private check(): void {
    const o = this.options,
      position = o.position ?? flameOf(o.fire)?.position;
    if (!position) throw new TypeError('Smoke needs a position [x, y, z] or a fire');
    finiteVector(position, 3, 'Smoke position');
    this.at[0] = position[0];
    this.at[1] = position[1];
    this.at[2] = position[2];
    buoyancyFlux(this.heat(), o.airTemperature);
    const radius = unit(this.radius(), 'radius', 0, 10000, true);
    unit(o.stability ?? 0, 'stability', 0, 1);
    unit(o.rate ?? 20, 'rate', 0, 100000, true);
    unit(o.turbulence ?? 0.4, 'turbulence', 0, 1000);
    const opacity = unit(o.opacity ?? 0.5, 'opacity', 0, 1),
      color = o.color ?? [0.3, 0.29, 0.28];
    finiteVector(color, 3, 'Smoke color');
    for (let i = 0; i < 3; i++) this.rgba[i] = unit(color[i], 'color channel', 0, 1);
    this.rgba[3] = opacity;
    this.extent[0] = this.extent[2] = radius * 0.7;
    const glow = unit(o.glow ?? 1, 'glow', 0, 10);
    // The glow: a point at the source radiating RADIANT_FRACTION of the release (heat is its convective 0.7).
    if (glow > 0) {
      this.glowAt[0] = this.at[0];
      this.glowAt[1] = this.at[1];
      this.glowAt[2] = this.at[2];
      const g = (this.lit.glow ??= { position: this.glowAt, power: 0 });
      g.position = this.glowAt;
      g.power = ((glow * RADIANT_FRACTION) / 0.7) * this.heat();
      g.radius = Math.max(radius, 0.01);
    } else delete this.lit.glow;
  }
  /** The wind the column follows this frame: its own, else what the fire or the weather wrote on the puffs. */
  private wind(): number {
    const own = this.options.wind ?? this.effect?.options.wind ?? flameOf(this.options.fire)?.wind;
    return windSpeed(own, this.at, this.clock);
  }
  /** Rewrites the speed and size curves in place for this flux, wind and air (no allocation). */
  private write(): void {
    const o = this.options,
      flux = buoyancyFlux(this.heat(), o.airTemperature),
      radius = this.radius(),
      wind = this.wind(),
      stability = o.stability ?? 0,
      key = this.key;
    if (key[0] === flux && key[1] === wind && key[2] === radius && key[3] === stability && key[4] === this.lifetime)
      return;
    key[0] = flux;
    key[1] = wind;
    key[2] = radius;
    key[3] = stability;
    key[4] = this.lifetime;
    // Births leave at the calm plume's source speed, which no wind changes, so a puff in flight keeps its curve's
    // scale when the wind turns; the curve starts below 1 where the bent-over plume is slower at the source.
    const p = this.point,
      w0 = plumeRise(0, flux, 0, radius, 0, p).speed;
    this.velocity[1] = w0;
    for (let k = 0; k < SAMPLES; k++) {
      plumeRise((k / (SAMPLES - 1)) * this.lifetime, flux, wind, radius, stability, p);
      this.speed[k] = w0 > 0 ? Math.min(1000, p.speed / w0) : 0;
      this.size[k] = Math.min(1000, p.radius / radius);
    }
  }
  /** The column now: rise, speed and radius at a puff age of `seconds` for the wind it follows this frame. */
  column(seconds: number): PlumePoint {
    const o = this.options;
    return plumeRise(
      seconds,
      buoyancyFlux(this.heat(), o.airTemperature),
      this.wind(),
      this.radius(),
      o.stability ?? 0,
    );
  }
  setup(engine: Engine): void {
    this.engine = engine;
  }
  /** Seconds on the column's clock: the sum of its frame deltas. */
  get time(): number {
    return this.clock;
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  /**
   * Moves the column's clock by `delta` seconds (0 or less moves nothing) and sets its puffs' wind, rate and curves for
   * that time: the CPU part of its frame update, with no GPU call, which a seek from `@margoengine/cutscene/seek`
   * replays. The puffs' own effect is a plugin attached before the column and keeps its own clock, so a seek moves both
   * in the order a continuous run does (GAP-FILM-TIME).
   */
  advanceTime(delta: number): void {
    if (this.disposed) return;
    this.clock += delta > 0 ? delta : 0;
    const o = this.options,
      e = this.effect,
      eo = e.options,
      fire = flameOf(o.fire);
    this.check();
    // A wind of its own goes on the puffs; taking it away gives them back to the fire or the weather.
    if (o.wind !== this.ownWind) {
      e.setWind(o.wind);
      this.ownWind = o.wind;
    }
    if (!o.wind && fire && eo.wind !== fire.wind) e.setWind(fire.wind);
    this.calm(eo.wind);
    this.write();
    const radius = this.radius();
    eo.position = this.at;
    eo.velocity = this.velocity;
    eo.emissionExtent = this.extent;
    eo.color = this.rgba;
    eo.size = 2 * radius;
    eo.frequency = 1 / (8 * radius);
    eo.rate = o.rate ?? 20;
    eo.turbulence = o.turbulence ?? 0.4;
  }
  /**
   * Empties the column and fills it again on the next frame for the options as they are then (the prewarm of attach,
   * when `prewarm` is on): for a column moved to a new fire, so it does not grow up from the ground over its lifetime.
   */
  refill(): this {
    this.effect.reset();
    return this;
  }
  /** Sets the heat release, watts (see {@link SmokeOptions.heat}); the column answers from the next frame. */
  setHeat(heat: number): this {
    buoyancyFlux(heat, this.options.airTemperature);
    this.options.heat = heat;
    return this;
  }
  /** Sets the column's own wind (see {@link SmokeOptions.wind}); undefined gives it back to the fire or the weather. */
  setWind(wind: VFXWind | undefined): this {
    this.effect.setWind(wind);
    this.options.wind = this.ownWind = wind;
    return this;
  }
  /** Fogs the puffs (`Fog` of `@margoengine/environment`, read every frame); null for none. */
  setFog(fog: FogLike | null): this {
    this.effect.setFog(fog);
    return this;
  }
  /** A smoke column at `options.position` or over `options.fire`; see {@link SmokeOptions}. */
  static attach(engine: EngineKernel, options: SmokeOptions): Smoke {
    if (!options || typeof options !== 'object')
      throw new TypeError('Invalid Smoke options; pass {position: [x, y, z]} or {fire}');
    const smoke = new Smoke(engine, options);
    engineRuntime(engine).use(smoke);
    return smoke;
  }
  /** Removes the puffs. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
    this.effect.dispose();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
