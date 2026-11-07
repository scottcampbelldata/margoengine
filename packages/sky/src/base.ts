/// <reference lib="esnext.disposable" preserve="true" />
import { ditherShader } from '../../shared/dither.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { fullscreen, group, compute, dispatch } from '../../shared/gpu.js';
import { overlayPass } from '../../shared/pass.js';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { margoError } from '../../shared/errors.js';
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { celestialShader } from './celestial.js';
import { head, mid, transmittance, sunlight } from './atmosphere.js';
import { displayShader } from '../../shared/display.js';
import { applyView } from '../../shared/view-rect.js';
export { sunlight } from './atmosphere.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { STORAGE_BINDING: number; TEXTURE_BINDING: number };
type SkyPassContext = Extract<PassContext, { backend: 'webgpu' }>;
const moonColor: Vec3 = [0.25, 0.45, 0.75];
/**
 * `lighting` option (needs the `lighting` feature): the sky drives the engine's directional light from the sun and
 * moon and, with `ambient`, lights PBR meshes from the sky. Colours are linear RGB. Invalid values throw RangeError.
 */
export interface SkyLightingOptions {
  /** Direct sun strength with the sun overhead (default 1); the atmosphere's transmittance dims and warms it lower down. */
  intensity?: number;
  /** Floor for the engine light's strength (default 0). */
  minimum?: number;
  /** Sun colour with the sun overhead, linear RGB (default white); the transmittance tints it toward the horizon. */
  color?: Vec3;
  /** @deprecated Ignored: the atmosphere's transmittance now colours the low sun. Still validated. */
  sunset?: Vec3;
  /**
   * Moonlight; omitted means no moon light. `intensity` (>= 0) defaults to a tenth of the sun's, `color` to
   * [0.25, 0.45, 0.75].
   */
  moon?: { intensity?: number; color?: Vec3 };
  /**
   * Lights core's PBR meshes from the sky itself (directional diffuse from spherical harmonics and sky reflections),
   * with this RGB floor by day and by night, blended by `nightFactor`, as the least diffuse light any side receives.
   */
  ambient?: { day: Vec3; night: Vec3 };
}
/** `clouds` option (needs the `clouds` feature): an animated procedural cloud sheet. Invalid values throw RangeError. */
export interface SkyCloudOptions {
  /** Sky fraction covered, 0..1. Default 0.45. */
  coverage?: number;
  /** Drift in metres per second along a fixed XZ direction, -100..100 (signed). Default 8. */
  speed?: number;
  /** Sheet height in metres, 100-10,000. Default 1500. */
  height?: number;
}
/**
 * `fog` option (needs the `fog` feature): distance and height fog over the scene, coloured by the sky. Invalid values
 * throw RangeError.
 */
export interface SkyFogOptions {
  /** Returns the scene's sampleable depth texture each frame (no fog while it returns undefined). */
  depth: () => GPUTexture | undefined;
  /** Density per metre, 0..1 (0 turns fog off). Default 0.01. */
  density?: number;
  /** Distance from the camera, in metres, where fog starts, >= 0. Default 40. */
  start?: number;
  /** 'exp2' (default): 1 - exp(-(d * density)^2); 'exp': 1 - exp(-d * density). */
  falloff?: 'exp' | 'exp2';
  /** Extra density per metre below y = 0, as a fraction (default 0). */
  height?: number;
  /** Fixed linear fog colour instead of the sky's radiance in the view direction. */
  color?: Vec3;
}
/** Stylized night: gradient, twinkling stars and a phased moon. Replaces the default night gradient when set; read every frame. */
export interface SkyNightOptions {
  zenithColor?: Vec3;
  horizonColor?: Vec3;
  moonColor?: Vec3;
  moonDirection?: Vec3;
  /** Angular radius in radians, between 0 and PI / 2 (exclusive). Default 0.038. */
  moonSize?: number;
  /** -1 new, 0 half, 1 full; clamped. Default 0.85. */
  moonPhase?: number;
  glowIntensity?: number;
  starIntensity?: number;
  /** Twinkle amplitude; zero holds stars steady. Default 1. */
  starTwinkleIntensity?: number;
  /** Horizon haze thickness; zero removes the gradient. Default 1. */
  hazeDensity?: number;
}
/**
 * Sky settings, read every frame from `sky.options`. An option whose feature entry is missing (`night`, `clouds`,
 * `fog`, `lighting`, `model`) throws a TypeError naming the entry to import; a value out of range throws RangeError.
 */
export interface SkyOptions {
  /** Explicit world-space direction toward the sun; normalized each frame and overrides the clock's direction. */
  sunDirection?: readonly [number, number, number];
  /** Stylized night (needs `night`). Omitted: the default night gradient. */
  night?: SkyNightOptions;
  /** Cloud sheet (needs `clouds`). Omitted: no clouds. */
  clouds?: SkyCloudOptions;
  /** Scene fog (needs `fog`). Omitted: no fog. */
  fog?: SkyFogOptions;
  /** Day model (needs the entry of the same name). Default `'preetham'`. */
  model?: 'preetham' | 'bruneton';
  /** Clock, hours 0-24 (12 is noon, 6 sunrise); advanced by `timeScale` and wrapped into 0..24. Default 12. */
  hours?: number;
  /** Clock hours per real second, -24..24. Default 1 / 3600 (real time). */
  timeScale?: number;
  /** Atmospheric haze, 1-10. Default 2. The Preetham model reads values below 2 as 2 (its fit breaks down below that). */
  turbidity?: number;
  /**
   * Exposure of the sky backdrop only, in stops, -16..16. Default 0. It does not change how bright lit meshes are:
   * scene exposure is `exposure` on `Tonemap` from `@margoengine/tonemap`.
   */
  exposure?: number;
  /** Sun/moon scene lighting (needs `lighting`). Omitted: the sky does not drive engine lighting. */
  lighting?: SkyLightingOptions;
  /**
   * Fallback image-based lighting from this sky (needs `lighting`), without driving the sun: PBR meshes get diffuse
   * light from the sky's spherical harmonics and split-sum sky reflections, so metals are not black when the sky is
   * the only light. Gives way to an explicit environment: when an `EnvironmentLighting` has already patched the
   * scene shader the sky adds nothing, and `lighting.ambient` (when set) takes precedence over it. The floor is {@link skyEnvironmentFloor}. Default false.
   */
  environment?: boolean;
}
/** Least diffuse light (linear RGB) the `environment` fallback gives any side, by day and by night. */
export const skyEnvironmentFloor: { readonly day: Vec3; readonly night: Vec3 } = {
  day: [0.04, 0.04, 0.04],
  night: [0.01, 0.015, 0.03],
};
/**
 * Unit sun direction for a clock time: rises at 6 (+x), zenith at 12 (+y), sets at 18 (-x), in the XY plane. Writes
 * into `out` (3 elements) and returns it.
 * @throws RangeError when `hours` is not finite or `out` does not have 3 elements.
 */
export function sunDirection(hours: number, out = new Float32Array(3)): Float32Array {
  if (!Number.isFinite(hours) || out.length !== 3)
    throw new RangeError('Invalid sun clock; pass finite hours and an out array of 3 elements.');
  // Margo clock model (not astronomical): the sun moves on a circle through east and the zenith.
  const angle = (((hours % 24) - 6) * Math.PI) / 12;
  out[0] = Math.cos(angle);
  out[1] = Math.sin(angle);
  out[2] = 0;
  return out;
}
/**
 * Direction toward the sun from azimuth (+Z toward +X) and elevation, both in DEGREES (not radians). Elevation is
 * -90..90. A radians value such as 0.61 is read as 0.61 degrees, a sun on the horizon; with typed angles
 * (`sunDirectionFrom(degrees(135), degrees(35))` from `@margoengine/sky/sun`) the unit cannot be mixed up.
 */
export function sunDirectionFromAngles(azimuth: number, elevation: number, out = new Float32Array(3)): Float32Array {
  if (!Number.isFinite(azimuth) || !Number.isFinite(elevation) || Math.abs(elevation) > 90 || out.length !== 3)
    throw new RangeError('Sun angles need a finite azimuth and elevation from -90 to 90 degrees');
  const az = (azimuth * Math.PI) / 180,
    el = (elevation * Math.PI) / 180;
  out[0] = Math.sin(az) * Math.cos(el);
  out[1] = Math.sin(el);
  out[2] = Math.cos(az) * Math.cos(el);
  return out;
}

/** A native PBR renderer accepting optional sky ambient lighting (materials meshes, gltf-pro and VoxelRenderer). */
export interface SkyLightingTarget {
  addLighting(effect: {
    pbr(group: number): { readonly declarations: string; readonly ambient?: string } | undefined;
    bindings(): GPUBindGroupEntry[];
  }): () => void;
}
/** Bruneton's precomputed tables: the view the sky samples and the passes that refill them. */
export interface SkyTables {
  view: GPUTextureView;
  run(c: SkyPassContext): void;
}
/** Features add each GPU object they create here at once, so a setup that fails part-way still releases it. */
type Owned = { destroy(): void }[];
type Lights = { direction: Float32Array; radiance: Float32Array };
/**
 * The optional parts of a sky. Pass the exports of the feature entries, for example
 * `{bruneton, clouds}` from `@margoengine/sky/bruneton` and `@margoengine/sky/clouds`; the shapes are internal.
 */
export interface SkyFeatures {
  preetham?: { readonly wgsl: string };
  bruneton?: {
    readonly phase: string;
    readonly tail: string;
    create(device: GPUDevice, uniform: GPUBufferBinding, transmission: GPUTextureView, owned: Owned): SkyTables;
  };
  /** `field`: the WGSL of the cloud noise alone, `cloudOctaves` over a km position, for other passes that read the same clouds. */
  clouds?: { readonly wgsl: string; readonly field?: string; validate(clouds: SkyCloudOptions): void };
  night?: {
    readonly wgsl: string;
    validate(night: SkyNightOptions): void;
    write(values: Float32Array, night: SkyNightOptions, time: number): void;
  };
  fog?: {
    validate(fog: SkyFogOptions): void;
    create(code: string): {
      draw(c: SkyPassContext, fog: SkyFogOptions, entries: GPUBindGroupEntry[]): void;
      release(): void;
    };
  };
  reflection?: {
    create(
      device: GPUDevice,
      code: string,
      entries: GPUBindGroupEntry[],
      owned: Owned,
    ): { texture: GPUTexture; run(c: SkyPassContext): void };
  };
  lighting?: {
    validate(lighting: SkyLightingOptions): void;
    create(
      device: GPUDevice,
      code: string,
      entries: GPUBindGroupEntry[],
      owned: Owned,
    ): {
      update(
        target: Lights,
        sky: Sky,
        lighting: SkyLightingOptions | undefined,
        ambient: { readonly day: Vec3; readonly night: Vec3 } | undefined,
        night: number,
      ): void;
      pass(c: SkyPassContext): void;
      pbr(group: number): { readonly declarations: string; readonly ambient: string } | undefined;
      bindings(): GPUBindGroupEntry[];
    };
  };
}
// Absent features leave out their WGSL; with every feature the text is the root `Sky`'s shader.
function compose(f: SkyFeatures): [string, string] {
  const p = !!f.preetham,
    b = f.bruneton,
    atmosphere = head + (b?.phase ?? '') + mid + (b?.tail ?? '');
  return [
    atmosphere,
    fullscreen +
      atmosphere +
      (f.clouds?.wgsl ??
        `
fn cloudSky(color:vec3f,backdrop:vec3f,ray:vec3f,angularFootprint:f32)->vec3f {return color;}
`) +
      celestialShader +
      `
@group(0) @binding(1) var scattering:texture_2d<f32>;
@group(0) @binding(2) var transmission:texture_2d<f32>;
` +
      // Margo tuning: the night fallback gradient and, below, the sun disc x60 and bloom x0.8.
      (f.night?.wgsl ?? '') +
      `// footprint: the sample's angular size in radians, which filters stars and the moon; 0 leaves them out (fog).
fn nightSky(w:vec3f,footprint:f32)->vec3f {
` +
      (f.night
        ? ` if(frame.sunlight.w>0.5){return stylizedNight(w,footprint);}
`
        : '') +
      ` return mix(vec3f(0.012,0.019,0.038),vec3f(0.003,0.006,0.02),sqrt(max(0.0,w.y)));
}
` +
      (f.preetham?.wgsl ?? '') +
      `fn daySky(direction:vec3f)->vec3f {
 // Keep the coarse table's dark ground hemisphere out of the visible ocean horizon.
 let w=normalize(vec3f(direction.x,max(0.01,direction.y),direction.z));
 let s=frame.sun.xyz;
 var color=vec3f(0);` +
      (p ? 'if(frame.settings.x<0.5){color=preetham(w,s);}' : '') +
      (p && b ? 'else' : '') +
      (b ? '{let r=R+clamp(frame.eye.w,0.001,99.9);color=lookup(scattering,r,w.y,s.y,dot(w,s));}' : '') +
      `
 return color;
}
fn skyRadiance(w:vec3f,footprint:f32)->vec3f {if(frame.sun.w>=1.0){return nightSky(w,footprint);}return mix(daySky(w),nightSky(w,footprint),frame.sun.w);}
${displayShader}
// Dither for the 8-bit canvas (Gjol, "Low Complexity, High Fidelity: INSIDE", GDC 2016, as in @margoengine/post Bloom):
// triangular noise of up to one 8-bit step from a hash of the pixel (C. Wellons' lowbias32, public domain), kept within
// each channel's distance to 0 and 1 so black stays black and nothing clips. Without it the smooth gradient steps one
// level per channel every few rows and the three staircases beat into visible bands.
${ditherShader}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let p=frame.inverse*vec4f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0,0.000001,1);let w=normalize(p.xyz/p.w-frame.eye.xyz);let s=frame.sun.xyz;
 let footprint=max(length(dpdx(w)),length(dpdy(w)));let sky=skyRadiance(w,footprint);var color=sky;
 let sun=celestialProfile(w,s,SUN_RADIUS,footprint);
 color+=(sun.x*60.0+sun.y*0.8)*trans(transmission,R+clamp(frame.eye.w,0.001,99.9),s.y)*(1.0-frame.sun.w);
 color+=frame.moonColor.rgb*frame.moon.w*moonRadiance(w,frame.moon.xyz,footprint);
 color=cloudSky(color,sky,w,footprint);color*=exp2(frame.settings.y);if(frame.settings.w<0.5&&frame.sunlight.w<0.5){color=toDisplay(color);color+=dither(i.position.xy)*min(vec3f(1.0/255.0),min(color,1.0-color));}return vec4f(color,1);
}`,
  ];
}
/**
 * A sky built from the features given: `new Sky(options, {bruneton, clouds})`. Without a day model (Preetham or
 * Bruneton) the sun must stay below the horizon. `Sky` from `@margoengine/sky` is this class with every feature.
 * @throws TypeError when an option needs a feature entry that was not given; RangeError when a value is out of range.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` when the camera
 * matrix is not invertible.
 */
export class Sky implements EnginePlugin {
  private readonly presentation = overlayPass();
  private readonly attachment = this.presentation.colorAttachments[0];
  private readonly depthAttachment = this.presentation.depthStencilAttachment;
  readonly name: string = 'sky';
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private transmission?: GPUTexture;
  private tables?: SkyTables;
  private pipeline?: GPUComputePipeline;
  private group?: GPUBindGroup;
  private entries: GPUBindGroupEntry[] = [];
  private render?: GPURenderPipeline;
  private bind?: GPUBindGroup;
  private format = '';
  private computedT = NaN;
  private scatteringT = NaN;
  private readonly values = new Float32Array(64);
  private time = 0;
  private readonly inverse = this.values.subarray(0, 16);
  private readonly scratch = new Float64Array(52);
  private readonly sunColor = new Float32Array(3);
  readonly sun = new Float32Array(3);
  readonly moon = Float32Array.from([-0.3, 0.22, -1], (v) => v / Math.hypot(0.3, 0.22, 1));
  private disposed = false;
  private cloudTime = 0;
  private reflectionRequested = false;
  private owned: Owned = [];
  private readonly atmosphere: string;
  private readonly code: string;
  private reflection?: ReturnType<NonNullable<SkyFeatures['reflection']>['create']>;
  private fogPass?: ReturnType<NonNullable<SkyFeatures['fog']>['create']>;
  private lit?: ReturnType<NonNullable<SkyFeatures['lighting']>['create']>;
  private targets = new Map<SkyLightingTarget, () => void>();
  /** Borrowed linear HDR sky environment (needs the reflection feature); rebuilt on device restoration. */
  /**
   * The cloud layer this frame, for what must match it (`cloudShadows` from `@margoengine/shadows/light-function`):
   * `field` is its noise as WGSL, `drift` the metres it has moved along the wind. Undefined without clouds.
   */
  get cloudLayer(): { field: string; coverage: number; drift: number; height: number } | undefined {
    const options = this.options.clouds,
      field = this.features.clouds?.field;
    if (!options || !field) return undefined;
    return { field, coverage: options.coverage ?? 0.45, drift: this.cloudTime, height: options.height ?? 1500 };
  }
  get reflectionTexture(): GPUTexture | undefined {
    this.reflectionRequested = true;
    return this.reflection?.texture;
  }
  /** Dusk/dawn blend, 0 in daylight and 1 at night, updated before rendering. */
  get nightFactor(): number {
    return this.values[23];
  }
  /** Retained sun/moon directions (XYZ, intensity) and RGB radiance for direct reflections. */
  readonly lights = [
    { direction: new Float32Array([1, 0, 0, 0]), radiance: new Float32Array(3) },
    { direction: new Float32Array([...this.moon, 0]), radiance: new Float32Array(3) },
  ] as const;
  constructor(
    readonly options: SkyOptions = {},
    private readonly features: SkyFeatures = {},
  ) {
    [this.atmosphere, this.code] = compose(features);
    this.validate();
  }
  /** Adds this sky's native diffuse and specular ambient to a PBR model or VoxelRenderer; returns a remover. */
  add(target: SkyLightingTarget): () => void {
    if (this.disposed) throw margoError('disposed', 'Sky is disposed; create a new Sky');
    if (!target || typeof target.addLighting !== 'function')
      throw new TypeError('Sky lighting target needs addLighting; pass a native PBR model or VoxelRenderer');
    let release = this.targets.get(target);
    if (!release) {
      const remove = target.addLighting(this);
      release = () => {
        if (this.targets.get(target) === release) {
          this.targets.delete(target);
          remove();
        }
      };
      this.targets.set(target, release);
    }
    return release;
  }
  /** Native PBR hook for optional surface renderers; undefined until this sky's ambient resources are ready. */
  pbr(group: number): { readonly declarations: string; readonly ambient: string } | undefined {
    return this.ambient() ? this.lit?.pbr(group) : undefined;
  }
  /** Bindings of the native PBR sky ambient hook, borrowed until device restoration. */
  bindings(): GPUBindGroupEntry[] {
    return this.ambient() ? (this.lit?.bindings() ?? []) : [];
  }
  /**
   * The ambient floor in force this frame: `lighting.ambient`, else the `environment` fallback, else undefined.
   */
  private ambient(): { readonly day: Vec3; readonly night: Vec3 } | undefined {
    const o = this.options;
    if (o.lighting?.ambient) return o.lighting.ambient;
    return o.environment ? skyEnvironmentFloor : undefined;
  }
  private validate(): void {
    const o = this.options,
      f = this.features,
      model = o.model ?? 'preetham';
    if (
      o.sunDirection !== undefined &&
      (!Array.isArray(o.sunDirection) ||
        o.sunDirection.length !== 3 ||
        o.sunDirection.some((v) => !Number.isFinite(Math.fround(v))) ||
        !(Math.hypot(...o.sunDirection) > 0))
    )
      throw new RangeError('Sky sun direction needs three finite components and nonzero length');
    if (
      (o.model !== undefined && o.model !== 'preetham' && o.model !== 'bruneton') ||
      !Number.isFinite(o.hours ?? 12) ||
      !Number.isFinite(o.timeScale ?? 1 / 3600) ||
      Math.abs(o.timeScale ?? 1 / 3600) > 24 ||
      !Number.isFinite(o.turbidity ?? 2) ||
      (o.turbidity ?? 2) < 1 ||
      (o.turbidity ?? 2) > 10 ||
      !Number.isFinite(o.exposure ?? 0) ||
      Math.abs(o.exposure ?? 0) > 16
    )
      throw new RangeError(
        'Invalid sky options; keep timeScale within ±24, turbidity from 1 to 10, exposure within ±16 and hours finite, and use model "preetham" or "bruneton".',
      );
    if ((o.model !== undefined || f.preetham || f.bruneton) && !f[model])
      throw new TypeError(`Sky model '${model}' needs ${model} from @margoengine/sky/${model}`);
    if (o.environment !== undefined && typeof o.environment !== 'boolean')
      throw new RangeError('Sky environment must be true or false; pass a boolean');
    if (o.environment && !f.lighting)
      throw new TypeError('Sky environment needs lighting from @margoengine/sky/lighting');
    for (const key of ['clouds', 'fog', 'night', 'lighting'] as const) {
      const value = o[key],
        feature = f[key];
      if (value === undefined) continue;
      if (!feature) throw new TypeError(`Sky ${key} needs ${key} from @margoengine/sky/${key}`);
      (feature.validate as (value: unknown) => void)(value);
    }
  }
  static attach(engine: EngineKernel, options: SkyOptions = {}, features: SkyFeatures = {}): Sky {
    const effect = new Sky(options, features);
    engineRuntime(engine).use(effect);
    return effect;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Sky requires WebGPU; attach a new Sky to a WebGPU engine',
      );
    this.engine = engine;
    const d = engine.gpu,
      f = this.features;
    this.uniform = d.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const u = { buffer: this.uniform };
    this.transmission = d.createTexture({
      size: [128, 32],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    const t = this.transmission.createView();
    this.tables = f.bruneton?.create(d, u, t, this.owned);
    this.entries = [{ binding: 0, resource: u }, ...(this.tables ? [{ binding: 1, resource: this.tables.view }] : [])];
    this.pipeline = compute(d, this.atmosphere + transmittance);
    this.group = group(d, this.pipeline, [u, t]);
    this.reflection = f.reflection?.create(d, this.code, this.entries, this.owned);
    this.lit = f.lighting?.create(d, this.code, this.entries, this.owned);
  }
  registerPasses(graph: FrameGraph): void {
    if (this.features.lighting)
      graph.add({
        name: 'sky:lighting',
        order: -6,
        execute: (c) => {
          // The scene's ambient light is the sky of this frame: upload it first, then render and project it.
          if (c.backend === 'webgpu' && this.options.lighting?.ambient) {
            this.prepare(c);
            this.lit!.pass(c);
          }
        },
      });
    if (this.features.lighting)
      graph.add({
        name: 'sky:environment',
        // After the scene effects that patch the shader at -1 (EnvironmentLighting, light probes): the fallback only
        // lights what no explicit environment has already lit, found by the term they leave in the shader.
        order: -0.5,
        execute: (c) => {
          if (
            c.backend === 'webgpu' &&
            this.options.environment &&
            !this.options.lighting?.ambient &&
            !c.shader.includes('let margoAmbient=')
          ) {
            this.prepare(c);
            this.lit!.pass(c);
          }
        },
      });
    graph.add({
      name: 'sky:atmosphere',
      order: 2,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
    if (this.features.fog)
      graph.add({
        name: 'sky:fog',
        order: 5,
        execute: (c) => {
          if (c.backend === 'webgpu' && this.options.fog)
            (this.fogPass ??= this.features.fog!.create(this.code)).draw(c, this.options.fog, this.entries);
        },
      });
  }
  onPreUpdate(delta: number): void {
    this.validate();
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid sky delta; pass a finite delta of 0 or more seconds.');
    this.cloudTime += delta * (this.options.clouds?.speed ?? 8);
    this.time += delta;
    this.options.hours = ((((this.options.hours ?? 12) + delta * (this.options.timeScale ?? 1 / 3600)) % 24) + 24) % 24;
    if (this.options.sunDirection) {
      const length = Math.hypot(...this.options.sunDirection);
      for (let i = 0; i < 3; i++) this.sun[i] = this.options.sunDirection[i] / length;
    } else sunDirection(this.options.hours, this.sun);
    // Margo design choices: the day/night blend window (sun.y + 0.12) / 0.2 and the moon at 0.1 x the sun.
    const l = this.options.lighting,
      t = Math.max(0, Math.min(1, (this.sun[1] + 0.12) / 0.2)),
      night = 1 - t * t * (3 - 2 * t);
    if (night < 1 && !this.features.preetham && !this.features.bruneton)
      throw new RangeError('Daylight needs a day model: preetham or bruneton from @margoengine/sky');
    const moonT = Math.max(0, Math.min(1, -this.sun[1] / 0.12)),
      moonVisibility = moonT * moonT * (3 - 2 * moonT),
      moonIntensity = l?.moon ? (l.moon.intensity ?? (l.intensity ?? 1) * 0.1) : 0;
    this.values[23] = night;
    this.values.set(this.moon, 28);
    this.values[31] = moonIntensity * moonVisibility;
    this.values.set(l?.moon?.color ?? moonColor, 32);
    // The sun's strength and colour come from the atmosphere's transmittance (the sky's own model), relative to noon.
    // Surfaces add their own N.L, so no further elevation factor: the low sun is dimmed and warmed once, by the air.
    const s = sunlight(this.sun[1], this.values[19] || 0.001, this.options.turbidity ?? 2, this.sunColor),
      peak = Math.max(s[0], s[1], s[2]);
    this.values.set(s, 60);
    this.lights[0].direction.set(this.sun);
    this.lights[0].direction[3] = l ? (l.intensity ?? 1) * peak : 0;
    for (let i = 0; i < 3; i++) this.lights[0].radiance[i] = (l?.color?.[i] ?? 1) * (peak > 0 ? s[i] / peak : 1);
    this.lights[1].direction.set(this.moon);
    this.lights[1].direction[3] = this.values[31];
    this.lights[1].radiance.set(l?.moon?.color ?? moonColor);
    if (this.lit && (l || this.options.environment))
      this.lit.update(this.engine!.lighting, this, l, this.ambient(), night);
  }
  /** Uploads this frame's uniform and refreshes the tables; idempotent within a frame (lighting runs it earlier). */
  private prepare(c: SkyPassContext): void {
    this.validate();
    if (!invertMatrixStable(c.camera.matrix, this.inverse, this.scratch))
      throw new MargoError('state', 'Invalid sky camera; give the camera a finite, invertible projection');
    this.values.set(c.camera.position, 16);
    this.values[19] = Math.max(0.001, c.camera.position[1] / 1000);
    this.values.set(this.sun, 20);
    this.values[24] = +(this.options.model === 'bruneton');
    this.values[25] = this.options.exposure ?? 0;
    this.values[26] = this.options.turbidity ?? 2;
    this.values[36] = this.options.clouds ? (this.options.clouds.coverage ?? 0.45) : 0;
    this.values[37] = this.cloudTime;
    this.values[38] = this.options.clouds?.height ?? 1500;
    this.values[27] = +(c.format === 'rgba16float');
    // Uniform layout of SkyNightOptions: zenith+twinkle, horizon+haze, moon direction+cos(size), moon colour+sin(size), phase/glow/stars/time; then the sun colour (60-62, set before update) and the enabled flag (63).
    const n = this.options.night;
    this.values[63] = +!!n;
    if (n) this.features.night!.write(this.values, n, this.time);
    c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
    const turbidity = this.options.turbidity ?? 2;
    if (this.computedT !== turbidity) dispatch(c, this.pipeline!, this.group!, 16, 4);
    if (this.options.model === 'bruneton' && this.scatteringT !== turbidity) {
      this.tables!.run(c);
      this.scatteringT = turbidity;
    }
    this.computedT = turbidity;
  }
  private draw(c: SkyPassContext): void {
    this.prepare(c);
    if (this.reflectionRequested) this.reflection?.run(c);
    const format = c.format + ':' + c.descriptor.multisample?.count + ':' + c.descriptor.depthStencil!.format;
    if (this.format !== format) {
      const module = c.device.createShaderModule({ code: this.code });
      this.render = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthCompare: 'greater-equal',
          depthWriteEnabled: false,
        },
      });
      this.bind = c.device.createBindGroup({
        layout: this.render.getBindGroupLayout(0),
        entries: [...this.entries, { binding: 2, resource: this.transmission!.createView() }],
      });
      this.format = format;
    }
    this.attachment.view = c.color;
    this.depthAttachment.view = c.depth;
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(this.render!);
    pass.setBindGroup(0, this.bind!);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  private release(): void {
    this.uniform?.destroy();
    this.fogPass?.release();
    this.transmission?.destroy();
    for (const r of this.owned) r.destroy();
    this.owned = [];
    this.uniform = this.transmission = undefined;
    this.lit = this.fogPass = this.tables = this.reflection = undefined;
    this.pipeline = this.group = this.render = this.bind = undefined;
    this.entries = [];
    this.format = '';
    this.computedT = this.scatteringT = NaN;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of [...this.targets.values()]) release();
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
