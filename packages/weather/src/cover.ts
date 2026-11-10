/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, FrameGraph, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';

/** The live map supplied by an unattached sky WeatherFX capture. */
export interface PrecipitationMap {
  readonly buffer?: GPUBuffer;
  readonly view?: GPUTextureView;
}
/** An unattached WeatherFX. The cover takes ownership and schedules its map before surfaces draw. */
export interface PrecipitationCapture extends EnginePlugin {
  readonly options: { readonly weather: { readonly occlusion?: PrecipitationMap } };
  readonly coverTexture?: GPUTexture;
}
/** Settings fixed when constructing the cover. */
export interface PrecipitationCoverOptions {
  /** Receiver tolerance in metres, finite and nonnegative. Default 0.02. */
  bias?: number;
}

/**
 * A single top-down WeatherFX depth map shared by rain, snow and surface weather.
 * Pass an unattached new WeatherFX({weather, occluders}) as capture. Core Puddles
 * and Snow are covered automatically; pass this effect as GLTFWeather.options.cover
 * for imported surfaces. The capture's splash and lens passes are not installed.
 * @throws MargoError for an attached/disposed capture or missing map pass.
 * @throws RangeError when bias is not finite and nonnegative.
 */
export class PrecipitationCover implements EnginePlugin {
  readonly name = 'weather-cover';
  readonly bias: number;
  private engine?: Engine;
  private disposed = false;
  private readonly cache = new Map<string, string>();

  constructor(readonly capture: PrecipitationCapture, options: PrecipitationCoverOptions = {}) {
    this.bias = options.bias ?? 0.02;
    if (!Number.isFinite(this.bias) || this.bias < 0)
      throw new RangeError('PrecipitationCover bias must be finite and nonnegative; pass metres');
  }

  /** Attaches the cover and takes ownership of its previously unattached capture. */
  static attach(engine: EngineKernel, capture: PrecipitationCapture, options?: PrecipitationCoverOptions): PrecipitationCover {
    const cover = new PrecipitationCover(capture, options);
    engineRuntime(engine).use(cover);
    return cover;
  }

  /** The underlying top-down depth32float map, updated every frame. */
  get texture(): GPUTexture | undefined { return this.capture.coverTexture; }

  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'PrecipitationCover is disposed; create a new cover');
    if (this.capture.options.weather.occlusion?.buffer)
      throw new MargoError('attached', 'Pass an unattached new WeatherFX to PrecipitationCover.attach');
    this.capture.setup(engine);
    this.engine = engine;
  }

  onPreUpdate(delta: number): void {
    if (this.disposed) throw new MargoError('disposed', 'PrecipitationCover is disposed; create a new cover');
    this.capture.onPreUpdate?.(delta);
  }

  registerPasses(graph: FrameGraph): void {
    const captureGraph = new FrameGraph();
    let found = false;
    captureGraph.add = pass => {
      if (!pass.name.endsWith(':cover')) return () => {};
      found = true;
      return graph.add({ ...pass, name: 'weather:cover-map', order: -3 });
    };
    this.capture.registerPasses?.(captureGraph);
    if (!found) throw new MargoError('unsupported', 'PrecipitationCover needs a WeatherFX capture with a cover pass');
    graph.add({ name: 'weather:cover-surfaces', order: -0.5, execute: c => {
      if (c.backend !== 'webgpu' || !this.bindings().length) return;
      const code = this.shader(c.shader, 0);
      if (code !== c.shader) { c.shader = code; c.bindings.push(...this.bindings()); }
    } });
  }

  /** Cover declarations and weather calls in either a core or gltf-pro shader. */
  shader(source: string, group: number): string {
    // Models may compile while preparing the frame, before the map pass allocates
    // its first texture. Shader structure must not depend on resource readiness.
    if (this.disposed) return source;
    const key = group + source;
    const cached = this.cache.get(key);
    if (cached) return cached;
    let code = source.replaceAll('weather_puddle_surface(i.position,', 'weather_cover_water(i.position,')
      .replaceAll('weather_snow_at(i.position.xz,', 'weather_cover_snow(i.position,')
      .replaceAll('weather_snow_depth(p.xz,', 'weather_cover_depth(p.xyz,');
    if (code === source) return source;
    // A map texel holds an occluder only where the occluder covers its centre, so a receiver within half a texel
    // inside a shelter's edge can fall in an empty texel. The highest occluder among the four texels around the
    // receiver shelters every point under an occluder at least one texel wide (and up to one texel past its edge).
    let helpers = `
      struct WeatherCoverFrame {area:vec4f,depth:vec4f}
      @group(${group}) @binding(162) var<uniform> weatherCoverFrame:WeatherCoverFrame;
      @group(${group}) @binding(163) var weatherCoverMap:texture_depth_2d;
      fn weather_exposed(p:vec3f)->bool {
        let f=weatherCoverFrame;let uv=(p.xz-f.area.xy)*f.area.z;
        if(any(uv<vec2f(0))||any(uv>=vec2f(1))){return true;}
        let n=i32(f.depth.y)-1;let b=vec2i(floor(uv*f.depth.y-0.5));var d=1.0;
        for(var k=0;k<4;k++){d=min(d,textureLoad(weatherCoverMap,clamp(b+vec2i(k&1,k/2),vec2i(0),vec2i(n)),0));}
        return d>=1.0||p.y+${this.bias.toExponential() }>=f.area.w-d*f.depth.x;
      }`;
    if (code.includes('weather_cover_water(')) helpers += `
      fn weather_cover_water(p:vec3f,n:vec3f,c:vec3f,r:f32,m:f32,wet:bool,u:WeatherPuddles)->mat3x4f {
        var v=u;if(!weather_exposed(p)){v.a.x=0.0;v.a.y=0.0;}
        return weather_puddle_surface(p,n,c,r,m,wet,v);
      }`;
    if (code.includes('weather_cover_snow(')) helpers += `
      fn weather_cover_snow(p:vec3f,ny:f32,c:f32)->f32 {return weather_snow_at(p.xz,ny,select(0.0,c,weather_exposed(p)));}`;
    if (code.includes('weather_cover_depth(')) helpers += `
      fn weather_cover_depth(p:vec3f,ny:f32,u:WeatherSnow)->f32 {var v=u;if(!weather_exposed(p)){v.a.x=0.0;}return weather_snow_depth(p.xz,ny,v);}`;
    code = helpers + code;
    if (this.cache.size >= 32) this.cache.clear();
    this.cache.set(key, code);
    return code;
  }

  /** Map bindings in the same group as the weather effect. */
  bindings(): GPUBindGroupEntry[] {
    const map = this.capture.options.weather.occlusion;
    return !this.disposed && map?.buffer && map.view ? [
      { binding: 162, resource: { buffer: map.buffer } }, { binding: 163, resource: map.view },
    ] : [];
  }

  onDeviceRestored(engine: Engine): void {
    this.capture.onDeviceRestored?.(engine);
    this.cache.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.capture.dispose?.();
    this.cache.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void { this.dispose(); }
}
