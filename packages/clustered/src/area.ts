/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import type { RectAreaLight } from '@margoengine/math';
import { finiteVector } from '@margoengine/math/validate';
import { MargoError } from '@margoengine/math/errors';
import type { Clustered, ClusteredArea } from './index.js';
import { ltcSize, ltcTable } from './ltc.js';
import { ltcPolygonWgsl } from './ltc-wgsl.js';
import { areaShadowSettings, MAX_AREA_SHADOWS, type AreaShadowLight } from './light-shadow-math.js';
import { rectFrame } from '../../shared/rect-frame.js';
export { MAX_AREA_SHADOWS } from './light-shadow-math.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };
// The light shapes live in @margoengine/math (shared with the voxel path tracer); re-exported here unchanged.
export type { AreaLightShadow, RectAreaLight } from '@margoengine/math';
/** Options of {@link AreaLights}. */
export interface AreaLightOptions {
  /** The clustered lighting whose light loop also evaluates the area lights (core meshes and every `lights.add()` receiver). */
  lights: Clustered;
  /**
   * Most area lights {@link AreaLights.setLights} takes, an integer from 1 to {@link MAX_AREA_LIGHTS_LIMIT}. Default
   * {@link MAX_AREA_LIGHTS}. Every lit fragment evaluates every area light (they are not clustered), so the cost of a
   * frame grows with the count.
   */
  maxLights?: number;
}
/** Area lights per {@link AreaLights.setLights} call by default. */
export const MAX_AREA_LIGHTS = 64;
/**
 * The `AreaLights.texture` hook (`AreaLightTextures` from `@margoengine/clustered/area-texture`): WGSL defining
 * `clusterAreaTexture(j, m, c, r, u, side)`, a vec3f factor of light j under the lobe transform m, and its bindings.
 */
export interface AreaLightTexture {
  declarations(group: number): string;
  bindings(): GPUBindGroupEntry[];
}
/** The highest `AreaLightOptions.maxLights`. */
export const MAX_AREA_LIGHTS_LIMIT = 1024;
const LIGHT_FLOATS = 16,
  HEADER = 4,
  lutOffset = (max: number) => (HEADER + max * LIGHT_FLOATS) * 4;
// One storage buffer, no textures: a count, the lights (centre + twoSided, half-width and half-height vectors, radiance) and the
// LTC table as pack2x16float pairs, three u32 per cell, filtered bilinearly by hand (environment's BRDF LUT does the same).
// Each light integrates the quad, clipped to the horizon, under the GGX LTC (specular) and the cosine (diffuse).
// `shadow` (LocalShadows' clusterAreaShadow factor, from Clustered) darkens each light; absent, the text is unchanged.
// LTC: Heitz, Dupuy, Hill & Neubelt 2016; Fresnel split f0 x magnitude + (1 - f0) x fresnel: Hill & Heitz 2016 course
// notes. Roughness floor 0.045: the minimum perceptual roughness of the Filament design document, a published engine
// standard.
const sampling = (group: number, max: number, shadow?: string, texture?: AreaLightTexture) => {
  const radiance = shadow ? 'radiance' : 'light.color.rgb',
    lit = (m: string) => (texture ? `${radiance}*clusterAreaTexture(j,${m},c,r,u,side)` : radiance);
  return (
    (texture ? texture.declarations(group) : '') +
    /* wgsl */ `
struct AreaLight {center:vec4f,right:vec4f,up:vec4f,color:vec4f}
struct AreaLightData {count:vec4u,lights:array<AreaLight,${max}>,lut:array<u32>}
@group(${group}) @binding(17) var<storage,read> areaLights:AreaLightData;
${ltcPolygonWgsl('area')}fn clusterAreaLighting(position:vec3f,n:vec3f,v:vec3f,nv:f32,base:vec3f,roughness:f32,metal:f32,dielectricF0:vec3f,dielectricF90:f32)->vec3f {
  let st=vec2f(clamp(roughness,0.045,1.0),sqrt(1-nv))*${ltcSize - 1}.0;let t1=vec4f(areaLut(st,0u),areaLut(st,1u));let t2=areaLut(st,2u);
  var t=v-n*dot(n,v);if(dot(t,t)<1e-8){t=cross(n,select(vec3f(1,0,0),vec3f(0,0,1),abs(n.x)>0.5));}
  let x=normalize(t);let local=transpose(mat3x3f(x,cross(n,x),n));
  let lobe=mat3x3f(vec3f(t1.x,0,t1.y),vec3f(0,1,0),vec3f(t1.z,0,t1.w))*local;
  var specular=vec3f(0);var diffuse=vec3f(0);
  for(var j=0u;j<areaLights.count.x;j++){
    let light=areaLights.lights[j];let c=light.center.xyz-position;let r=light.right.xyz;let u=light.up.xyz;
    var side=1.0;if(dot(cross(r,u),c)>0){if(light.center.w<0.5){continue;}side=-1.0;}
    let a=c-r-u;let b=c-r+u;let e=c+r+u;let d=c+r-u;${shadow ? `let radiance=light.color.rgb${shadow};` : ''}
    specular+=${lit('lobe')}*max(side*areaIntegral(lobe,a,b,e,d),0.0);diffuse+=${lit('local')}*max(side*areaIntegral(local,a,b,e,d),0.0);
  }
  let f0=mix(dielectricF0,base,metal);
  return (f0*t2.x+(mix(dielectricF90,1.0,metal)-f0)*t2.y)*specular+(1-metal)*base*diffuse;
}
`
  );
};
/**
 * Rectangular area lights for clustered lighting, shaded with Linearly Transformed Cosines (Heitz
 * et al. 2016): GGX specular and Lambert diffuse, the quad clipped exactly to each surface's horizon. Core meshes and every
 * receiver of the `lights` (gltf-pro models, materials meshes, terrain) are lit. Every fragment evaluates every area light
 * (no cluster culling: the lights have no range). Lights with `castShadow` are shadowed by `LocalShadows` (cube faces,
 * PCSS penumbrae scaled by the light's size). Without lights it adds nothing to the shaders or the GPU work.
 * @throws TypeError without the Clustered lights or for a malformed `castShadow` or `shadow`; RangeError for an invalid
 * light or shadow setting, more than `maxLights` lights or more than `MAX_AREA_SHADOWS` castShadow lights.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 */
export class AreaLights implements EnginePlugin, ClusteredArea {
  readonly name = 'clustered:area';
  readonly lights: Clustered;
  private engine?: Engine;
  private device?: GPUDevice;
  private buffer?: GPUBuffer;
  private entries: GPUBindGroupEntry[] = [];
  /** Most area lights `setLights` takes (`AreaLightOptions.maxLights`). */
  readonly maxLights: number;
  private readonly data: Float32Array;
  private readonly count: Uint32Array;
  private listValue: readonly RectAreaLight[] = Object.freeze([]);
  private textureHook?: AreaLightTexture;
  /** `entries` and the texture hook's, joined (rebuilt when either array changes). */
  private joined?: [GPUBindGroupEntry[], GPUBindGroupEntry[], GPUBindGroupEntry[]];
  private shadowList: readonly AreaShadowLight[] = Object.freeze([]);
  private dirty = true;
  private disposed = false;
  constructor(options: AreaLightOptions) {
    if (!options?.lights || typeof options.lights.setLights !== 'function')
      throw new TypeError('AreaLights needs the Clustered lights');
    this.lights = options.lights;
    const max = options.maxLights ?? MAX_AREA_LIGHTS;
    if (!Number.isInteger(max) || max < 1 || max > MAX_AREA_LIGHTS_LIMIT)
      throw new RangeError(`Invalid area maxLights; pass an integer from 1 to ${MAX_AREA_LIGHTS_LIMIT}`);
    this.maxLights = max;
    this.data = new Float32Array(HEADER + max * LIGHT_FLOATS);
    this.count = new Uint32Array(this.data.buffer, 0, 1);
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  static attach(instance: EngineKernel, options: AreaLightOptions): AreaLights {
    const effect = new AreaLights(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  /** The lights last given to `setLights`, in order (a frozen copy of the list; light helpers read it). */
  get list(): readonly RectAreaLight[] {
    return this.listValue;
  }
  /**
   * Replaces the area lights (at most `maxLights`, {@link MAX_AREA_SHADOWS} of them with `castShadow`);
   * validates every entry before changing anything. An empty list removes the shader code.
   */
  setLights(lights: readonly RectAreaLight[]): this {
    if (this.disposed || !Array.isArray(lights) || lights.length > this.maxLights)
      throw new RangeError(`Expected at most ${this.maxLights} area lights; raise AreaLightOptions.maxLights`);
    const shadows: AreaShadowLight[] = [];
    const packed = lights.map((light, index) => {
      finiteVector(light.position, 3, 'Area light position');
      finiteVector(light.direction, 3, 'Area light direction');
      finiteVector(light.color ?? [1, 1, 1], 3, 'Area light color');
      const intensity = light.intensity ?? 1,
        f = light.direction,
        length = Math.hypot(...f);
      if (
        !length ||
        ![light.width, light.height, intensity].every((v) => Number.isFinite(Math.fround(v)) && v >= 0) ||
        !light.width ||
        !light.height ||
        // Wide-gamut colours keep negative linear sRGB channels; the luminance cannot be negative.
        (light.color !== undefined &&
          !(0.2126 * light.color[0] + 0.7152 * light.color[1] + 0.0722 * light.color[2] >= 0)) ||
        typeof (light.twoSided ?? false) !== 'boolean'
      )
        throw new RangeError(
          'Invalid area light size/color/intensity/direction; give positive finite sizes, a colour with luminance of 0 or more, a finite intensity of 0 or more and a non-zero direction',
        );
      if (light.up) finiteVector(light.up, 3, 'Area light up');
      const { normal: n, right, up } = rectFrame(f, light.up, 'Area light'),
        color: ArrayLike<number> = light.color ?? [1, 1, 1];
      if (light.castShadow !== undefined && typeof light.castShadow !== 'boolean')
        throw new TypeError('Area light castShadow must be a boolean');
      if (light.castShadow) {
        // LocalShadows keeps shadow data for the first MAX_AREA_LIGHTS entries of the list only.
        if (index >= MAX_AREA_LIGHTS)
          throw new RangeError(
            `Only the first ${MAX_AREA_LIGHTS} area lights may cast shadows; move castShadow lights to the front`,
          );
        if (shadows.length === MAX_AREA_SHADOWS)
          throw new RangeError(
            `At most ${MAX_AREA_SHADOWS} area lights may cast shadows; set castShadow false on the others`,
          );
        shadows.push({
          index,
          center: [light.position[0], light.position[1], light.position[2]],
          normal: n as [number, number, number],
          right: right as [number, number, number],
          up: up as [number, number, number],
          twoSided: !!light.twoSided,
          ...areaShadowSettings(light.shadow),
        });
      } else if (light.shadow !== undefined) areaShadowSettings(light.shadow);
      return [
        ...light.position,
        light.twoSided ? 1 : 0,
        ...right.map((v) => (v * light.width) / 2),
        0,
        ...up.map((v) => (v * light.height) / 2),
        0,
        ...Array.from(color, (v: number) => v * intensity),
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
  /** Images on the rectangles (`AreaLightTextures` from `@margoengine/clustered/area-texture`); undefined: plain lights. */
  get texture(): AreaLightTexture | undefined {
    return this.textureHook;
  }
  set texture(hook: AreaLightTexture | undefined) {
    this.textureHook = hook;
    this.joined = undefined;
    // The Clustered setter drops its cached shaders, so they are rebuilt with (or without) the texture code.
    if (this.lights.area === this) this.lights.area = this;
  }
  /** @internal ClusteredArea: the castShadow lights, in list order, for LocalShadows. */
  shadowLights(): readonly AreaShadowLight[] {
    return this.shadowList;
  }
  /** @internal ClusteredArea: WGSL defining `clusterAreaLighting`; `shadow` multiplies each light (a `*` factor in `j`). */
  declarations(group: number, shadow?: string): string {
    return sampling(group, this.maxLights, shadow, this.textureHook);
  }
  /** @internal ClusteredArea: binding 17 of the lit shader's group. */
  bindings(): GPUBindGroupEntry[] {
    if (!this.buffer || this.disposed)
      throw new MargoError('state', 'Area lights are not attached; attach them to an engine first');
    if (!this.textureHook) return this.entries;
    const more = this.textureHook.bindings();
    if (this.joined?.[0] !== this.entries || this.joined[1] !== more)
      this.joined = [this.entries, more, [...this.entries, ...more]];
    return this.joined[2];
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Attach new AreaLights on WebGPU; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.dirty = true;
    this.sync();
  }
  // The buffer (with the table) and the hook exist only while there are lights, so an empty AreaLights changes no GPU call.
  private sync(): void {
    const active = !!this.device && !this.disposed && this.count[0] > 0;
    if (active && !this.buffer) {
      const table = ltcTable(),
        buffer = (this.buffer = this.device!.createBuffer({
          size: lutOffset(this.maxLights) + table.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }));
      this.device!.queue.writeBuffer(buffer, lutOffset(this.maxLights), table as Uint16Array<ArrayBuffer>);
      this.entries = [{ binding: 17, resource: { buffer } }];
      this.dirty = true;
    }
    const hook = active ? this : undefined;
    if (this.lights.area !== hook) this.lights.area = hook;
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
    if (this.lights.area === this) this.lights.area = undefined;
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
