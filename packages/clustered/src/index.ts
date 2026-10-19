/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type Vec3 } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import { viewMatrix } from '../../shared/view.js';
import { orthographic } from '../../shared/projection.js';
import { coreReceives, unshadowedCore } from '../../shared/shadow-source.js';
import { cullingShader, clusteredSampling } from './shader.js';
import {
  LocalShadowMaps,
  type LocalShadowOptions,
  type LocalLightShadow,
  type LocalShadowSource,
} from './local-shadows.js';
export { clusteredSampling } from './shader.js';
export type { LocalShadowOptions, LocalLightShadow, LocalShadowSource, LocalShadowPrimitive } from './local-shadows.js';
declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number; COPY_SRC: number };
export interface PointLight {
  position: Vec3;
  /**
   * Distance where the light ends, windowed smoothly: `clamp(1 - (d / range)^4, 0, 1)^2`. 0 is unlimited (window 1;
   * the light reaches every cluster), not allowed for a light with a shadow map.
   */
  range: number;
  color?: Vec3;
  intensity?: number;
  /**
   * Distance falloff exponent, 0 or more: attenuation is `window / max(d^decay, 0.01)` (2 is inverse-square, 0 none).
   * A light that sets neither `decay` nor `angle` keeps the original inverse-square shader term, `d * d`, bit for bit.
   */
  decay?: number;
  shadow?: boolean | LocalLightShadow;
  castShadow?: boolean;
}
export interface SpotLight extends PointLight {
  direction: Vec3;
  /**
   * Cone half-angle in radians, up to pi / 2 (a hemisphere), with `innerAngle` (0 to outer) where the smooth edge
   * starts. A hemisphere's local shadow map is the six cube faces of a point light.
   */
  outerAngle?: number;
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
export interface ClusteredOptions {
  grid?: readonly [number, number, number];
  shadows?: LocalShadowOptions;
}
export interface ClusteredShadow {
  declarations(group: number): string;
  bindings(): GPUBindGroupEntry[];
}
export interface ClusteredArea {
  declarations(group: number): string;
  bindings(): GPUBindGroupEntry[];
}
export interface ClusteredReceiver {
  addLighting(effect: ClusteredLighting): () => void;
}
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
  private lightCount = 0;
  private dirty = true;
  private disposed = false;
  private readonly view = this.values.subarray(0, 16);
  private readonly shaders = new Map<string, Map<string, string>>();
  private readonly localShadows?: LocalShadowMaps;
  private readonly hooks = new Map<number, { declarations: string; light: string }>();
  private shadowHook?: ClusteredShadow;
  private areaHook?: ClusteredArea;
  /** Joined bindings without (0) and with (1) shadows: the parts they were joined from, then the result. */
  private readonly joined: (
    | [GPUBindGroupEntry[] | undefined, GPUBindGroupEntry[] | undefined, GPUBindGroupEntry[], GPUBindGroupEntry[]]
    | undefined
  )[] = [];
  get shadow(): ClusteredShadow | undefined {
    return this.shadowHook;
  }
  set shadow(hook: ClusteredShadow | undefined) {
    this.shadowHook = hook;
    this.shaders.clear();
    this.hooks.clear();
  }
  get area(): ClusteredArea | undefined {
    return this.areaHook;
  }
  set area(hook: ClusteredArea | undefined) {
    this.areaHook = hook;
    this.shaders.clear();
    this.hooks.clear();
  }
  constructor(options: ClusteredOptions = {}) {
    const grid = options.grid ?? [16, 9, 24];
    if (
      grid.length !== 3 ||
      grid.some((v) => !Number.isInteger(v) || v < 1 || v > 128) ||
      grid.reduce((a, b) => a * b, 1) > 32768
    )
      throw new RangeError('Invalid cluster grid');
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
        (light.color ?? []).some((v: number) => v < 0)
      )
        throw new RangeError('Invalid light range/color/intensity');
      if (light.decay !== undefined && !(Number.isFinite(Math.fround(light.decay)) && light.decay >= 0))
        throw new RangeError('Light decay must be a finite number of 0 or more; 2 is inverse-square');
      if (light.range === 0 && (light.castShadow || (light.shadow !== undefined && light.shadow !== false)))
        throw new RangeError('A light with a shadow map needs a finite range (0 is unlimited); give it a range');
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
          throw new RangeError('Invalid spot cone');
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
    else if (lights.some((light) => light.shadow !== undefined && light.shadow !== false))
      throw new RangeError('Light shadows require ClusteredOptions.shadows');
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
      if (this.localShadows) this.data[offset + 15] = this.localShadows.shadowIndex(i);
    });
    const decay = lights.some(fresh);
    if (decay !== this.decay) {
      this.decay = decay;
      this.shaders.clear();
      this.hooks.clear();
    }
    this.lightCount = lights.length;
    this.dirty = true;
    return this;
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
      throw new TypeError('Invalid or duplicate clustered receiver');
    const remove = receiver.addLighting(receiveShadow ? this : this.unshadowed);
    this.receivers.set(receiver, remove);
    return () => {
      if (this.receivers.delete(receiver)) remove();
    };
  }
  /** Register an opaque or alpha-masked caster for opted-in local-light shadows. */
  addShadowCaster(source: MeshHandle | LocalShadowSource): () => void {
    if (this.disposed || !this.localShadows)
      throw new Error('Light shadows require a live ClusteredOptions.shadows effect');
    return this.localShadows.add(source);
  }
  /** The lit shader's bindings; `shadows: false` leaves out the local shadow maps (see `add`). */
  bindings(shadows = true): GPUBindGroupEntry[] {
    if (!this.uniform || this.disposed) throw new Error('Clustered lighting is not attached');
    const own = shadows ? this.entries : this.lightEntries,
      shadow = shadows ? this.shadowHook?.bindings() : undefined,
      area = this.areaHook?.bindings();
    if (!shadow && !area) return own;
    let joined = this.joined[+shadows];
    if (!joined || joined[0] !== shadow || joined[1] !== area || joined[2] !== own)
      this.joined[+shadows] = joined = [shadow, area, own, [...own, ...(shadow ?? []), ...(area ?? [])]];
    return joined[3];
  }
  /** gltf-pro lighting hooks in bind group `group`; `shadows: false` leaves out local-light shadows (see `add`). */
  pbr(group: number, shadows = true): { declarations: string; light: string } {
    // Hooks and shaders without shadows are cached under -1 - group.
    const key = shadows ? group : -1 - group;
    let hook = this.hooks.get(key);
    if (!hook) {
      hook = {
        declarations: this.sampling(group, shadows),
        light: 'clusterLighting(i.clip.xy,i.position,s.n,f.eye.xyz,s.base.rgb,s.roughness,s.metal)',
      };
      this.hooks.set(key, hook);
    }
    return hook;
  }
  private sampling(group: number, shadows: boolean, receive = false): string {
    return shadows
      ? clusteredSampling(group, this.shadowHook, this.areaHook, !!this.localShadows, this.decay, receive)
      : clusteredSampling(group, undefined, this.areaHook, false, this.decay);
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
      `${receive ? `clusterReceive=${coreReceives};` : ''}let linear=$1+clusterLighting(i.clip.xy,i.position,n,frame.eye.xyz,${base},i.material.x,i.material.y);`,
    );
    if (code === source)
      code = source.replace(
        'var color=',
        'var color=clusterLighting(i.clip.xy,i.position,s.n,f.eye.xyz,s.base.rgb,s.roughness,s.metal)+',
      );
    if (code === source) throw new Error('Clustered lighting requires the standard PBR shader');
    const output = this.sampling(group, shadows, receive) + code;
    if (!cache) {
      cache = new Map();
      this.shaders.set(key, cache);
    }
    cache.set(source, output);
    return output;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu) throw new Error('Clustered lighting requires WebGPU and a live effect');
    this.engine = engine;
    this.device = engine.gpu;
    const count = this.grid[0] * this.grid[1] * this.grid[2],
      bytes = count * 1024 * 4;
    if (bytes > this.device.limits.maxStorageBufferBindingSize || bytes > this.device.limits.maxBufferSize)
      throw new RangeError('Cluster index list exceeds device limit');
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
          throw new RangeError('Invalid clustered intensity scale');
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
        values[20] = c.width;
        values[21] = c.height;
        values[22] = Math.tan((c.camera.fov * Math.PI) / 360);
        values[23] = c.width / c.height;
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
    if (!this.counts || !this.indices) throw new Error('Clustered lighting is not attached');
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
