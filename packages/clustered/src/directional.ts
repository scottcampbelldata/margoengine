/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type Vec3 } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import { MargoError } from '@margoengine/math/errors';
import type { Clustered, ClusteredDirectional } from './index.js';
import {
  directionalShadowSettings,
  MAX_DIRECTIONAL_SHADOWS,
  type DirectionalShadowLight,
} from './light-shadow-math.js';
export { MAX_DIRECTIONAL_SHADOWS } from './light-shadow-math.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };
/**
 * Shadow map settings of a castShadow {@link DirectionalLight}. Invalid values throw TypeError or RangeError from
 * `setLights`; a `resolution` above LocalShadows' throws RangeError when the maps render.
 */
export interface DirectionalLightShadow {
  /**
   * World-space box one orthographic map covers (three.js' shadow camera box): casters and receivers inside it.
   * Camera-independent, so the map re-renders only when the light or a caster changes. Omitted: cascades fitted to the
   * camera's view (`cascades`, `distance`), which re-render when the camera moves.
   */
  bounds?: { min: Vec3; max: Vec3 };
  /** Camera-fitted cascades without `bounds`, an integer 1-4 (default 3); each is one layer of LocalShadows' maps. */
  cascades?: number;
  /**
   * Farthest view distance the cascades cover, world units above 0 (default 100; the camera's far plane if nearer).
   * Casters up to this far beyond a cascade toward the light still cast into it.
   */
  distance?: number;
  /**
   * Map size in texels per cascade: one integer (square) or `[width, height]`, each from 16 up to LocalShadows'
   * `resolution` (the default). A smaller map renders into its layer's top-left corner, as a local light's.
   */
  resolution?: number | readonly [number, number];
}
/** A directional light beside core's sun (three.js `DirectionalLight`): parallel rays, no position or falloff. */
export interface DirectionalLight {
  /** The direction the light travels, world space (from the light toward the scene, as a spot's `direction`); need not be unit length. */
  direction: Vec3;
  /** Linear RGB, multiplied by `intensity` (default [1, 1, 1]). */
  color?: Vec3;
  /** Illuminance on a surface facing the light (lux in physical units; default 1), as core's `lighting.light[3]` for the sun. */
  intensity?: number;
  /**
   * Shadowed (default false) by the `LocalShadows` (`@margoengine/clustered/shadows`) attached to the same lights: its
   * casters, `resolution`, `bias` and `normalBias`, and its map array. Without LocalShadows the light stays unshadowed.
   * At most {@link MAX_DIRECTIONAL_SHADOWS} lights of a list cast.
   */
  castShadow?: boolean;
  /** Shadow map settings of a castShadow light (default: three cascades over the camera's first 100 units). */
  shadow?: DirectionalLightShadow;
}
/** Options of {@link DirectionalLights}. */
export interface DirectionalLightOptions {
  /** The clustered lighting whose light loop also evaluates these lights (core meshes and every `lights.add()` receiver). */
  lights: Clustered;
}
/** Directional lights per {@link DirectionalLights.setLights} call. */
export const MAX_DIRECTIONAL_LIGHTS = 16;
const LIGHT_FLOATS = 8,
  HEADER = 4,
  BINDING = 141;
const sampling = (group: number) => /* wgsl */ `
struct ClusterDirectionalLight {toLight:vec4f,color:vec4f}
struct ClusterDirectionalData {count:vec4u,lights:array<ClusterDirectionalLight,${MAX_DIRECTIONAL_LIGHTS}>}
@group(${group}) @binding(${BINDING}) var<storage,read> clusterDirectional:ClusterDirectionalData;
`;
/**
 * Directional lights for clustered lighting, beyond core's one sun (three.js `DirectionalLight`): GGX specular and
 * Lambert diffuse with the point lights' BRDF, so materials' Lambert and Phong shade them as they shade point lights and
 * a shadow catcher counts them. Core meshes and every receiver of the `lights` (gltf-pro models, materials meshes,
 * terrain) are lit; `Clustered.intensityScale` scales them too. Every fragment evaluates every light (no culling: the
 * lights reach everywhere). Lights with `castShadow` are shadowed by `LocalShadows` (orthographic maps fitted to a
 * `bounds` box or to the camera's view, 3x3 PCF). Without lights it adds nothing to the shaders or the GPU work.
 * @throws TypeError without the Clustered lights or for a malformed `shadow`; RangeError for an invalid light or
 * shadow setting, more than `MAX_DIRECTIONAL_LIGHTS` lights or more than `MAX_DIRECTIONAL_SHADOWS` castShadow lights.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 */
export class DirectionalLights implements EnginePlugin, ClusteredDirectional {
  readonly name = 'clustered:directional';
  readonly lights: Clustered;
  private engine?: Engine;
  private device?: GPUDevice;
  private buffer?: GPUBuffer;
  private entries: GPUBindGroupEntry[] = [];
  private readonly data = new Float32Array(HEADER + MAX_DIRECTIONAL_LIGHTS * LIGHT_FLOATS);
  private readonly count = new Uint32Array(this.data.buffer, 0, 1);
  private listValue: readonly DirectionalLight[] = Object.freeze([]);
  private shadowList: readonly DirectionalShadowLight[] = Object.freeze([]);
  private dirty = true;
  private disposed = false;
  constructor(options: DirectionalLightOptions) {
    if (!options?.lights || typeof options.lights.setLights !== 'function')
      throw new TypeError('DirectionalLights needs the Clustered lights: new DirectionalLights({ lights })');
    this.lights = options.lights;
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  static attach(instance: EngineKernel, options: DirectionalLightOptions): DirectionalLights {
    const effect = new DirectionalLights(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  /** The lights last given to `setLights`, in order (a frozen copy of the list). */
  get list(): readonly DirectionalLight[] {
    return this.listValue;
  }
  /**
   * Replaces the lights (at most {@link MAX_DIRECTIONAL_LIGHTS}, {@link MAX_DIRECTIONAL_SHADOWS} of them with
   * `castShadow`); validates every entry before changing anything. An empty list removes the shader code.
   */
  setLights(lights: readonly DirectionalLight[]): this {
    if (this.disposed) throw new MargoError('disposed', 'DirectionalLights is disposed; create new DirectionalLights');
    if (!Array.isArray(lights) || lights.length > MAX_DIRECTIONAL_LIGHTS)
      throw new RangeError(`Expected an array of at most ${MAX_DIRECTIONAL_LIGHTS} directional lights`);
    const shadows: DirectionalShadowLight[] = [];
    const packed = lights.map((light, index) => {
      finiteVector(light.direction, 3, 'Directional light direction');
      const color = light.color ?? [1, 1, 1],
        intensity = light.intensity ?? 1,
        [x, y, z] = light.direction,
        length = Math.sqrt(x * x + y * y + z * z);
      finiteVector(color, 3, 'Directional light color');
      if (!length || !Number.isFinite(Math.fround(intensity)) || intensity < 0)
        throw new RangeError('Directional light needs a nonzero direction and a finite intensity of 0 or more');
      // A wide-gamut (Display P3) colour keeps negative linear sRGB channels (the light loop sums linearly); its luminance cannot be negative.
      if (!(0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2] >= 0))
        throw new RangeError('Directional light color needs a luminance of 0 or more');
      if (light.castShadow !== undefined && typeof light.castShadow !== 'boolean')
        throw new TypeError('Directional light castShadow must be a boolean');
      if (light.castShadow) {
        if (shadows.length === MAX_DIRECTIONAL_SHADOWS)
          throw new RangeError(
            `At most ${MAX_DIRECTIONAL_SHADOWS} directional lights may cast shadows; set castShadow false on the others`,
          );
        shadows.push({
          index,
          direction: [x / length, y / length, z / length],
          ...directionalShadowSettings(light.shadow),
        });
      } else if (light.shadow !== undefined) directionalShadowSettings(light.shadow);
      return [
        -x / length,
        -y / length,
        -z / length,
        0,
        color[0] * intensity,
        color[1] * intensity,
        color[2] * intensity,
        0,
      ];
    });
    packed.forEach((values, i) => this.data.set(values, HEADER + i * LIGHT_FLOATS));
    this.count[0] = lights.length;
    this.listValue = Object.freeze([...lights]);
    this.shadowList = Object.freeze(shadows);
    this.dirty = true;
    this.sync();
    return this;
  }
  /** @internal ClusteredDirectional: the castShadow lights, in list order, for LocalShadows. */
  shadowLights(): readonly DirectionalShadowLight[] {
    return this.shadowList;
  }
  /** @internal ClusteredDirectional: WGSL defining `clusterDirectional`. */
  declarations(group: number): string {
    return sampling(group);
  }
  /** @internal ClusteredDirectional: binding 141 of the lit shader's group. */
  bindings(): GPUBindGroupEntry[] {
    if (!this.buffer || this.disposed)
      throw new MargoError(
        'state',
        'Directional lights are not attached; engine.use(lights) and set some lights first',
      );
    return this.entries;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'DirectionalLights is disposed; create new DirectionalLights');
    if (!engine.gpu) throw new MargoError('unsupported', 'DirectionalLights requires the WebGPU backend');
    this.engine = engine;
    this.device = engine.gpu;
    this.dirty = true;
    this.sync();
  }
  // The buffer and the hook exist only while there are lights, so an empty DirectionalLights changes no GPU call.
  private sync(): void {
    const active = !!this.device && !this.disposed && this.count[0] > 0;
    if (active && !this.buffer) {
      const buffer = (this.buffer = this.device!.createBuffer({
        size: this.data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }));
      this.entries = [{ binding: BINDING, resource: { buffer } }];
      this.dirty = true;
    }
    const hook = active ? this : undefined;
    if (this.lights.directional !== hook) this.lights.directional = hook;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -3.5,
      execute: (c) => {
        if (c.backend !== 'webgpu' || !this.buffer || !this.dirty) return;
        c.device.queue.writeBuffer(
          this.buffer,
          0,
          this.data as Float32Array<ArrayBuffer>,
          0,
          HEADER + this.count[0] * LIGHT_FLOATS,
        );
        this.dirty = false;
      },
    });
  }
  private release(): void {
    if (this.lights.directional === this) this.lights.directional = undefined;
    this.buffer?.destroy();
    this.buffer = undefined;
    this.entries = [];
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
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
