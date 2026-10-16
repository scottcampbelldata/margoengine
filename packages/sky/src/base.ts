/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { fullscreen, group, compute, dispatch } from '../../shared/gpu.js';
import { invertMatrixStable } from '@margoengine/math/mat4';
import type { Vec3 } from '@margoengine/math';
import { celestialShader } from './celestial.js';
import { head, mid, transmittance } from './atmosphere.js';
import { MargoError } from '@margoengine/math/errors';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { STORAGE_BINDING: number; TEXTURE_BINDING: number };
type SkyPassContext = Extract<PassContext, { backend: 'webgpu' }>;
const moonColor: Vec3 = [0.25, 0.45, 0.75];
/**
 * `lighting` option (needs the `lighting` feature): the sky drives the engine's directional light from the sun and
 * moon and, with `ambient`, core's PBR ambient colour. Colours are linear RGB.
 */
export interface SkyLightingOptions {
  /** Sun light intensity at the zenith, >= 0. Default 1. */
  intensity?: number;
  /** Lowest light intensity at any time of day, >= 0. Default 0. */
  minimum?: number;
  /** Daylight colour. Default [1, 1, 1]. */
  color?: Vec3;
  /** Colour the sun warms to near dawn and dusk (below about 5 degrees). Default: `color`. */
  sunset?: Vec3;
  /** Moonlight; omitted means no moon light. `intensity` defaults to a tenth of the sun's, `color` to [0.25, 0.45, 0.75]. */
  moon?: { intensity?: number; color?: Vec3 };
  /** Ambient colour blended from `day` to `night` with the night factor. */
  ambient?: { day: Vec3; night: Vec3 };
}
/** `clouds` option (needs the `clouds` feature): an animated procedural cloud sheet. */
export interface SkyCloudOptions {
  /** Sky fraction covered, 0..1. Default 0.45. */
  coverage?: number;
  /** Wind speed in metres per second along a fixed XZ direction (signed). Default 8. */
  speed?: number;
  /** Sheet height in metres, 100-10,000. Default 1500. */
  height?: number;
}
/** `fog` option (needs the `fog` feature): distance and height fog over the scene, coloured by the sky. */
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
  /** Atmospheric haze, 1-10. Default 2. */
  turbidity?: number;
  /** Exposure in stops, -16..16. Default 0. */
  exposure?: number;
  /** Sun/moon scene lighting (needs `lighting`). Omitted: the sky does not drive engine lighting. */
  lighting?: SkyLightingOptions;
}
/**
 * Unit sun direction for a clock time: rises at 6 (+x), zenith at 12 (+y), sets at 18 (-x), in the XY plane. Writes
 * into `out` (3 elements) and returns it.
 * @throws RangeError when `hours` is not finite or `out` does not have 3 elements.
 */
export function sunDirection(hours: number, out = new Float32Array(3)): Float32Array {
  if (!Number.isFinite(hours) || out.length !== 3) throw new RangeError('Invalid sun clock');
  const angle = (((hours % 24) - 6) * Math.PI) / 12;
  out[0] = Math.cos(angle);
  out[1] = Math.sin(angle);
  out[2] = 0;
  return out;
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
  clouds?: { readonly wgsl: string; validate(clouds: SkyCloudOptions): void };
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
      owned: Owned,
    ): {
      update(target: Lights, sky: Sky, lighting: SkyLightingOptions, moonIntensity: number, night: number): void;
      pass(c: SkyPassContext): void;
    };
  };
}
// Absent features leave out their WGSL; with every feature the text is exactly the original single shader.
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
fn cloudSky(color:vec3f,ray:vec3f,angularFootprint:f32)->vec3f {return color;}
`) +
      celestialShader +
      `
@group(0) @binding(1) var scattering:texture_2d<f32>;
@group(0) @binding(2) var transmission:texture_2d<f32>;
` +
      (f.night?.wgsl ?? '') +
      `fn nightSky(w:vec3f)->vec3f {
` +
      (f.night
        ? ` if(frame.nightOn.x>0.5){return stylizedNight(w);}
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
fn skyRadiance(w:vec3f)->vec3f {if(frame.sun.w>=1.0){return nightSky(w);}return mix(daySky(w),nightSky(w),frame.sun.w);}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let p=frame.inverse*vec4f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0,0.000001,1);let w=normalize(p.xyz/p.w-frame.eye.xyz);let s=frame.sun.xyz;
 var color=skyRadiance(w);
 let footprint=max(length(dpdx(w)),length(dpdy(w)));let sun=celestialProfile(w,s,SUN_RADIUS,footprint);
 color+=(sun.x*60.0+sun.y*0.8)*trans(transmission,R+clamp(frame.eye.w,0.001,99.9),s.y)*(1.0-frame.sun.w);
 color+=frame.moonColor.rgb*frame.moon.w*moonRadiance(w,frame.moon.xyz,footprint);
 color=cloudSky(color,w,footprint);color*=exp2(frame.settings.y);if(frame.settings.w<0.5&&frame.nightOn.x<0.5){color=pow(color/(1.0+color),vec3f(1.0/2.2));}return vec4f(color,1);
}`,
  ];
}
/**
 * A sky built from the features given: `new Sky(options, {bruneton, clouds})`. Without a day model (Preetham or
 * Bruneton) the sun must stay below the horizon. `Sky` from `@margoengine/sky` is this class with every feature.
 */
export class Sky implements EnginePlugin {
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthReadOnly: true,
    stencilReadOnly: true,
  };
  private readonly presentation: GPURenderPassDescriptor = {
    colorAttachments: [this.attachment],
    depthStencilAttachment: this.depthAttachment,
  };
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
  /** Borrowed linear HDR sky environment (needs the reflection feature); rebuilt on device restoration. */
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
  private validate(): void {
    const o = this.options,
      f = this.features,
      model = o.model ?? 'preetham';
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
      throw new RangeError('Invalid sky options');
    if ((o.model !== undefined || f.preetham || f.bruneton) && !f[model])
      throw new TypeError(`Sky model '${model}' needs ${model} from @margoengine/sky/${model}`);
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
    this.lit = f.lighting?.create(d, this.owned);
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
  }
  registerPasses(graph: FrameGraph): void {
    if (this.features.lighting)
      graph.add({
        name: 'sky:lighting',
        order: -6,
        execute: (c) => {
          if (c.backend === 'webgpu' && this.options.lighting?.ambient) this.lit!.pass(c);
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
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Invalid sky delta');
    this.cloudTime += delta * (this.options.clouds?.speed ?? 8);
    this.time += delta;
    this.options.hours = ((((this.options.hours ?? 12) + delta * (this.options.timeScale ?? 1 / 3600)) % 24) + 24) % 24;
    sunDirection(this.options.hours, this.sun);
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
    this.lights[0].direction.set(this.sun);
    this.lights[0].direction[3] = Math.max(0, this.sun[1]) * (l?.intensity ?? 0);
    const elevation = Math.max(0, Math.min(1, (this.sun[1] - 0.08) / 0.42)),
      day = elevation * elevation * (3 - 2 * elevation);
    for (let i = 0; i < 3; i++)
      this.lights[0].radiance[i] = (l?.color?.[i] ?? 1) * day + (l?.sunset?.[i] ?? l?.color?.[i] ?? 1) * (1 - day);
    this.lights[1].direction.set(this.moon);
    this.lights[1].direction[3] = this.values[31];
    this.lights[1].radiance.set(l?.moon?.color ?? moonColor);
    if (l && this.lit) this.lit.update(this.engine!.lighting, this, l, moonIntensity, night);
  }
  private draw(c: SkyPassContext): void {
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
    // Uniform layout of SkyNightOptions: zenith+twinkle, horizon+haze, moon direction+cos(size), moon colour+sin(size), phase/glow/stars/time, enabled.
    const n = this.options.night;
    this.values[60] = +!!n;
    if (n) this.features.night!.write(this.values, n, this.time);
    c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
    const turbidity = this.options.turbidity ?? 2;
    if (this.computedT !== turbidity) dispatch(c, this.pipeline!, this.group!, 16, 4);
    if (this.options.model === 'bruneton' && this.scatteringT !== turbidity) {
      this.tables!.run(c);
      this.scatteringT = turbidity;
    }
    this.computedT = turbidity;
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
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
