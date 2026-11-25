/// <reference lib="esnext.disposable" preserve="true" />
// Wet ground where a flood has been (`@margoengine/terrain/wet-ground`): a terrain lighting effect that reads a wetting
// record, such as `Flood.wetTexture` of `@margoengine/water/flood` (rgba32float, a texel per flood cell: green the
// seconds since the cell was last wet, blue 1 once it has been wet), and draws the ground there darker and glossier,
// drying back over time.
//
// - Darker: wet soil, sand and rock lose albedo because the water film raises internal reflection inside the grains
//   (Lekner, Dorf 1988, "Why some things are darker when wet", Applied Optics 27(7) 1278-1280,
//   https://doi.org/10.1364/AO.27.001278; Twomey, Bohren, Mergenthaler 1986, Applied Optics 25(3) 431-437,
//   https://doi.org/10.1364/AO.25.000431). The fully wet albedo is the dry one times `darkening` (default 0.55, as
//   GroundChange's wet mud).
// - Glossier: the water fills the grain roughness, so the surface reads smoother; the roughness is scaled by
//   1 - `gloss` x wetness (default 0.5, as GroundChange).
// - Drying: a cell's wetness is exp(-t / `dryTime`) of the seconds t since it was last wet, 1 while under water.
//   A soil surface dries over hours to a day after wetting (Idso, Reginato, Jackson, Kimball, Nakayama 1974, "The three
//   stages of drying of a field soil", Soil Sci. Soc. Am. Proc. 38(5) 831-837,
//   https://doi.org/10.2136/sssaj1974.03615995003800050037x, whose surface albedo rose from wet to dry within about two
//   days); the default e-folding time of 3 hours sits in that range, and a shot sets a shorter one through `dryTime`.
// The record is read with textureLoad and blended bilinearly between texel centres (rgba32float is not filterable).
import { requireWebGPU } from '../../shared/require-webgpu.js';
import {
  numberSetting,
  liveSettings,
  settingDefaults,
  settingIndex,
  checkSettings,
  type SettingRow,
} from '../../shared/settings.js';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import type { Terrain, TerrainLighting } from './index.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number };

type Pair = readonly [number, number];
/** The look of wet ground; every field is live (one small uniform). */
export interface WetGroundLook {
  /** Albedo of fully wet ground, as a share of dry (1 is no darkening), 0 to 1. Default 0.55. */
  darkening?: number;
  /** Share by which fully wet ground is smoother (shinier), 0 to 1. Default 0.5. */
  gloss?: number;
  /** Seconds over which wetness falls to 1/e once the water has gone, 1 to 604,800 (a week). Default 10,800 (3 hours). */
  dryTime?: number;
}
/** Options of {@link WetGround.attach}. */
export interface WetGroundOptions extends WetGroundLook {
  /**
   * The wetting record, asked every frame (borrowed, never destroyed): an rgba32float 2D texture with TEXTURE_BINDING
   * whose green channel is the seconds since the texel was last wet and blue 1 once it has been wet, as
   * `Flood.wetTexture`. Undefined draws the ground dry.
   */
  record: () => GPUTexture | undefined;
  /** World [x, z] of the record's first texel's corner (a Flood's `origin`). */
  origin: Pair;
  /** World [width, depth] the record covers (a Flood's `size`). */
  size: Pair;
  /** The first of the two lighting-group bindings the effect declares. Default 116. */
  binding?: number;
}
const LOOK: Required<WetGroundLook> = { darkening: 0.55, gloss: 0.5, dryTime: 10800 };
const RANGES: Record<keyof WetGroundLook, Pair> = { darkening: [0, 1], gloss: [0, 1], dryTime: [1, 604800] };
const fragmentHead = '@fragment fn fragment(i:Output)->@location(0) vec4f {',
  colorHead = 'fn terrainColor(position:vec3f,normal:vec3f)->vec3f {';
const finitePair = (p: unknown, positive: boolean): boolean =>
  Array.isArray(p) &&
  p.length === 2 &&
  p.every((v) => typeof v === 'number' && Number.isFinite(v) && (!positive || v > 0));

let nextId = 0;
/**
 * Wet ground on a clipmap {@link Terrain} from a wetting record: darker and glossier where water has been, drying back
 * over time. `WetGround.attach(engine, terrain, { record: () => flood.wetTexture, origin, size })`. WebGPU (and the
 * WebGL2 compatibility layer).
 * @throws TypeError for a missing record function or terrain; RangeError for an origin, size, look value or binding out of range.
 * @throws MargoError `'disposed'` after `dispose()`, `'unsupported'` when the terrain's shader has no `terrainColor`.
 */
export class WetGround implements EnginePlugin, TerrainLighting, Disposable {
  readonly name = 'wet-ground:' + nextId++;
  /** Whether the effect has been disposed. */
  disposed = false;
  /** The current look (live). */
  readonly look: Required<WetGroundLook>;
  readonly origin: Pair;
  readonly size: Pair;
  readonly binding: number;
  readonly #record: () => GPUTexture | undefined;
  #terrain?: Terrain;
  #engine?: Engine;
  #remove?: () => void;
  #buffer?: GPUBuffer;
  #empty?: GPUTexture;
  #views = new WeakMap<GPUTexture, GPUTextureView>();
  #dirty = true;
  #data = new Float32Array(8);
  #shaders = new Map<string, string>();

  constructor(terrain: Terrain, options: WetGroundOptions) {
    if (!terrain || typeof terrain.addLighting !== 'function')
      throw new TypeError('WetGround needs a clipmap Terrain (@margoengine/terrain); pass the terrain to attach');
    if (!options || typeof options.record !== 'function')
      throw new TypeError(
        'WetGround needs record: a function returning the wetting record texture, such as () => flood.wetTexture',
      );
    if (!finitePair(options.origin, false) || !finitePair(options.size, true))
      throw new RangeError('WetGround needs a finite [x, z] origin and a positive finite [width, depth] size');
    const binding = options.binding ?? 116;
    if (!Number.isInteger(binding) || binding < 0 || binding > 998)
      throw new RangeError('WetGround binding must be an integer 0 to 998');
    this.#terrain = terrain;
    this.#record = options.record;
    this.origin = [options.origin[0], options.origin[1]];
    this.size = [options.size[0], options.size[1]];
    this.binding = binding;
    this.look = { ...LOOK };
    this.setLook(options);
  }

  /** Attaches wet ground to `terrain` on `engine`; the record texture stays borrowed. */
  static attach(engine: EngineKernel, terrain: Terrain, options: WetGroundOptions): WetGround {
    const wet = new WetGround(terrain, options);
    engineRuntime(engine).use(wet);
    return wet;
  }

  /** Sets any of `darkening`, `gloss` and `dryTime` (others keep theirs); nothing is rebuilt. */
  setLook(look: WetGroundLook): void {
    if (this.disposed) throw new MargoError('disposed', 'This WetGround was disposed; attach a new one');
    const next = { ...this.look };
    for (const key of Object.keys(RANGES) as (keyof WetGroundLook)[]) {
      const v = look[key];
      if (v === undefined) continue;
      const [lo, hi] = RANGES[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
        throw new RangeError(`WetGround ${key} must be a number from ${lo} to ${hi}`);
      next[key] = v;
    }
    Object.assign(this.look, next);
    this.#dirty = true;
  }

  /** The wetness 0..1 a record texel gives under the current look: blue x exp(-green / dryTime). */
  wetness(sinceWet: number, wasWet: number): number {
    return wasWet * Math.exp(-sinceWet / this.look.dryTime);
  }

  get owner(): Engine | undefined {
    return this.#engine;
  }

  setup(engine: Engine): void {
    requireWebGPU(engine, 'WetGround');
    if (this.disposed) throw new MargoError('disposed', 'This WetGround was disposed; attach a new one');
    this.#engine = engine;
    this.#create(engine.gpu!);
    this.#remove ??= this.#terrain!.addLighting(this);
  }

  onDeviceRestored(engine: Engine): void {
    this.#create(engine.gpu!);
  }

  #create(device: GPUDevice): void {
    this.#buffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#empty = device.createTexture({ size: [1, 1], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING });
    this.#views = new WeakMap();
    this.#dirty = true;
  }

  /** The lighting group entries: the record (or a dry texel) and the look. */
  bindings(): GPUBindGroupEntry[] {
    const device = this.#engine?.gpu;
    if (!device || !this.#buffer || !this.#empty) return [];
    if (this.#dirty) {
      const l = this.look;
      this.#data.set([this.origin[0], this.origin[1], this.size[0], this.size[1], l.darkening, l.gloss, l.dryTime, 0]);
      device.queue.writeBuffer(this.#buffer, 0, this.#data);
      this.#dirty = false;
    }
    const given = this.#record(),
      texture = given && given.format === 'rgba32float' ? given : this.#empty;
    if (given && given.format !== 'rgba32float')
      throw new TypeError(`WetGround's record must be rgba32float (Flood.wetTexture), not ${given.format}`);
    let view = this.#views.get(texture);
    if (!view) this.#views.set(texture, (view = texture.createView()));
    return [
      { binding: this.binding, resource: view },
      { binding: this.binding + 1, resource: { buffer: this.#buffer } },
    ];
  }

  /** The terrain's lit shader with `terrainColor` darkened and the roughness lowered by the wetness. */
  shader(source: string, group: number): string {
    const key = group + source,
      cached = this.#shaders.get(key);
    if (cached) return cached;
    if (source.split(fragmentHead).length !== 2 || source.split(colorHead).length !== 2)
      throw new MargoError(
        'unsupported',
        "WetGround needs the terrain's lit fragment shader and its terrainColor; attach it before effects that replace them",
      );
    const s = '_w' + this.name.slice(this.name.indexOf(':') + 1),
      b = this.binding;
    const own = /* wgsl */ `
@group(${group}) @binding(${b}) var wetRecord${s}:texture_2d<f32>;
@group(${group}) @binding(${b + 1}) var<uniform> wetLook${s}:array<vec4f,2>;
fn wetTexel${s}(c:vec2i)->f32 {let r=textureLoad(wetRecord${s},c,0);return r.z*exp(-r.y/max(wetLook${s}[1].z,1.0));}
fn wetAt${s}(p:vec3f)->f32 {
 let n=vec2i(textureDimensions(wetRecord${s}));let L=wetLook${s};let uv=(p.xz-L[0].xy)/L[0].zw;
 if(any(uv<vec2f(0))||any(uv>vec2f(1))){return 0.0;}
 let f=uv*vec2f(n)-0.5;let lo=clamp(vec2i(floor(f)),vec2i(0),n-1);let hi=min(lo+1,n-1);let w=clamp(f-floor(f),vec2f(0),vec2f(1));
 return mix(mix(wetTexel${s}(lo),wetTexel${s}(vec2i(hi.x,lo.y)),w.x),mix(wetTexel${s}(vec2i(lo.x,hi.y)),wetTexel${s}(hi),w.x),w.y);
}
`;
    const code =
      own +
      source
        .replace(colorHead, `fn terrainColorDry${s}(position:vec3f,normal:vec3f)->vec3f {`)
        .replace(fragmentHead, `fn wetGroundInner${s}(i:Output)->vec4f {`) +
      `\n${colorHead}return terrainColorDry${s}(position,normal)*mix(1.0,wetLook${s}[1].x,wetAt${s}(position));}` +
      `\n${fragmentHead}var j=i;j.material.x*=1.0-wetLook${s}[1].y*wetAt${s}(i.position);return wetGroundInner${s}(j);}`;
    if (this.#shaders.size >= 16) this.#shaders.clear();
    this.#shaders.set(key, code);
    return code;
  }

  /** Detaches from the terrain (its shader returns to what it was) and frees the uniform; the record stays borrowed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#remove?.();
    this.#remove = undefined;
    this.#buffer?.destroy();
    this.#empty?.destroy();
    this.#buffer = this.#empty = undefined;
    this.#shaders.clear();
    const engine = this.#engine;
    this.#engine = undefined;
    this.#terrain = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

// The slider rows on the shared row shape (packages/shared/settings.js, the model is @margoengine/sky/settings); every
// row is live, so any of them can be keyed over a shot.
/** One wet ground control. */
export interface WetGroundSetting extends SettingRow {
  readonly group: 'wet';
  readonly default: number;
}
const row = (
  name: string,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): WetGroundSetting => numberSetting(name, 'wet', value, min, max, step, unit, about) as WetGroundSetting;
/** Every wet ground control, in panel order; defaults are what WetGround uses without the option. */
export const WET_GROUND_SETTINGS: readonly WetGroundSetting[] = [
  row(
    'wet.darkening',
    LOOK.darkening,
    0,
    1,
    0.01,
    '',
    'Albedo of fully wet ground as a share of dry (1 is no darkening).',
  ),
  row('wet.gloss', LOOK.gloss, 0, 1, 0.01, '', 'Share by which fully wet ground is smoother (shinier).'),
  row(
    'wet.dryTime',
    LOOK.dryTime,
    1,
    604800,
    1,
    's',
    'Seconds over which wet ground dries to 1/e once the water has gone.',
  ),
];
/** The rows that can change every frame (all of them). */
export const WET_GROUND_LIVE_SETTINGS: readonly WetGroundSetting[] = liveSettings(
  WET_GROUND_SETTINGS,
) as WetGroundSetting[];
const BY_NAME = settingIndex(WET_GROUND_SETTINGS) as Map<string, WetGroundSetting>;
const KEYS: Record<string, keyof WetGroundLook> = {
  'wet.darkening': 'darkening',
  'wet.gloss': 'gloss',
  'wet.dryTime': 'dryTime',
};
/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function wetGroundSettingDefaults(): Record<string, number> {
  return settingDefaults(WET_GROUND_SETTINGS) as Record<string, number>;
}
/**
 * Sets the given rows on `ground` (names left out keep their current value). Nothing is rebuilt.
 * @throws TypeError for an unknown name; RangeError for a value out of range.
 */
export function applyWetGroundSettings(ground: WetGround, values: Readonly<Record<string, number>> = {}): void {
  checkSettings(BY_NAME, values, 'wet ground', 'the rows of WET_GROUND_SETTINGS in @margoengine/terrain/wet-ground');
  const look: WetGroundLook = {};
  for (const [name, v] of Object.entries(values)) look[KEYS[name]] = v;
  ground.setLook(look);
}
