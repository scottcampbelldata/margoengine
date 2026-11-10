/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type Vec3 } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import { MargoError } from '@margoengine/math/errors';
import { viewMatrix } from '../../shared/view.js';
import { orthographic } from '../../shared/projection.js';
import { coreReceives, unshadowedCore } from '../../shared/shadow-source.js';
import { cullingShader, clusteredSampling } from './shader.js';
import { shadowCamera } from './local-shadow-math.js';
import { viewRect, viewSize } from '../../shared/view-rect.js';
import {
  LocalShadowMaps,
  type LocalShadowOptions,
  type LocalLightShadow,
  type LocalShadowSource,
} from './local-shadows.js';
export { clusteredSampling, type ClusteredSamplingHooks } from './shader.js';
export type { DirectionalShadowLight, AreaShadowLight } from './light-shadow-math.js';
import type { DirectionalShadowLight, AreaShadowLight } from './light-shadow-math.js';
export type { LocalShadowOptions, LocalLightShadow, LocalShadowSource, LocalShadowPrimitive } from './local-shadows.js';
declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number; COPY_SRC: number };
/** A local point light for `setLights`. Invalid values throw RangeError or TypeError (the list is unchanged). */
export interface PointLight {
  /** World position. */
  position: Vec3;
  /**
   * Distance where the light ends, windowed smoothly: `clamp(1 - (d / range)^4, 0, 1)^2`. 0 is unlimited (window 1;
   * the light reaches every cluster), not allowed for a light with a shadow map unless its `shadow` sets `far`.
   */
  range: number;
  /** Linear RGB; a channel may be negative (Display P3) while the luminance is 0 or more. Default [1, 1, 1]. */
  color?: Vec3;
  /** Radiance multiplier, 0 or more. Default 1. */
  intensity?: number;
  /**
   * Distance falloff exponent, 0 or more: attenuation is `window / max(d^decay, 2^-12)` (2 is inverse-square, 0 none;
   * the floor caps the peak beside the light at 4096 times the window).
   * A light that sets neither `decay` nor `angle` keeps the original inverse-square shader term, `d * d`, bit for bit.
   */
  decay?: number;
  /**
   * Integrated shadow map (`ClusteredOptions.shadows`): `true` or its settings. On a `castShadow` light the object's
   * `resolution`, `near` and `far` also set its `LocalShadows` map; without integrated maps it may hold only those.
   */
  shadow?: boolean | LocalLightShadow;
  /** Shadowed by `LocalShadows` (`@margoengine/clustered/shadows`), with `shadow`'s map size and near/far if given. */
  castShadow?: boolean;
}
/** A local spot light: a point light limited to a cone, set by `outerAngle`/`innerAngle` or `angle`/`penumbra`. */
export interface SpotLight extends PointLight {
  /** World direction the cone points along (nonzero). */
  direction: Vec3;
  /**
   * Cone half-angle in radians, up to pi / 2 (a hemisphere), with `innerAngle` (0 to outer) where the smooth edge
   * starts. A hemisphere's local shadow map is the six cube faces of a point light.
   */
  outerAngle?: number;
  /** Half-angle in radians where the smooth edge starts, 0 to `outerAngle`. Default 0. */
  innerAngle?: number;
  /**
   * Instead of outer/inner: cone half-angle in radians, up to pi / 2 (a hemisphere). The cone is
   * `smoothstep(cos(angle), cos(angle * (1 - penumbra)), dot(-L, direction))`, so it is outer = angle,
   * inner = angle * (1 - penumbra); penumbra 0 is a hard edge.
   */
  angle?: number;
  /** With `angle`: share of the cone that fades, 0 (hard edge, default) to 1. */
  penumbra?: number;
}
/** What `Clustered.add` hands a receiver: this lighting, or the same without local-light shadows. */
export interface ClusteredLighting {
  readonly owner?: Engine;
  pbr(group: number): { declarations: string; light: string };
  shader(source: string, group?: number): string;
  bindings(): GPUBindGroupEntry[];
}
/** `Clustered` settings, fixed at construction. */
export interface ClusteredOptions {
  /** Clusters along screen X, Y and log depth, each an integer 1-128, product <= 32,768. Default [16, 9, 24]. */
  grid?: readonly [number, number, number];
  /** Integrated shadow maps for lights with a `shadow` (and `addShadowCaster`). Omitted: none. */
  shadows?: LocalShadowOptions;
}
/** The `Clustered.shadow` hook (`LocalShadows` from `@margoengine/clustered/shadows`): WGSL defining `clusterShadow`, and its bindings. */
export interface ClusteredShadow {
  /** WGSL declarations in bind group `group`. */
  declarations(group: number): string;
  /** Bind group entries matching `declarations`. */
  bindings(): GPUBindGroupEntry[];
  /**
   * While some directional light casts: a WGSL f32 call in the directional loop's `j`, `position`, `n` and `l` (unit,
   * toward the light) that the loop multiplies each directional light by. Undefined otherwise.
   */
  readonly directionalShadow?: string;
  /**
   * While some area light casts: a WGSL f32 call in `clusterAreaLighting`'s `j`, `position`, `n`, `c` (receiver to
   * light centre), `r` and `u` (half extents) that multiplies each area light. Undefined otherwise.
   */
  readonly areaShadow?: string;
  /** Optional visibility call for the disk and sphere light loop. */
  readonly shapeShadow?: string;
}
/** The `Clustered.area` hook (`AreaLights` from `@margoengine/clustered/area`): WGSL defining `clusterAreaLighting`, and its bindings. */
export interface ClusteredArea {
  /** WGSL declarations in bind group `group`; `shadow`, when given, is a `*` factor applied to each light. */
  declarations(group: number, shadow?: string): string;
  /** Bind group entries matching `declarations`. */
  bindings(): GPUBindGroupEntry[];
  /** The castShadow area lights, for the `shadow` hook's maps. */
  shadowLights?(): readonly AreaShadowLight[];
}
/** The `Clustered.shapes` hook (`ShapeLights` from `@margoengine/clustered/shapes`): WGSL defining `clusterShapeLighting`, and its bindings. */
export interface ClusteredShapes {
  /** WGSL declarations in bind group `group`. */
  declarations(group: number, shadow?: string): string;
  /** Bind group entries matching `declarations`. */
  bindings(): GPUBindGroupEntry[];
  /** Shadowed disk and sphere lights, indexed after the rectangle lights. */
  shadowLights?(): readonly AreaShadowLight[];
}
/** The `Clustered.stochastic` hook (`StochasticLights` from `@margoengine/clustered/stochastic`): sampled light shadows. */
export interface ClusteredStochastic {
  declarations(group: number): string;
  lighting(cell: string, head: string, radiance: string, visibility: string, shadowed: string): string;
  bindings(): GPUBindGroupEntry[];
}
/** The `Clustered.lobes` hook (`physicalLobes` from `@margoengine/clustered/physical-lobes`): edits a composed PBR shader. */
export interface ClusteredLobes {
  finish(code: string): string;
}
/** The `Clustered.directional` hook (`DirectionalLights`): WGSL defining `clusterDirectional` and its bindings. */
export interface ClusteredDirectional {
  /** WGSL declarations in bind group `group`. */
  declarations(group: number): string;
  /** Bind group entries matching `declarations`. */
  bindings(): GPUBindGroupEntry[];
  /** The castShadow directional lights, for the `shadow` hook's maps. */
  shadowLights?(): readonly DirectionalShadowLight[];
}
/**
 * A per-light factor of the point and spot loop (`Clustered.ies`, `Clustered.projector`): WGSL declarations, their
 * bindings and `term`, an f32 or vec3f expression in the loop's `index`, `light`, `l` and `position`.
 */
export interface ClusteredLightTerm {
  declarations(group: number): string;
  bindings(): GPUBindGroupEntry[];
  readonly term: string;
}
/** A renderer that receives clustered lights in its own shader (gltf-pro models, materials meshes, `Terrain`); see `lights.add`. */
export interface ClusteredReceiver {
  /** Patches the receiver's shader with `effect`'s light loop; returns the remover. */
  addLighting(effect: ClusteredLighting): () => void;
}
/**
 * Clustered forward GGX lighting for up to 1,024 point and spot lights: a compute pass bins lights into view-space
 * clusters, and fragments evaluate only their cluster's list. Core meshes receive it automatically; add gltf-pro
 * models, materials meshes or terrain with `lights.add(receiver)`. Optional integrated shadow maps (`shadows`) and
 * hooks for area, directional, IES and projector lights. `Clustered.attach(engine, options)`, then
 * `lights.setLights([...])`. WebGPU only.
 * @throws RangeError for an invalid grid or light, or a cluster list larger than the device allows; TypeError for an
 * invalid receiver or conflicting light options.
 * @throws MargoError `'unsupported'` on a WebGL engine or when the lit shader is not the standard PBR one,
 * `'disposed'` after `dispose()`, `'state'` when used before attaching or `addShadowCaster` without `shadows`.
 */
export class Clustered implements EnginePlugin {
  readonly name = 'clustered';
  readonly grid: readonly [number, number, number];
  /** Multiplies all local lights; a callback is sampled each render. */
  intensityScale: number | (() => number) = 1;
  private engine?: Engine;
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private lights?: GPUBuffer;
  private pipeline?: GPUComputePipeline;
  private group?: GPUBindGroup;
  private counts?: GPUBuffer;
  private indices?: GPUBuffer;
  private entries: GPUBindGroupEntry[] = [];
  /** Bindings 4-7 alone: `entries` without the integrated shadow maps. */
  private lightEntries: GPUBindGroupEntry[] = [];
  private receivers = new Map<ClusteredReceiver, () => void>();
  /** Some light sets `decay` or `angle`: the shaders carry `decayTerms`. */
  private decay = false;
  /** This lighting without local-light shadows, for receivers added with `receiveShadow: false`. */
  private readonly unshadowed: ClusteredLighting = ((lights: Clustered) => ({
    get owner() {
      return lights.engine;
    },
    pbr: (group: number) => lights.pbr(group, false),
    shader: (source: string, group?: number) => lights.shader(source, group, false),
    bindings: () => lights.bindings(false),
  }))(this);
  private readonly values = new Float32Array(32);
  private readonly ints = new Uint32Array(this.values.buffer);
  private readonly data = new Float32Array(1024 * 16);
  /** Per light: LocalShadows map width, height, near and far from a castShadow light's `shadow`, 0 where unset. */
  private readonly shadowCameras = new Float32Array(1024 * 4);
  private lightCount = 0;
  private dirty = true;
  private disposed = false;
  private readonly view = this.values.subarray(0, 16);
  private readonly shaders = new Map<string, Map<string, string>>();
  private readonly localShadows?: LocalShadowMaps;
  private lobesHook?: ClusteredLobes;
  private readonly hooks = new Map<
    number,
    { declarations: string; light: string; finish?: (code: string) => string }
  >();
  private shadowHook?: ClusteredShadow;
  private areaHook?: ClusteredArea;
  private directionalHook?: ClusteredDirectional;
  private iesHook?: ClusteredLightTerm;
  private projectorHook?: ClusteredLightTerm;
  private shapesHook?: ClusteredShapes;
  private stochasticHook?: ClusteredStochastic;
  private listValue: readonly (PointLight | SpotLight)[] = Object.freeze([]);
  /** This frame's binding parts: own entries, then the shadow, area, directional, IES, projector, shapes and stochastic hooks' (or undefined). */
  private readonly parts: (GPUBindGroupEntry[] | undefined)[] = [];
  /** Joined bindings without (0) and with (1) shadows: the parts they were joined from, then the result last. */
  private readonly joined: ((GPUBindGroupEntry[] | undefined)[] | undefined)[] = [];
  private reset(): void {
    this.shaders.clear();
    this.hooks.clear();
  }
  get shadow(): ClusteredShadow | undefined {
    return this.shadowHook;
  }
  set shadow(hook: ClusteredShadow | undefined) {
    this.shadowHook = hook;
    this.reset();
  }
  get area(): ClusteredArea | undefined {
    return this.areaHook;
  }
  set area(hook: ClusteredArea | undefined) {
    this.areaHook = hook;
    this.reset();
  }
  /** Clearcoat, sheen, anisotropy and thin film under these lights (`@margoengine/clustered/physical-lobes`). */
  get lobes(): ClusteredLobes | undefined {
    return this.lobesHook;
  }
  set lobes(hook: ClusteredLobes | undefined) {
    this.lobesHook = hook;
    this.reset();
  }
  /** Extra directional lights (`@margoengine/clustered/directional`), evaluated per fragment beside the point and spot lights. */
  get directional(): ClusteredDirectional | undefined {
    return this.directionalHook;
  }
  set directional(hook: ClusteredDirectional | undefined) {
    this.directionalHook = hook;
    this.reset();
  }
  /** Photometric (IES) profiles of the point and spot lights (`@margoengine/clustered/ies`). */
  get ies(): ClusteredLightTerm | undefined {
    return this.iesHook;
  }
  set ies(hook: ClusteredLightTerm | undefined) {
    this.iesHook = hook;
    this.reset();
  }
  /** Images projected by spot lights (`@margoengine/clustered/projector`). */
  get projector(): ClusteredLightTerm | undefined {
    return this.projectorHook;
  }
  set projector(hook: ClusteredLightTerm | undefined) {
    this.projectorHook = hook;
    this.reset();
  }
  /** Sphere, disc and tube lights (`@margoengine/clustered/shapes`), evaluated per fragment beside the point and spot lights. */
  get shapes(): ClusteredShapes | undefined {
    return this.shapesHook;
  }
  set shapes(hook: ClusteredShapes | undefined) {
    this.shapesHook = hook;
    this.reset();
  }
  /** Sampled shadows (`@margoengine/clustered/stochastic`): a few shadow lookups per pixel however many lights cast. */
  get stochastic(): ClusteredStochastic | undefined {
    return this.stochasticHook;
  }
  set stochastic(hook: ClusteredStochastic | undefined) {
    this.stochasticHook = hook;
    this.reset();
  }
  /** The point and spot lights last given to `setLights`, in order (a frozen copy of the list; the light objects are the caller's). */
  get list(): readonly (PointLight | SpotLight)[] {
    return this.listValue;
  }
  constructor(options: ClusteredOptions = {}) {
    const grid = options.grid ?? [16, 9, 24];
    if (
      grid.length !== 3 ||
      grid.some((v) => !Number.isInteger(v) || v < 1 || v > 128) ||
      grid.reduce((a, b) => a * b, 1) > 32768
    )
      throw new RangeError(
        'Invalid cluster grid; pass [x, y, z] integers from 1 to 128 whose product is at most 32768',
      );
    this.grid = [...grid] as [number, number, number];
    if (options.shadows !== undefined) this.localShadows = new LocalShadowMaps(options.shadows);
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  static attach(instance: EngineKernel, options: ClusteredOptions = {}): Clustered {
    const effect = new Clustered(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  setLights(lights: readonly (PointLight | SpotLight)[]): this {
    if (this.disposed || !Array.isArray(lights) || lights.length > 1024)
      throw new RangeError('Expected at most 1,024 lights');
    for (const light of lights) {
      finiteVector(light.position, 3, 'Light position');
      finiteVector(light.color ?? [1, 1, 1], 3, 'Light color');
      if (
        !Number.isFinite(Math.fround(light.range)) ||
        light.range < 0 ||
        !Number.isFinite(Math.fround(light.intensity ?? 1)) ||
        (light.intensity ?? 1) < 0 ||
        // A wide-gamut (Display P3) colour keeps negative linear sRGB channels; its luminance cannot be negative.
        // Luma weights: ITU-R BT.709.
        (light.color !== undefined &&
          !(0.2126 * light.color[0] + 0.7152 * light.color[1] + 0.0722 * light.color[2] >= 0))
      )
        throw new RangeError('Invalid light range/color/intensity (a colour needs a luminance of 0 or more)');
      if (light.decay !== undefined && !(Number.isFinite(Math.fround(light.decay)) && light.decay >= 0))
        throw new RangeError('Light decay must be a finite number of 0 or more; 2 is inverse-square');
      const shadow = light.shadow,
        settings = shadow && typeof shadow === 'object' ? shadow : undefined;
      if (
        light.range === 0 &&
        settings?.far === undefined &&
        (light.castShadow || (shadow !== undefined && shadow !== false))
      )
        throw new RangeError(
          'A light with a shadow map needs a finite range (0 is unlimited); give it a range, or its shadow a far',
        );
      if (light.castShadow && settings) {
        if (!this.localShadows && (settings.bias !== undefined || settings.normalBias !== undefined))
          throw new TypeError(
            "LocalShadows takes bias and normalBias from its options; a castShadow light's shadow sets resolution, near and far",
          );
        shadowCamera(settings, light.range);
      }
      if ('direction' in light) {
        finiteVector(light.direction, 3, 'Spot direction');
        const { angle, penumbra = 0 } = light;
        if (angle !== undefined) {
          if (light.outerAngle !== undefined || light.innerAngle !== undefined)
            throw new TypeError('Spot light: give angle and penumbra, or outerAngle and innerAngle, not both');
          if (!(angle > 0 && angle <= Math.PI / 2 && penumbra >= 0 && penumbra <= 1) || !Math.hypot(...light.direction))
            throw new RangeError('Spot angle must be in (0, pi/2] radians, penumbra in 0..1, direction nonzero');
        } else if (light.penumbra !== undefined)
          throw new TypeError('Spot penumbra goes with angle; use innerAngle with outerAngle');
        else if (
          !Math.hypot(...light.direction) ||
          !Number.isFinite(light.outerAngle) ||
          light.outerAngle! <= 0 ||
          light.outerAngle! > Math.PI / 2 ||
          !Number.isFinite(light.innerAngle ?? 0) ||
          (light.innerAngle ?? 0) < 0 ||
          (light.innerAngle ?? 0) > light.outerAngle!
        )
          throw new RangeError('Invalid spot cone; set outerAngle above 0 and innerAngle between 0 and outerAngle');
      }
    }
    const fresh = (light: PointLight | SpotLight) =>
      light.decay !== undefined || (light as SpotLight).angle !== undefined;
    // Local shadow maps read the outer cone; an angle is that cone.
    if (this.localShadows)
      this.localShadows.configure(
        lights.map((light) =>
          (light as SpotLight).angle === undefined ? light : { ...light, outerAngle: (light as SpotLight).angle },
        ),
      );
    else if (
      lights.some(
        (light) =>
          light.shadow !== undefined &&
          light.shadow !== false &&
          !(light.castShadow && light.shadow && typeof light.shadow === 'object'),
      )
    )
      throw new RangeError(
        'Light shadows require ClusteredOptions.shadows; for LocalShadows, give a castShadow light a shadow of resolution, near and far',
      );
    let shadows = 0;
    lights.forEach((light, i) => {
      const offset = i * 16,
        decay = light.decay ?? 2;
      // Range 0 is unlimited: the window of an infinite range is 1 and culling never drops the light.
      this.data.set(
        [...light.position, light.range || Infinity, ...(light.color ?? [1, 1, 1]), light.intensity ?? 1],
        offset,
      );
      if ('direction' in light) {
        const length = Math.hypot(...light.direction),
          { angle, penumbra = 0 } = light;
        this.data.set(
          [
            ...light.direction.map((v: number) => v / length),
            Math.cos(angle ?? light.outerAngle!),
            Math.cos(angle === undefined ? (light.innerAngle ?? 0) : angle * (1 - penumbra)),
            fresh(light) ? 2 + decay : 1,
            0,
            0,
          ],
          offset + 8,
        );
      } else {
        this.data.fill(0, offset + 8, offset + 16);
        if (fresh(light)) this.data[offset + 13] = -1 - decay;
      }
      this.data[offset + 14] = light.castShadow ? ++shadows : 0;
      const settings = light.castShadow && light.shadow && typeof light.shadow === 'object' ? light.shadow : undefined;
      if (settings) this.shadowCameras.set(shadowCamera(settings, light.range), i * 4);
      else this.shadowCameras.fill(0, i * 4, i * 4 + 4);
      if (this.localShadows) this.data[offset + 15] = this.localShadows.shadowIndex(i);
    });
    const decay = lights.some(fresh);
    if (decay !== this.decay) {
      this.decay = decay;
      this.reset();
    }
    this.listValue = Object.freeze([...lights]);
    this.lightCount = lights.length;
    this.dirty = true;
    return this;
  }
  /** Whether this receiver is attached, including receivers owned by another helper. False after removal or disposal. */
  hasReceiver(receiver: ClusteredReceiver): boolean {
    return this.receivers.has(receiver);
  }
  /**
   * Lights `receiver` (a gltf-pro model, materials mesh or terrain; core meshes are lit without it). With
   * `receiveShadow: false` it gets the same lighting without local-light shadows: their maps neither darken it nor
   * need it to cast (cast with `addShadowCaster` or `LocalShadows.add`). Core meshes are not added: set
   * `mesh.receiveShadow = false` on one instead. Returns the remover.
   */
  add(receiver: ClusteredReceiver, { receiveShadow = true }: { receiveShadow?: boolean } = {}): () => void {
    if (
      this.disposed ||
      !receiver ||
      typeof receiver.addLighting !== 'function' ||
      this.receivers.has(receiver) ||
      typeof receiveShadow !== 'boolean'
    )
      throw new TypeError(
        'Invalid or duplicate clustered receiver; pass a model or mesh with addLighting once, and a boolean receiveShadow',
      );
    const remove = receiver.addLighting(receiveShadow ? this : this.unshadowed);
    this.receivers.set(receiver, remove);
    return () => {
      if (this.receivers.delete(receiver)) remove();
    };
  }
  /** Register an opaque or alpha-masked caster for opted-in local-light shadows. */
  addShadowCaster(source: MeshHandle | LocalShadowSource): () => void {
    if (this.disposed || !this.localShadows)
      throw new MargoError(
        this.disposed ? 'disposed' : 'state',
        'Light shadows require a live ClusteredOptions.shadows effect; create a Clustered with the shadows option',
      );
    return this.localShadows.add(source);
  }
  /** The lit shader's bindings; `shadows: false` leaves out the local shadow maps (see `add`). */
  bindings(shadows = true): GPUBindGroupEntry[] {
    if (!this.uniform || this.disposed)
      throw new MargoError('state', 'Clustered lighting is not attached; attach it to an engine first');
    const own = shadows ? this.entries : this.lightEntries,
      parts = this.parts;
    parts[0] = own;
    parts[1] = shadows ? this.shadowHook?.bindings() : undefined;
    parts[2] = this.areaHook?.bindings();
    parts[3] = this.directionalHook?.bindings();
    parts[4] = this.iesHook?.bindings();
    parts[5] = this.projectorHook?.bindings();
    parts[6] = this.shapesHook?.bindings();
    parts[7] = shadows && (this.shadowHook || this.localShadows) ? this.stochasticHook?.bindings() : undefined;
    if (!parts[1] && !parts[2] && !parts[3] && !parts[4] && !parts[5] && !parts[6] && !parts[7]) return own;
    let joined = this.joined[+shadows],
      same = !!joined;
    for (let i = 0; same && i < 8; i++) same = joined![i] === parts[i];
    if (!same) this.joined[+shadows] = joined = [...parts, parts.flatMap((part) => part ?? [])];
    return joined![8]!;
  }
  /** gltf-pro lighting hooks in bind group `group`; `shadows: false` leaves out local-light shadows (see `add`). */
  pbr(group: number, shadows = true): { declarations: string; light: string; finish?: (code: string) => string } {
    // Hooks and shaders without shadows are cached under -1 - group.
    const key = shadows ? group : -1 - group;
    let hook = this.hooks.get(key);
    if (!hook) {
      hook = {
        declarations: this.sampling(group, shadows),
        light: 'clusterLighting(i.clip.xy,i.position,s.n,f.eye.xyz,s.base.rgb,s.roughness,s.metal,s.f0,s.sw)',
        ...(this.lobesHook ? { finish: (code: string) => this.lobesHook!.finish(code) } : {}),
      };
      this.hooks.set(key, hook);
    }
    return hook;
  }
  private sampling(group: number, shadows: boolean, receive = false): string {
    const more = {
      directional: this.directionalHook,
      terms: [this.iesHook, this.projectorHook].filter((hook) => hook !== undefined),
      shapes: this.shapesHook,
    };
    return shadows
      ? clusteredSampling(group, this.shadowHook, this.areaHook, !!this.localShadows, this.decay, receive, {
          ...more,
          stochastic: this.stochasticHook,
        })
      : clusteredSampling(group, undefined, this.areaHook, false, this.decay, false, more);
  }
  /**
   * Patches a core-style lit shader with the clustered light loop; `shadows: false` without local-light shadows. Core
   * meshes with `receiveShadow` false skip local-light shadows while the engine has one.
   */
  shader(source: string, group = 0, shadows = true): string {
    const receive = shadows && !!(this.localShadows || this.shadowHook) && unshadowedCore(this.engine, source),
      key = `${shadows ? group : -1 - group}${receive}`;
    let cache = this.shaders.get(key);
    const cached = cache?.get(source);
    if (cached) return cached;
    const base = source.includes('let base=terrainColor') ? 'base' : 'i.color';
    let code = source.replace(
      /let linear=([^;]+);/,
      `${receive ? `clusterReceive=${coreReceives};` : ''}let linear=$1+clusterLighting(i.clip.xy,i.position,n,frame.eye.xyz,${base},i.material.x,i.material.y,vec3f(0.04),1.0);`,
    );
    if (code === source)
      code = source.replace(
        'var color=',
        'var color=clusterLighting(i.clip.xy,i.position,s.n,f.eye.xyz,s.base.rgb,s.roughness,s.metal,vec3f(0.04),1.0)+',
      );
    if (code === source)
      throw new MargoError(
        'unsupported',
        "Clustered lighting requires the standard PBR shader; remove the plugin that replaced core's shader",
      );
    const output = this.sampling(group, shadows, receive) + code;
    if (!cache) {
      cache = new Map();
      this.shaders.set(key, cache);
    }
    cache.set(source, output);
    return output;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Clustered lighting requires WebGPU and a live effect; attach a new Clustered to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
    const count = this.grid[0] * this.grid[1] * this.grid[2],
      bytes = count * 1024 * 4;
    if (bytes > this.device.limits.maxStorageBufferBindingSize || bytes > this.device.limits.maxBufferSize)
      throw new RangeError('Cluster index list exceeds device limit; use a smaller cluster grid');
    const buffer = (size: number, usage: number) =>
      this.device!.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
    this.uniform = buffer(128, GPUBufferUsage.UNIFORM);
    this.lights = buffer(this.data.byteLength, GPUBufferUsage.STORAGE);
    this.counts = buffer(count * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.indices = buffer(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: this.device.createShaderModule({ code: cullingShader }), entryPoint: 'main' },
    });
    this.entries = this.lightEntries = [this.uniform, this.lights, this.counts, this.indices].map((buffer, i) => ({
      binding: i + 4,
      resource: { buffer },
    }));
    this.group = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: this.entries });
    this.dirty = true;
    if (this.localShadows) {
      this.localShadows.setup(engine);
      this.entries = [...this.entries, ...this.localShadows.bindings()];
    }
  }
  registerPasses(graph: FrameGraph): void {
    if (this.localShadows)
      graph.add({
        name: 'clustered-shadows',
        order: -4,
        execute: (c) => {
          if (c.backend === 'webgpu') this.localShadows!.render(c);
        },
      });
    graph.add({
      name: this.name,
      order: -3,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        const intensity = typeof this.intensityScale === 'function' ? this.intensityScale() : this.intensityScale;
        if (typeof intensity !== 'number' || !Number.isFinite(Math.fround(intensity)) || intensity < 0)
          throw new RangeError(
            'Invalid clustered intensity scale; set intensityScale (or return from it) a finite number of 0 or more',
          );
        for (const [receiver, remove] of this.receivers)
          if ('disposed' in receiver && receiver.disposed) {
            remove();
            this.receivers.delete(receiver);
          }
        if (this.dirty) {
          if (this.lightCount)
            c.device.queue.writeBuffer(
              this.lights!,
              0,
              this.data as Float32Array<ArrayBuffer>,
              0,
              this.lightCount * 16,
            );
          this.dirty = false;
        }
        viewMatrix(this.view, c.camera);
        for (let i = 0; i < 3; i++) this.ints[16 + i] = this.grid[i];
        this.ints[19] = intensity === 0 ? 0 : this.lightCount;
        const values = this.values;
        // The grid covers the view's rectangle (the whole target without a view).
        const [width, height] = viewSize(c);
        values[20] = width;
        values[21] = height;
        values[22] = Math.tan((c.camera.fov * Math.PI) / 360);
        values[23] = width / height;
        values[24] = c.camera.near;
        values[25] = c.camera.far;
        values[26] = values[27] = 0;
        values[28] = intensity;
        values[29] = values[30] = values[31] = 0;
        // Orthographic clip matrix (e.g. @margoengine/cameras): view-space half extents per NDC unit, signed near/far, NDC offset.
        const o = orthographic(c.camera.matrix, c.camera.position);
        if (o) {
          values[22] = 1 / o.sy;
          values[23] = o.sy / o.sx;
          values[24] = o.near;
          values[25] = o.far;
          values[29] = o.ox;
          values[30] = o.oy;
          values[31] = 1;
        }
        // Map jittered fragments back to the unjittered culling grid using the projection's screen offset.
        const m = c.camera.matrix,
          v = this.values;
        v[26] = -0.5 * (m[0] * v[2] + m[4] * v[6] + m[8] * v[10]);
        v[27] = 0.5 * (m[1] * v[2] + m[5] * v[6] + m[9] * v[10]);
        // The shader subtracts this offset times the grid size from the fragment pixel: add the view's origin.
        const rect = viewRect(c);
        if (rect) {
          v[26] += rect[0] / width;
          v[27] += rect[1] / height;
        }
        c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
        const pass = c.encoder.beginComputePass();
        pass.setPipeline(this.pipeline!);
        pass.setBindGroup(0, this.group!);
        pass.dispatchWorkgroups(Math.ceil((this.grid[0] * this.grid[1] * this.grid[2]) / 64));
        pass.end();
        c.shader = this.shader(c.shader);
        c.bindings.push(...this.bindings());
      },
    });
  }
  /** GPU buffers for diagnostics and custom forward materials; no production readback. */
  get lightLists(): { counts: GPUBuffer; indices: GPUBuffer } {
    if (!this.counts || !this.indices)
      throw new MargoError('state', 'Clustered lighting is not attached; attach it to an engine first');
    return { counts: this.counts, indices: this.indices };
  }
  private release(): void {
    this.localShadows?.release();
    for (const buffer of [this.uniform, this.lights, this.counts, this.indices]) buffer?.destroy();
    this.uniform = this.lights = this.counts = this.indices = undefined;
    this.pipeline = undefined;
    this.group = undefined;
    this.entries = this.lightEntries = [];
    this.shaders.clear();
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    for (const remove of this.receivers.values()) remove();
    this.receivers.clear();
    this.localShadows?.dispose();
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  destroy(): void {
    this.dispose();
  }
}
