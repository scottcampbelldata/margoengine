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
// `apertures` (some light has a `recess` or `sill`, packed in right.w and up.w): before the integral each such light's
// rectangle is clipped to the part the fragment sees through its wall's opening, the opening's outline projected from
// the fragment onto the light (the backprojection of G. Drettakis and E. Fiume, "A Fast Shadow Algorithm for Area
// Light Sources Using Backprojection", SIGGRAPH 1994, doi:10.1145/192161.192207; the visible part of a polygon source
// as the source less its occluders projected onto its plane, T. Nishita and E. Nakamae, SIGGRAPH 1985,
// doi:10.1145/325165.325169). The opening is the light's own outline `recess` in front of it and a sill's front edge
// `recess + sill` in front at its lower edge, so the projections are axis-aligned and the visible part stays a
// rectangle, which the LTC integral takes exactly (Heitz et al. 2016 integrate any polygon).
// LTC: Heitz, Dupuy, Hill & Neubelt 2016; Fresnel split f0 x magnitude + (1 - f0) x fresnel: Hill & Heitz 2016 course
// notes. Roughness floor 0.045: the minimum perceptual roughness of the Filament design document, a published engine
// standard.
const sampling = (group: number, max: number, shadow?: string, texture?: AreaLightTexture, apertures = false) => {
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
    ${
      apertures
        ? `${APERTURE_WGSL}
    let a=c+r*lo.x+u*lo.y;let b=c+r*lo.x+u*hi.y;let e=c+r*hi.x+u*hi.y;let d=c+r*hi.x+u*lo.y;`
        : 'let a=c-r-u;let b=c-r+u;let e=c+r+u;let d=c+r-u;'
    }${shadow ? `let radiance=light.color.rgb${shadow};` : ''}
    specular+=${lit('lobe')}*max(side*areaIntegral(lobe,a,b,e,d),0.0);diffuse+=${lit('local')}*max(side*areaIntegral(local,a,b,e,d),0.0);
  }
  let f0=mix(dielectricF0,base,metal);
  return (f0*t2.x+(mix(dielectricF90,1.0,metal)-f0)*t2.y)*specular+(1-metal)*base*diffuse;
}
`
  );
};
/**
 * The rectangle's part seen through its opening, `lo` to `hi` in units of its half extents (`apertureWindow` of
 * `@margoengine/clustered/bounce` is its JS twin): `q` the fragment across and up, `z` its distance in front, `k` the
 * projection's scale from the outline's plane.
 */
const APERTURE_WGSL = /* wgsl */ `var lo=vec2f(-1);var hi=vec2f(1);let depth=light.right.w;let sill=light.up.w;
    if(depth>0||sill>0){
      let q=-vec2f(dot(c,r)/dot(r,r),dot(c,u)/dot(u,u));let z=-dot(c,normalize(cross(r,u)));
      if(z>depth){let k=z/max(z-depth,1e-6);lo=max(lo,q-(1+q)*k);hi=min(hi,q+(1-q)*k);}
      else if(any(abs(q)>vec2f(1.001))){continue;}
      if(sill>0){if(z>depth+sill){lo.y=max(lo.y,q.y-(1+q.y)*z/max(z-depth-sill,1e-6));}else if(z>depth&&q.y< -1){continue;}}
      if(any(lo>=hi)){continue;}
    }`;
/**
 * Rectangular area lights for clustered lighting, shaded with Linearly Transformed Cosines (Heitz
 * et al. 2016): GGX specular and Lambert diffuse, the quad clipped exactly to each surface's horizon. Core meshes and every
 * receiver of the `lights` (gltf/pbr models, materials meshes, terrain) are lit. Every fragment evaluates every area light
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
  /** Some light has a `recess` or `sill`: the shader clips the lights to their openings. */
  private apertures = false;
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
      const recess = light.recess ?? 0,
        sill = light.sill ?? 0;
      if (
        ![recess, sill].every((v) => typeof v === 'number' && Number.isFinite(Math.fround(v)) && v >= 0) ||
        ((recess || sill) && light.twoSided)
      )
        throw new RangeError(
          'Invalid area light recess or sill; give finite numbers of 0 or more, on a one-sided light',
        );
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
        recess,
        ...up.map((v) => (v * light.height) / 2),
        sill,
        ...Array.from(color, (v: number) => v * intensity),
        0,
      ];
    });
    packed.forEach((values, i) => this.data.set(values, HEADER + i * LIGHT_FLOATS));
    this.count[0] = lights.length;
    const apertures = lights.some((l) => (l.recess ?? 0) > 0 || (l.sill ?? 0) > 0),
      rebuild = apertures !== this.apertures;
    this.apertures = apertures;
    this.listValue = Object.freeze([...lights]);
    this.shadowList = Object.freeze(shadows);
    this.dirty = true;
    this.sync();
    // The Clustered setter drops its cached shaders, so they are rebuilt with (or without) the opening clip.
    if (rebuild && this.lights.area === this) this.lights.area = this;
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
    return sampling(group, this.maxLights, shadow, this.textureHook, this.apertures);
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
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
type Rgb = readonly [number, number, number];
/** A surface of a room, for {@link openingLight}: its area and its diffuse reflectance. */
export interface RoomSurface {
  /** Area, square metres, 0 or more. */
  area: number;
  /** Diffuse reflectance (albedo), one number or linear RGB, each 0 to below 1: a material's base colour. */
  reflectance: number | Rgb;
}
/** {@link openingLight} options. Every number is checked: out of range throws RangeError. */
export interface OpeningLightOptions {
  /** Centre of the opening (a window or a doorway), world space, on its outer face: for glazing, the glass's outdoor face. */
  position: Rgb;
  /** The way out of the room through the opening: its outward normal (need not be unit length). */
  direction: Rgb;
  /** Opening size along `direction x up`, metres, above 0. */
  width: number;
  /** Opening size along `up`, metres, above 0. */
  height: number;
  /** Orientation hint, as {@link RectAreaLight.up}. Default [0, 1, 0]. */
  up?: Rgb;
  /** The room's inner surfaces (walls, floor, ceiling); their areas sum to the room's, the openings' excluded. */
  room: readonly RoomSurface[];
  /**
   * The lights in the room: point lights (`color` default [1, 1, 1], `intensity` default 1, candela). A light with a
   * flame `flicker` (`'candle'` or `'fire'`, `@margoengine/clustered/flicker`) counts at its time average, its intensity
   * times the curve's mean.
   */
  lights: readonly { color?: Rgb; intensity?: number; position?: Rgb; flicker?: { curve?: unknown } }[];
  /** Area of the room's other openings, square metres (each lets light out). Default 0. */
  openings?: number;
  /**
   * The glass in the opening. `'clear'` (default) lets each lamp's beam through, drawn by the lamp itself and its
   * shadows. `'frosted'` stops it: the frost re-emits what falls on it diffusely, so the opening's radiance also
   * carries the lamps' direct light on the pane (each light then needs its `position`). Use the same `glazing`,
   * `frost`, `lites`, `barWidth`, `barDepth` and `thickness` as the pane (`generateWindowPane` of
   * `@margoengine/procedural`) and add the pane and its bars as shadow casters.
   */
  glazing?: 'clear' | 'frosted';
  /**
   * How far frost has grown in from each lite's edges, 0 to 1, as `generateWindowPane`'s `frost`: the frosted border
   * is `frost x min(liteWidth, liteHeight) / 2` wide. Default 1, frosted over. Read only for frosted glazing.
   */
  frost?: number;
  /** Diffuse transmittance of the frosted glass, 0 to 1. Default {@link FROSTED_GLAZING}`.transmittance`. */
  transmittance?: number;
  /**
   * Lites across and up, as `generateWindowPane`'s `lites`: the glazing bars divide the opening into that many panes
   * of glass. The bars send out no light; through frosted glass they also shade the frost behind them from each lamp.
   * Default `[1, 1]`, no bars.
   */
  lites?: readonly [number, number];
  /** Face width of each glazing bar, metres, as `generateWindowPane`'s. Default 0.03. */
  barWidth?: number;
  /** Depth of each glazing bar, metres, centred on the glass, as `generateWindowPane`'s. Default 0.035. */
  barDepth?: number;
  /** Glass thickness, metres, as `generateWindowPane`'s: the frost lies this far behind `position`. Default 0.004. */
  thickness?: number;
  /**
   * How deep the opening's sides (its frame and the wall round it) reach into the room behind the frost, metres, 0 or
   * more: they shade the frost from a lamp that sees it past them. Default 0.
   */
  reveal?: number;
  /**
   * How far the wall's outer face stands in front of `position`, metres, 0 or more: the opening's sides reach that far
   * out, and shade what the opening's light lights outside (the snow under a window set back in a thick wall). The
   * light's {@link RectAreaLight.recess}. Default 0.
   */
  recess?: number;
  /**
   * How far a sill under the opening stands proud of the wall's outer face, metres, 0 or more: it shades the light from
   * what lies below it. The light's {@link RectAreaLight.sill}. Default 0.
   */
  sill?: number;
}
/**
 * Frosted window glass: 3 mm clear float glass, 0.90 transmittance at normal incidence (M. Rubin, "Optical properties
 * of soda lime silica glasses", Solar Energy Materials 12(4), 275-288, 1985, doi:10.1016/0165-1633(85)90052-8), frosted
 * over on its room side. Frost is ice, which absorbs next to no visible light (Warren and Brandt, J. Geophys. Res. 113,
 * D14220, 2008), so it only scatters: each crystal forward-peaked with asymmetry g = 0.89 (S. G. Warren, "Optical
 * properties of snow", Rev. Geophys. 20(1), 67-89, 1982). Frosted over means the room is no longer seen through it: the
 * unscattered share exp(-tau) of 0.7% at an optical depth tau = 5. A conservative scattering layer then lets through
 * T = 1 / (1 + 3 (1 - g) tau / 4) of the light falling on it, all of it diffuse (the Eddington approximation, E. P.
 * Shettle and J. A. Weinman, "The Transfer of Solar Irradiance Through Inhomogeneous Turbid Atmospheres Evaluated by
 * Eddington's Approximation", J. Atmos. Sci. 27(7), 1048-1055, 1970), 0.708, and reflects the rest, 0.292. Through the
 * glass, `transmittance` 0.90 x 0.708 = 0.637; `reflectance` 0.292, the frost's.
 */
export const FROSTED_GLAZING: Readonly<{ transmittance: number; reflectance: number }> = Object.freeze({
  transmittance: 0.9 / (1 + (3 * (1 - 0.89) * 5) / 4),
  reflectance: 1 - 1 / (1 + (3 * (1 - 0.89) * 5) / 4),
});
/** Mean of the flame flicker curves (`flameFlickerMean` of `@margoengine/clustered/flicker`), kept here unimported. */
const FLAME_MEAN: Readonly<Record<string, number>> = { candle: 0.9, fire: 0.75 };
/**
 * The light a lit room sends out through an opening, as a one-sided {@link RectAreaLight} filling it: what lights the
 * sill, the logs round a window and the snow under it at night. The room's own lights reach the outside directly only
 * along the rays that pass the opening (their shadows draw that); the rest strikes the room's surfaces, and what they
 * reflect, again and again, leaves through every opening at the room's mean radiance. That is an integrating sphere
 * with ports: D. G. Goebel, "Generalized Integrating-Sphere Theory", Applied Optics 6(1), 1967,
 * doi:10.1364/AO.6.000125, gives the wall radiance L = rho Phi / (pi A (1 - rho (1 - f))) for flux Phi striking walls
 * of area A and reflectance rho, f the ports' share of the area; a room's inter-reflected component is that same
 * enclosure sum (the split-flux method of Hopkinson, Longmore and Petherbridge, "An Empirical Formula for the
 * Computation of the Indirect Component of Daylight Factor", Trans. Illum. Eng. Soc. 19(7), 1954,
 * doi:10.1177/147715355401900701). Per channel: Phi = (1 - f) 4 pi sum(intensity x colour) (the direct share that
 * leaves at once is the point lights' own), A the room's area, rho its area-weighted reflectance; the radiance is the
 * light's `color` (intensity 1). A light of the room's mean is one sum for the time-averaged room: it does not follow
 * the flicker, and casts no shadow.
 * @throws RangeError for a non-finite or out-of-range number, an empty room, or a reflectance of 1 or more.
 * @example
 * const area = AreaLights.attach(engine, {lights});
 * area.setLights([openingLight({
 *   position: [1.2, 1.5, 2.66], direction: [0, 0, 1], width: 1.2, height: 1.1,
 *   room: [{area: 54, reflectance: [0.26, 0.21, 0.15]}, {area: 54, reflectance: 0.08}],
 *   lights: [{position: [1.2, 1.9, 1.9], ...hurricaneLantern()}],
 * })]);
 */
export function openingLight(options: OpeningLightOptions): RectAreaLight {
  const { position, direction, width, height, up, recess = 0, sill = 0 } = options ?? ({} as OpeningLightOptions),
    model = openingModel(options);
  if (![recess, sill].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0))
    throw new RangeError('Invalid openingLight recess or sill; give metres of 0 or more');
  return {
    position: [position[0], position[1], position[2]],
    direction: [direction[0], direction[1], direction[2]],
    width,
    height,
    ...(up ? { up: [up[0], up[1], up[2]] as [number, number, number] } : {}),
    color: model.mean as unknown as [number, number, number],
    intensity: 1,
    ...(recess ? { recess } : {}),
    ...(sill ? { sill } : {}),
  };
}
/** {@link glazingSurface} options: {@link openingLight}'s, with `glazing: 'frosted'`, and the size of its map. */
export interface GlazingSurfaceOptions extends OpeningLightOptions {
  /** Texels along the pane's longer side of `emissiveMap`, an integer from 2 to 2048. Default 256. */
  mapSize?: number;
}
/** A frosted pane's two faces as `PbrMaterial` options of `@margoengine/materials`, from {@link glazingSurface}. */
export interface GlazingSurface {
  /**
   * The outdoor face: the frost's reflectance, and the light it lets through as `emissive` x `emissiveMap` x
   * `emissiveIntensity`: `emissive` white, `emissiveIntensity` the pane's brightest radiance, the map the radiance over
   * it. Give it `emissiveMap: new Texture(look.emissiveMap)` (`@margoengine/materials`).
   */
  outside: {
    color: [number, number, number];
    roughness: number;
    metalness: number;
    emissive: [number, number, number];
    emissiveIntensity: number;
  };
  /** The room face: the frost's reflectance, lit by the room's lights. */
  inside: { color: [number, number, number]; roughness: number; metalness: number };
  /**
   * The radiance the frost sends out at each point of the pane, over `outside.emissiveIntensity`, as sRGB-encoded RGBA8
   * texels (a `Texture` source of `@margoengine/materials`, its default sRGB colour space): row 0 the pane's top edge,
   * column 0 its left (seen from outside), as the UVs of `generateWindowPane`'s `frosted` lie. `mapSize` texels along
   * the longer side.
   */
  emissiveMap: { data: Uint8Array; width: number; height: number };
}
/**
 * The surfaces of a frosted pane in an opening, for the pane's two material slots (`generateWindowPane`'s `frosted`
 * groups, `@margoengine/procedural`): outside, the radiance the frost sends out at each point, its transmittance times
 * the irradiance on its room side over pi, `L(x) = tau_d E(x) / pi`; both faces reflect as the frost does, a matte white
 * of {@link FROSTED_GLAZING}`.reflectance`. E(x) is each lamp's intensity times the cosine at x over the squared
 * distance, where the glazing bars and the opening's reveal let it reach x, plus the room's own light; so the pane is
 * brightest nearest the lamp and carries the bars' shadows. Its mean over the opening is {@link openingLight}'s
 * radiance, so the opening's light carries the same flux. Takes {@link openingLight}'s options with
 * `glazing: 'frosted'`; the lamps are taken where they are given, so call it again when one moves.
 * @throws RangeError as {@link openingLight}, for glazing that is not frosted or a `mapSize` out of range.
 * @example
 * const opening = {position: [1.2, 1.5, 2.67], direction: [0, 0, 1], width: 1.2, height: 1.1, glazing: 'frosted',
 *   lites: [2, 2], room: [{area: 54, reflectance: 0.26}], lights: [{position: [1.2, 1.9, 1.9], ...hurricaneLantern()}]} as const;
 * const look = glazingSurface(opening);
 * // new PbrMaterial({...look.outside, emissiveMap: new Texture(look.emissiveMap, {wrapS: 'clamp', wrapT: 'clamp'})}),
 * // new PbrMaterial(look.inside)
 */
export function glazingSurface(options: GlazingSurfaceOptions): GlazingSurface {
  if (options?.glazing !== 'frosted') throw new RangeError("Invalid glazingSurface glazing; give glazing 'frosted'");
  const { mapSize = 256 } = options;
  if (!(Number.isInteger(mapSize) && mapSize >= 2 && mapSize <= 2048))
    throw new RangeError('Invalid glazingSurface mapSize; give an integer from 2 to 2048');
  const model = openingModel(options),
    { width: W, height: H } = options,
    nx = Math.max(1, Math.round(W >= H ? mapSize : (mapSize * W) / H)),
    ny = Math.max(1, Math.round(H >= W ? mapSize : (mapSize * H) / W)),
    values = new Float64Array(nx * ny * 3),
    // A texel centre on a bar is read at the nearest glass, so the map does not darken the glass beside the bar.
    onGlass = (c: number, lites: readonly Interval[]) => {
      let best = c,
        gap = Infinity;
      for (const [a, b] of lites) {
        const q = Math.min(b - 1e-9, Math.max(a + 1e-9, c));
        if (Math.abs(q - c) < gap) [best, gap] = [q, Math.abs(q - c)];
      }
      return best;
    };
  let peak = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = onGlass(-W / 2 + ((i + 0.5) * W) / nx, model.across.lites),
        y = onGlass(H / 2 - ((j + 0.5) * H) / ny, model.up.lites),
        L = model.radiance(x, y);
      for (let k = 0; k < 3; k++) peak = Math.max(peak, (values[(j * nx + i) * 3 + k] = L[k]));
    }
  const data = new Uint8Array(nx * ny * 4),
    srgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  for (let p = 0; p < nx * ny; p++) {
    for (let k = 0; k < 3; k++) data[p * 4 + k] = Math.round(255 * srgb(peak > 0 ? values[p * 3 + k] / peak : 0));
    data[p * 4 + 3] = 255;
  }
  const rho = FROSTED_GLAZING.reflectance;
  return {
    outside: { color: [rho, rho, rho], roughness: 1, metalness: 0, emissive: [1, 1, 1], emissiveIntensity: peak },
    inside: { color: [rho, rho, rho], roughness: 1, metalness: 0 },
    emissiveMap: { data, width: nx, height: ny },
  };
}
/** Solid angle of the rectangle `corners` (in order) seen from `p`: two triangles by the formula of A. van Oosterom
 * and J. Strackee, "The Solid Angle of a Plane Triangle", IEEE Trans. Biomed. Eng. BME-30(2), 125-126, 1983. */
function solidAngle(p: readonly number[], corners: readonly number[][]): number {
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    tri = (a: number[], b: number[], c: number[]) => {
      const la = Math.hypot(a[0], a[1], a[2]),
        lb = Math.hypot(b[0], b[1], b[2]),
        lc = Math.hypot(c[0], c[1], c[2]),
        det =
          a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
      return 2 * Math.atan2(Math.abs(det), la * lb * lc + dot(a, b) * lc + dot(a, c) * lb + dot(b, c) * la);
    };
  const v = corners.map((c) => [c[0] - p[0], c[1] - p[1], c[2] - p[2]]);
  return tri(v[0], v[1], v[2]) + tri(v[0], v[2], v[3]);
}
type Interval = readonly [number, number];
/** Lites and bars along one side of a pane, as `generateWindowPane` (`@margoengine/procedural`) lays them out. */
function paneLayout(size: number, lites: number, bar: number): { lites: Interval[]; bars: Interval[] } {
  const lite = (size - (lites - 1) * bar) / lites,
    out: { lites: Interval[]; bars: Interval[] } = { lites: [], bars: [] };
  for (let i = 0; i < lites; i++) {
    const a = -size / 2 + i * (lite + bar);
    out.lites.push([a, a + lite]);
    if (i) out.bars.push([a - bar, a]);
  }
  return out;
}
/** `set` (sorted, disjoint intervals) less `cut`. */
function subtract(set: readonly Interval[], cut: Interval): Interval[] {
  const out: Interval[] = [];
  for (const [a, b] of set) {
    if (cut[1] <= a || cut[0] >= b) out.push([a, b]);
    else {
      if (cut[0] > a) out.push([a, cut[0]]);
      if (cut[1] < b) out.push([cut[1], b]);
    }
  }
  return out;
}
const clip = (set: readonly Interval[], [a, b]: Interval): Interval[] =>
  set.flatMap(([c, d]) => (Math.max(a, c) < Math.min(b, d) ? [[Math.max(a, c), Math.min(b, d)] as Interval] : []));
/**
 * Along one side of the frost, where a point lamp at `l` (along that side) and `depth` behind the frost (above 0)
 * reaches it. A ray from frost point x to the lamp is at x + s (l - x) a share s of the way; it clears a bar [a, b]
 * standing `stand` proud of the frost if it stays outside [a, b] for every s up to stand / depth, and the reveal,
 * `reveal` deep, if it is inside the opening at s = reveal / depth.
 */
function litAlong(
  size: number,
  l: number,
  depth: number,
  bars: readonly Interval[],
  stand: number,
  reveal: number,
): Interval[] {
  const half = size / 2,
    through = (edge: number, s: number) => (edge - s * l) / (1 - s);
  let lit: Interval[] = [[-half, half]];
  if (reveal > 0) {
    const s = reveal / depth;
    if (s >= 1) return Math.abs(l) <= half ? lit : [];
    lit = clip(lit, [through(-half, s), through(half, s)]);
  }
  const s = Math.min(1, stand / depth);
  for (const [a, b] of bars) {
    if (s >= 1) lit = subtract(lit, l < a ? [a, Infinity] : l > b ? [-Infinity, b] : [-Infinity, Infinity]);
    else lit = subtract(lit, s > 0 ? [Math.min(a, through(a, s)), Math.max(b, through(b, s))] : [a, b]);
  }
  return lit;
}
/**
 * The opening's light. `room` is the room's inter-reflected radiance (an integrating sphere with ports); `mean` the
 * opening's mean radiance, its flux over pi and its area, from the clear glass (the room's radiance), the frosted
 * glass (`radiance` integrated exactly: a lamp's irradiance integrates over a rectangle to its intensity times the
 * rectangle's solid angle, and the lit part of each lite is a set of rectangles) and the bars (none); `radiance(x, y)`
 * a frosted pane's at a point of the opening (local X across, Y up, from its centre).
 */
function openingModel(options: OpeningLightOptions) {
  const { position, direction, width, height, up, room, lights, openings = 0 } = options ?? ({} as OpeningLightOptions),
    bad = (what: string) => new RangeError(`Invalid openingLight ${what}`),
    finite = (v: unknown, low = 0) => typeof v === 'number' && Number.isFinite(v) && v >= low;
  for (const [name, v] of [
    ['position', position],
    ['direction', direction],
    ['up', up ?? [0, 1, 0]],
  ] as const)
    if (!Array.isArray(v) || v.length !== 3 || !v.every((c) => typeof c === 'number' && Number.isFinite(c)))
      throw bad(`${name}; give [x, y, z]`);
  if (!(finite(width) && width > 0 && finite(height) && height > 0)) throw bad('size; give a width and height above 0');
  if (!finite(openings)) throw bad('openings; give an area of 0 or more');
  if (!Array.isArray(room) || !Array.isArray(lights)) throw bad('room or lights; give arrays');
  const {
    glazing = 'clear',
    frost = 1,
    transmittance = FROSTED_GLAZING.transmittance,
    lites = [1, 1],
    barWidth = 0.03,
    barDepth = 0.035,
    thickness = 0.004,
    reveal = 0,
  } = options;
  if (glazing !== 'clear' && glazing !== 'frosted') throw bad("glazing; give 'clear' or 'frosted'");
  if (!(finite(frost) && frost <= 1) || !(finite(transmittance) && transmittance <= 1))
    throw bad('frost or transmittance; give each from 0 to 1');
  const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 16;
  if (
    !Array.isArray(lites) ||
    lites.length !== 2 ||
    !count(lites[0]) ||
    !count(lites[1]) ||
    !(finite(barWidth) && barWidth > 0 && barWidth < Math.min(width / lites[0], height / lites[1])) ||
    !(finite(thickness) && thickness > 0 && thickness <= 0.1) ||
    !(finite(barDepth) && barDepth >= thickness && barDepth <= 0.3) ||
    !finite(reveal)
  )
    throw bad(
      'lites, bars, thickness or reveal; give lites of two integers from 1 to 16, a barWidth above 0 under the size over the lites, a thickness above 0 up to 0.1, a barDepth from the thickness up to 0.3 and a reveal of 0 or more',
    );
  let area = 0;
  const reflected = [0, 0, 0],
    flux = [0, 0, 0];
  for (const surface of room) {
    const r = surface?.reflectance,
      rgb = typeof r === 'number' ? [r, r, r] : r;
    if (!finite(surface?.area) || !Array.isArray(rgb) || rgb.length !== 3 || !rgb.every((c) => finite(c) && c < 1))
      throw bad('room surface; give an area of 0 or more and a reflectance from 0 to below 1');
    area += surface.area;
    for (let k = 0; k < 3; k++) reflected[k] += surface.area * rgb[k];
  }
  const ports = width * height + openings,
    total = area + ports;
  if (!(area > 0)) throw bad('room; give surfaces of some area');
  const lamps: { at: number[]; power: number[] }[] = [];
  for (const light of lights) {
    const color = light?.color ?? [1, 1, 1],
      intensity = light?.intensity ?? 1,
      curve = light?.flicker?.curve;
    if (!finite(intensity) || !Array.isArray(color) || color.length !== 3 || !color.every((c) => finite(c)))
      throw bad('light; give a colour and an intensity of 0 or more');
    const mean = typeof curve === 'string' && curve in FLAME_MEAN ? FLAME_MEAN[curve] : 1;
    for (let k = 0; k < 3; k++) flux[k] += 4 * Math.PI * intensity * mean * color[k];
    if (glazing === 'frosted') {
      const p = light.position;
      if (!Array.isArray(p) || p.length !== 3 || !p.every((c) => typeof c === 'number' && Number.isFinite(c)))
        throw bad('light position; frosted glazing needs each light at [x, y, z]');
      lamps.push({ at: [...p], power: color.map((c) => intensity * mean * c) });
    }
  }
  const f = ports / total,
    color = [0, 1, 2].map((k) => {
      const rho = reflected[k] / area;
      return (rho * flux[k] * (1 - f)) / (Math.PI * total * (1 - rho * (1 - f)));
    }),
    across = paneLayout(width, lites[0], barWidth),
    upward = paneLayout(height, lites[1], barWidth),
    liteW = across.lites[0][1] - across.lites[0][0],
    liteH = upward.lites[0][1] - upward.lites[0][0],
    glass = lites[0] * lites[1] * liteW * liteH,
    base = { across, up: upward, room: color };
  if (glazing === 'clear')
    return {
      ...base,
      mean: color.map((c) => (c * glass) / (width * height)),
      radiance: (_x: number, _y: number) => color,
    };
  // The frost lies on the glass's room face, `thickness` behind `position`, in the frame u (across), v (up), n (out).
  // Each lamp behind it, in that frame, with the stretches of each side its light reaches: the lit part of the frost is
  // their product, since a column's bar shades the whole height and a row's the whole width.
  const n = normalize(direction),
    v = normalize(cross(cross(n, normalize(up ?? [0, 1, 0])), n)),
    u = cross(v, n),
    stand = (barDepth - thickness) / 2,
    seen = lamps.flatMap(({ at, power }) => {
      const d = [0, 1, 2].map((k) => at[k] - position[k]),
        local = [d[0] * u[0] + d[1] * u[1] + d[2] * u[2], d[0] * v[0] + d[1] * v[1] + d[2] * v[2]],
        depth = -(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) - thickness;
      if (!(depth > 0)) return [];
      return [
        {
          local,
          depth,
          power,
          xs: litAlong(width, local[0], depth, across.bars, stand, reveal),
          ys: litAlong(height, local[1], depth, upward.bars, stand, reveal),
        },
      ];
    }),
    // Integral over a rectangle of the frost of each lamp's irradiance where it reaches, per channel.
    integral = (x0: number, x1: number, y0: number, y1: number) => {
      const sum = [0, 0, 0];
      for (const lamp of seen)
        for (const [a, b] of clip(lamp.xs, [x0, x1]))
          for (const [c, e] of clip(lamp.ys, [y0, y1])) {
            const omega = solidAngle(
              [lamp.local[0], lamp.local[1], -lamp.depth],
              [
                [a, c, 0],
                [b, c, 0],
                [b, e, 0],
                [a, e, 0],
              ],
            );
            for (let k = 0; k < 3; k++) sum[k] += lamp.power[k] * omega;
          }
      return sum;
    },
    border = (frost * Math.min(liteW, liteH)) / 2,
    cw = Math.max(0, liteW / 2 - border),
    ch = Math.max(0, liteH / 2 - border),
    open = cw > 1e-9 && ch > 1e-9,
    frosted = [0, 0, 0];
  let clearArea = 0;
  for (const [x0, x1] of across.lites)
    for (const [y0, y1] of upward.lites) {
      const mx = (x0 + x1) / 2,
        my = (y0 + y1) / 2,
        whole = integral(x0, x1, y0, y1),
        middle = open ? integral(mx - cw, mx + cw, my - ch, my + ch) : [0, 0, 0];
      if (open) clearArea += 4 * cw * ch;
      for (let k = 0; k < 3; k++) frosted[k] += whole[k] - middle[k];
    }
  const frostedArea = glass - clearArea;
  return {
    ...base,
    // tau_d (E / pi + L_room) integrated over the frosted glass, plus the room's radiance through the clear glass.
    mean: [0, 1, 2].map(
      (k) =>
        (transmittance * (frosted[k] / Math.PI + color[k] * frostedArea) + color[k] * clearArea) / (width * height),
    ),
    radiance(x: number, y: number): number[] {
      const L = [0, 0, 0];
      for (const lamp of seen) {
        if (!lamp.xs.some(([a, b]) => x >= a && x <= b) || !lamp.ys.some(([a, b]) => y >= a && y <= b)) continue;
        const dx = lamp.local[0] - x,
          dy = lamp.local[1] - y,
          r2 = dx * dx + dy * dy + lamp.depth * lamp.depth,
          e = lamp.depth / (r2 * Math.sqrt(r2));
        for (let k = 0; k < 3; k++) L[k] += lamp.power[k] * e;
      }
      return L.map((c, k) => transmittance * (c / Math.PI + color[k]));
    },
  };
}
const cross = (a: readonly number[], b: readonly number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  normalize = (a: readonly number[]) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return [a[0] / l, a[1] / l, a[2] / l];
  };
