/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { Puddles, puddleWGSL, type PuddleOptions } from './puddles.js';
import { Snow, snowWGSL, type SnowOptions } from './snow.js';
import { noiseWGSL } from './scene-patch.js';

/** Imported model accepting gltf-pro's composable lighting/shading effects. */
export interface WeatherGLTFModel {
  addLighting(effect: GLTFWeather): () => void;
}

/** Wet ground and snow settings; both default to their core-mesh entry's defaults. */
export interface GLTFWeatherOptions {
  /** Wetness, standing water and rain rings. Default {}. */
  puddles?: PuddleOptions;
  /** Slope-dependent snow, grain and depth. Default {}. */
  snow?: SnowOptions;
}

class PuddleValues extends Puddles {
  packed(): Float32Array { this.write(); return this.values; }
}
class SnowValues extends Snow {
  packed(): Float32Array { this.write(); return this.values; }
}

/**
 * Weather on imported PBR models, after their texture sampling and before lighting.
 * Uses the same WGSL and options as Puddles and Snow. Authored alpha, emission,
 * texture coordinates and material extensions remain intact. WebGPU only.
 * @throws MargoError for unsupported backends, mismatched shaders or disposed use.
 */
export class GLTFWeather implements EnginePlugin {
  readonly name = 'weather-gltf';
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private readonly values = new Float32Array(20);
  private readonly removers = new Map<WeatherGLTFModel, () => void>();
  private readonly puddles: PuddleValues;
  private readonly snow: SnowValues;
  private disposed = false;

  constructor(readonly options: GLTFWeatherOptions = {}) {
    this.puddles = new PuddleValues(options.puddles ?? (options.puddles = {}));
    this.snow = new SnowValues(options.snow ?? (options.snow = {}));
  }

  /** Attaches one effect; call add(model) for each imported model to weather. */
  static attach(engine: EngineKernel, options: GLTFWeatherOptions = {}): GLTFWeather {
    const effect = new GLTFWeather(options);
    engineRuntime(engine).use(effect);
    return effect;
  }

  /** Engine owning the shader resources, checked by PBRModel.addLighting. */
  get owner(): Engine | undefined { return this.engine; }

  private alive(): void {
    if (this.disposed) throw new MargoError('disposed', 'GLTFWeather is disposed; attach a new effect');
  }

  /** Adds a model once. The returned function removes its weather without disposing the model. */
  add(model: WeatherGLTFModel): () => void {
    this.alive();
    if (!this.engine) throw new MargoError('state', 'Attach GLTFWeather before adding models');
    if (this.removers.has(model)) return this.removers.get(model)!;
    const remove = model.addLighting(this);
    const detach = () => { remove(); this.removers.delete(model); };
    this.removers.set(model, detach);
    return detach;
  }

  setup(engine: Engine): void {
    this.alive();
    if (!engine.gpu) throw new MargoError('unsupported', 'GLTFWeather requires WebGPU; select a WebGPU engine');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 80, usage: 64 | 8 });
    this.onPreUpdate(0);
  }

  onPreUpdate(delta: number): void {
    this.alive();
    this.puddles.onPreUpdate(delta);
    this.snow.onPreUpdate(delta);
    this.values.set(this.puddles.packed());
    this.values.set(this.snow.packed(), 8);
    if (this.uniform) this.engine!.gpu!.queue.writeBuffer(this.uniform, 0, this.values);
  }

  /** gltf-pro shading hook. Shared noise appears only once in the shader. */
  shader(source: string, group: number): string {
    this.alive();
    const start = source.indexOf('fn surface(i:Out,front:bool)->Surface {');
    const end = source.indexOf('return s;', start);
    if (start < 0 || end < 0) throw new MargoError('unsupported', 'GLTFWeather needs the standard gltf-pro surface shader');
    const wet = this.options.puddles?.wetSurfaces ?? true;
    const edit = `{
      let weatherWater=weather_puddle_surface(i.position,s.n,s.base.rgb,s.roughness,s.metal,${wet},weatherPuddles);
      s.base=vec4f(weatherWater[0].xyz,s.base.a);s.roughness=weatherWater[0].w;s.metal=weatherWater[1].x;s.n=weatherWater[2].xyz;
      let weatherCover=weather_snow_at(i.position.xz,normalize(i.normal).y,weatherSnow.a.x);
      if(weatherCover>0.0){s.base=vec4f(mix(s.base.rgb,weatherSnow.b.xyz,weatherCover),s.base.a);
      s.roughness=mix(s.roughness,weatherSnow.b.w,weatherCover);s.metal*=1.0-weatherCover;
      s.n=weather_snow_normal(i.position.xz,s.n,weatherCover,weatherSnow);}
    }`;
    let code = source.slice(0, end) + edit + source.slice(end);
    // The world-space lift runs after skinning/morphing and before camera projection.
    code = code.replace('o.clip=f.camera*p; o.position=p.xyz;',
      'var weatherPosition=p;weatherPosition.y+=weather_snow_depth(p.xz,normalize((f.normalMatrix*vec4f(i.normal.xyz,0)).xyz).y,weatherSnow);o.clip=f.camera*weatherPosition;o.position=weatherPosition.xyz;');
    return `${source.includes('fn weather_noise(') ? '' : noiseWGSL}
      ${puddleWGSL.slice(noiseWGSL.length)}${snowWGSL.slice(noiseWGSL.length)}
      struct WeatherGLTFUniform { puddles:WeatherPuddles, snow:WeatherSnow }
      @group(${group}) @binding(160) var<uniform> weatherGLTF:WeatherGLTFUniform;
      ${code.replaceAll('weatherPuddles', 'weatherGLTF.puddles').replaceAll('weatherSnow', 'weatherGLTF.snow')}`;
  }

  /** Current uniform resource for gltf-pro's group 2. */
  bindings(): GPUBindGroupEntry[] {
    this.alive();
    return this.uniform ? [{ binding: 160, resource: { buffer: this.uniform } }] : [];
  }

  onDeviceRestored(engine: Engine): void {
    this.uniform?.destroy();
    this.setup(engine);
  }

  dispose(): void {
    if (this.disposed) return;
    for (const remove of this.removers.values()) remove();
    this.uniform?.destroy();
    this.uniform = undefined;
    this.puddles.dispose();
    this.snow.dispose();
    this.engine?.removePlugin(this.name);
    this.disposed = true;
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void { this.dispose(); }
}
