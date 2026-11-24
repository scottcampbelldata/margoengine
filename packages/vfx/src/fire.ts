/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import { MargoError } from '@margoengine/math/errors';
import type { Clustered } from '@margoengine/clustered';
import { lineLights, type LineLight } from '@margoengine/clustered/line';
import type { LightGroup, LightGroups } from '@margoengine/clustered/groups';
import { animateFlicker } from '@margoengine/clustered/flicker';
import { VFX, type VFXOptions, type VFXWind } from '@margoengine/vfx/base';
import { curves } from '@margoengine/vfx/curves';
import { shapes } from '@margoengine/vfx/shapes';
import { soft } from '@margoengine/vfx/soft';
import { stretch } from '@margoengine/vfx/stretch';
import { overLife } from '@margoengine/vfx/over-life';
import { Flame, HEARTH_FLAME_LENGTH, puffingDiameter, scaleHearthEmbers } from '@margoengine/vfx/flame';
import { Smoke, type SmokeOptions } from '@margoengine/vfx/smoke';
import { schedule } from '@margoengine/vfx/schedule';
import { snowNight, type KitHearth, type KitParticles } from '@margoengine/sky/scene-kits';

type Vec3 = readonly [number, number, number];

/** `Fire.attach` settings. Only `position` is required. */
export interface FireOptions {
  /** Where the flames are born, on top of the fuel (the logs' tops), world units. */
  position: Vec3;
  /**
   * The fire's data: its light, flames, embers and steam. Default `snowNight().hearth` from `@margoengine/sky/scene-kits`,
   * a wood fire of about 1,900 K; pass another kit's `hearth` (or your own) to change the look.
   */
  hearth?: KitHearth;
  /** Scales the firelight's intensity and the flames' and embers' radiance together, 0 or more. Default 1. */
  power?: number;
  /** Length of the flame line along `axis`, metres, above 0. Default `hearth.light.length` (0.62), or the flame length with `flameLength`. */
  width?: number;
  /** Direction the flames run along (the logs), nonzero. Default [1, 0, 0]. */
  axis?: Vec3;
  /**
   * Where the firelight goes: a `LightGroups` (the fire takes a group of its own, `fire`, `fire 2`, ...) or a
   * `Clustered` (the fire then owns its whole list: use groups to keep lights of your own), attached to the same scene.
   * Omitted: the fire gives no light.
   */
  lights?: Clustered | LightGroups;
  /**
   * The firelight's soft shadows (`LocalShadows` from `@margoengine/clustered/shadows`, attached to the same
   * `Clustered` first). Default true.
   */
  castShadow?: boolean;
  /** Points on the flame line (`lineLights` samples), 1 to 8. Default 2. */
  samples?: number;
  /**
   * The scene depth (`DepthTexture` of `@margoengine/post/depth`), for flames, embers and steam that fade 0.08 m before
   * the logs and the grate instead of cutting into them. Default: none, hard-edged particles.
   */
  depth?: () => GPUTexture | undefined;
  /**
   * The flame length, metres, 0.05 to 1,000: the fire's flames become a `Flame` volume of `@margoengine/vfx/flame` that
   * long (house fires, burning ships, crowns): tapering tongues that puff at the Cetegen and Ahmed frequency, a
   * yellow-white core that cannot blow out, and, with `lights`, the flame's own light, which flickers with the puffing.
   * The embers' size, speed and life scale by the square root of the length over the hearth's
   * ({@link HEARTH_FLAME_LENGTH}). Set it later with `fire.flame.setLength`. Read at attach. Default: the hearth's own
   * flames (billboards) and firelight.
   */
  flameLength?: number;
  /** Size of the fire across its `axis`, metres, above 0, with `flameLength`. Default 0.6 of `width`. */
  breadth?: number;
  /** Sparks that rise from the fire. Default true. */
  embers?: boolean;
  /**
   * A smoke column over the flames (`Smoke` of `@margoengine/vfx/smoke`, as `fire.smoke`): true stands one on the flame
   * tips with the fire's convective heat (Heskestad's flame length turned back into a heat release, 70% of it
   * convective; Heskestad 1983, Drysdale 2011 ch. 4) over the flames' width, lit by the fire's `lights`; an object
   * gives it options of its own (colour, opacity, rate, lifetime, ...); false makes none. Read at attach. Default true
   * with `flameLength` (a large fire always smokes), false for the hearth's own flames (a wood hearth's thin smoke is
   * its `steam`).
   */
  smoke?: boolean | Omit<SmokeOptions, 'fire' | 'position' | 'heat'>;
  /** A kettle spout or pot: steam rises from this point. Default: no steam. */
  steam?: Vec3;
  /**
   * The wind, `[x, z]` m/s or `{sample(x, y, z, t)}` (a `WindField` fits): flames, embers and steam lean with it, by
   * `VFXOptions.wind` (a plume rising at w in a wind U leans atan(U / w)). Default none.
   */
  wind?: VFXWind;
}

/** The fire's particle effects. */
export interface FireParticles {
  /** The hearth's flame billboards; none with `flameLength` (the flames are then `Fire.flame`). */
  readonly flames?: VFX;
  readonly embers?: VFX;
  readonly steam?: VFX;
}

/** Rec. 709 luminance of a linear RGB colour. */
const luminance = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/**
 * The flames' brightest radiance (luminance): their intensity times their brightest colour over their life. Alpha-over
 * particles never show brighter than one particle's own colour, however many overlap.
 */
function flameRadiance(fire: KitParticles): number {
  const tint = fire.color.slice(0, 3),
    keys = fire.curves.color.length ? fire.curves.color.map((k) => k.color) : [[1, 1, 1]];
  return fire.intensity * Math.max(...keys.map((k) => luminance(k.map((v, i) => v * tint[i]))));
}

/** Soft-particle fade distance, metres, while the hearth data has none of its own (the Cabin Hearth's value). */
const SOFTNESS = 0.08;
let nextId = 0;

/**
 * A wood fire from one call: flames, embers and optional steam (`@margoengine/vfx`), and its light as a flickering
 * flame line of soft-shadowed points (`lineLights` of `@margoengine/clustered/line`) sized from the same data, so the
 * light, its shadows and the flames agree with no tuning. `power` sets the light and the flames' radiance together.
 * @throws TypeError for a position, axis or steam point that is not three finite numbers; RangeError for a power,
 * width or sample count out of range.
 * @throws MargoError `'state'` when the fire casts shadows and its `Clustered` has no `LocalShadows` attached.
 * A plugin of the scene it is attached to: disposing that scene disposes the fire.
 */
export class Fire implements EnginePlugin {
  readonly name = 'vfx-fire:' + nextId++;
  /** The firelight's points as last set (steady intensities; the flicker scales them each frame). */
  readonly lights: readonly LineLight[];
  readonly particles: FireParticles;
  /** The flame volume of a fire with a `flameLength` (its light is the flame's); undefined for hearth flames. */
  readonly flame?: Flame;
  /** The smoke column over the flames ({@link FireOptions.smoke}); undefined without one. */
  readonly smoke?: Smoke;
  private readonly target?: Clustered | LightGroup;
  /** The group the fire made in a `LightGroups`, disposed with it. */
  private readonly group?: LightGroup;
  private engine?: Engine;
  private readonly stopFlicker?: () => void;
  private disposed = false;
  private constructor(engine: EngineKernel, options: FireOptions) {
    const flameLength = options.flameLength;
    if (flameLength !== undefined && !(Number.isFinite(flameLength) && flameLength >= 0.05 && flameLength <= 1000))
      throw new RangeError('Fire flameLength must be a finite length from 0.05 to 1000 (metres)');
    const kit = options.hearth ?? snowNight().hearth,
      width = options.width ?? (flameLength === undefined ? kit.light.length : Math.max(kit.light.length, flameLength)),
      breadth = options.breadth ?? 0.6 * width,
      hearth = flameLength === undefined ? kit : { ...kit, embers: scaleHearthEmbers(kit.embers as never, flameLength, [width, breadth]) as typeof kit.embers, emberHeight: kit.emberHeight * Math.max(flameLength / HEARTH_FLAME_LENGTH, 1) },
      { light } = hearth,
      power = options.power ?? 1,
      axis = options.axis ?? [1, 0, 0],
      castShadow = options.castShadow ?? true;
    finiteVector(options.position, 3, 'Fire position');
    finiteVector(axis, 3, 'Fire axis');
    if (options.steam) finiteVector(options.steam, 3, 'Fire steam point');
    if (!(power >= 0 && Number.isFinite(power))) throw new RangeError('Fire power must be a finite number of 0 or more');
    if (!(width > 0 && Number.isFinite(width))) throw new RangeError('Fire width must be a finite length above 0 (metres)');
    if (!(breadth > 0 && Number.isFinite(breadth))) throw new RangeError('Fire breadth must be a finite length above 0 (metres)');
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    if (!length) throw new RangeError('Fire axis must be nonzero');
    const [x, y, z] = options.position,
      half = axis.map((v) => (v / length) * (width / 2)),
      centre = [x, y + light.height, z],
      // A reflection is never brighter than what it reflects: the sphere each point shows on a metal (radiance
      // intensity / (pi radius^2)) is at most as bright as the flames themselves (flameRadiance), so the kettle's
      // highlight stays under the fire it mirrors. Power scales both alike, so the size does not depend on it.
      glow = luminance(light.color) / (Math.PI * flameRadiance(hearth.fire));
    this.lights = Object.freeze(flameLength !== undefined ? [] :
      lineLights({
        start: [centre[0] - half[0], centre[1] - half[1], centre[2] - half[2]],
        end: [centre[0] + half[0], centre[1] + half[1], centre[2] + half[2]],
        range: light.range,
        intensity: light.intensity * power,
        color: [...light.color],
        samples: options.samples ?? (flameLength === undefined ? 2 : Math.min(8, Math.max(2, Math.ceil(width / (0.5 * flameLength))))),
        // The kit's radius belongs to its flame length; a wider or narrower fire scales it.
        radius: (light.radius * width) / light.length,
        castShadow,
        flicker: { ...light.flicker },
      }).map((point) => ({
        ...point,
        radius: Math.max(point.radius ?? 0, Math.sqrt((((point.intensity ?? 0) / power) || 0) * glow) || 0),
      })),
    );
    const lights = options.lights,
      groups = lights && 'names' in lights && 'clustered' in lights ? lights : undefined,
      clustered = groups ? groups.clustered : lights && 'maxLights' in lights ? lights : undefined;
    if (lights && !clustered)
      throw new TypeError('Invalid Fire lights; pass a Clustered from @margoengine/clustered or its LightGroups');
    if (flameLength === undefined && castShadow && clustered && !clustered.shadow)
      throw new MargoError(
        'state',
        'Fire casts soft shadows through LocalShadows; attach LocalShadows to its Clustered first, or pass castShadow: false',
      );
    // Every part is born at the fuel top; embers a little above it, steam at its own point.
    const part = (data: KitParticles, position: Vec3, scale: number) =>
      VFX.attach(
        engine,
        {
          ...(structuredClone(data) as unknown as VFXOptions),
          intensity: data.intensity * scale,
          ...(options.wind ? { wind: options.wind } : {}),
          position: [...position],
          // Soft where they meet the logs when the scene's depth is given; hard-edged particles otherwise.
          ...(options.depth ? { softness: Math.max(SOFTNESS, 0.1 * data.size), depth: options.depth } : {}),
        },
        { curves, emitter: shapes, soft, stretch, schedule, overLife },
      );
    // A large fire's flames are one volume that lights its surroundings itself, flickering with its puffing.
    if (flameLength !== undefined)
      this.flame = Flame.attach(engine, {
        position: options.position,
        length: flameLength,
        footprint: [width, breadth],
        yaw: Math.atan2(-axis[2], axis[0]),
        lightPower: power,
        ...(options.wind ? { wind: options.wind } : {}),
        ...(options.depth ? { depth: options.depth } : {}),
        ...(options.lights ? { lights: options.lights } : {}),
      });
    const flames = flameLength === undefined ? part(hearth.fire, options.position, power) : undefined,
      embers = options.embers === false ? undefined : part(hearth.embers, [x, y + hearth.emberHeight, z], power),
      steam = options.steam ? part(hearth.steam, options.steam, 1) : undefined;
    this.particles = Object.freeze({ flames, embers, steam });
    const smoke = options.smoke ?? flameLength !== undefined;
    if (smoke && typeof smoke !== 'boolean' && typeof smoke !== 'object')
      throw new TypeError('Invalid Fire smoke; pass true, false or Smoke options');
    if (smoke) {
      // The heat a flame that long over that footprint releases (Heskestad's correlation turned round), 70% convected.
      const L = flameLength ?? HEARTH_FLAME_LENGTH,
        D = puffingDiameter([width, breadth]),
        heat = 0.7 * 1000 * Math.pow(Math.max(L + 1.02 * D, 0) / 0.235, 2.5);
      this.smoke = Smoke.attach(engine, {
        radius: D / 2,
        ...(clustered ? { lights: clustered } : {}),
        ...(typeof smoke === 'object' ? smoke : {}),
        fire: this,
        position: [x, y + L, z],
        heat,
      });
    }
    if (clustered && flameLength === undefined) {
      if (groups) {
        let name = 'fire';
        for (let n = 2; groups.names.includes(name); n++) name = `fire ${n}`;
        this.target = this.group = groups.group(name);
      } else this.target = clustered;
      // One flicker for the whole line: the points share the kit's seed, so they rise and fall together.
      this.stopFlicker = animateFlicker(engine, this.target, this.lights);
    }
  }
  setup(engine: Engine): void {
    this.engine = engine;
  }
  /** Sets the wind of the flames, embers and steam (see {@link FireOptions.wind}); undefined removes it. */
  setWind(wind: VFXWind | undefined): this {
    for (const effect of [this.particles.flames, this.particles.embers, this.particles.steam]) effect?.setWind(wind);
    this.flame?.setWind(wind);
    return this;
  }
  /** Lights and particles for a fire at `options.position`; see {@link FireOptions}. */
  static attach(engine: EngineKernel, options: FireOptions): Fire {
    if (!options || typeof options !== 'object') throw new TypeError('Invalid Fire options; pass an object with a position [x, y, z]');
    const fire = new Fire(engine, options);
    engineRuntime(engine).use(fire);
    return fire;
  }
  /**
   * Removes the particles and the firelight (a group the fire made goes with it; a `Clustered` it lit is left empty
   * unless it was disposed first).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
    this.stopFlicker?.();
    // A group goes with the fire (its dispose never throws, whichever of it and its Clustered went first).
    if (this.group) this.group.dispose();
    else if (this.target && !this.target.isDisposed) this.target.setLights([]);
    for (const effect of [this.particles.flames, this.particles.embers, this.particles.steam]) effect?.dispose();
    this.flame?.dispose();
    this.smoke?.dispose();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
