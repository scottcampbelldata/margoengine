/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { Puddles, puddleWGSL, type PuddleOptions } from './puddles.js';
import { Snow, snowWGSL, type SnowOptions } from './snow.js';
import { noiseWGSL } from './scene-patch.js';
import { PBR_PROJECTION, pbrLift, puddleSurfaceCode, snowSurfaceCode } from './surface-code.js';
import type { PrecipitationCover } from './cover.js';
import { serveGLTF } from './gltf-served.js';

/** Imported model accepting gltf/pbr's composable lighting/shading effects. */
export interface WeatherGLTFModel {
  addLighting(effect: GLTFWeather): () => void;
}

/** Wet ground and snow settings; both default to their core-mesh entry's defaults. */
export interface GLTFWeatherOptions {
  /**
   * The effect's plugin name, fixed for its life; each effect in one scene needs its own. `GLTFWeather.attach` without
   * one takes the first free of `weather-gltf`, `weather-gltf-2`, `weather-gltf-3`, ... in the engine's scene, so a world
   * built again names its effects as the first build did (a seek, a second shot). Default `'weather-gltf'`.
   */
  name?: string;
  /** Optional shared precipitation cover. Default none. */
  cover?: Pick<PrecipitationCover, 'shader' | 'bindings'>;
  /** Wetness, standing water and rain rings. Default {}. */
  puddles?: PuddleOptions;
  /** Slope-dependent snow, grain and depth. Default {}. */
  snow?: SnowOptions;
}

class PuddleValues extends Puddles {
  packed(): Float32Array {
    this.write();
    return this.values;
  }
}
class SnowValues extends Snow {
  packed(): Float32Array {
    this.write();
    return this.values;
  }
}

/**
 * Weather on imported PBR models, after their texture sampling and before lighting.
 * Uses the same WGSL and options as Puddles and Snow. A scene may hold several, each with its own settings and models:
 * give props whose tops cannot hold standing water an effect with `puddles.coverage: 0`, so they only darken and
 * gloss while the ground pools. Authored alpha, emission,
 * texture coordinates and material extensions remain intact. WebGPU only.
 * @throws MargoError for unsupported backends, mismatched shaders or disposed use.
 */
export class GLTFWeather implements EnginePlugin {
  /**
   * Plugin name, the `name` option (`attach` picks the first free `weather-gltf`, `weather-gltf-2`, ... in the scene),
   * so one scene can hold several: ground that pools water beside props whose small tops shed it (KB-WEATHER-GLTFTWO1).
   * Until 2026-11-28 a counter over every effect ever made named them, so a world built again (a seek, a second shot)
   * got other names than the first (KB-WEATHER-GLTFSEEK1).
   */
  readonly name: string;
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private readonly values = new Float32Array(20);
  private readonly removers = new Map<WeatherGLTFModel, () => void>();
  private readonly puddles: PuddleValues;
  private readonly snow: SnowValues;
  private disposed = false;

  constructor(readonly options: GLTFWeatherOptions = {}) {
    const name = options.name ?? 'weather-gltf';
    if (typeof name !== 'string' || name.length === 0)
      throw new TypeError('GLTFWeather name must be a non-empty string');
    this.name = name;
    this.puddles = new PuddleValues(options.puddles ?? (options.puddles = {}));
    this.snow = new SnowValues(options.snow ?? (options.snow = {}));
  }

  /** Attaches one effect; call add(model) for each imported model to weather. */
  static attach(engine: EngineKernel, options: GLTFWeatherOptions = {}): GLTFWeather {
    const runtime = engineRuntime(engine);
    if (options.name === undefined) {
      const taken = (runtime as { plugins?: ReadonlyMap<string, unknown> }).plugins;
      let name = 'weather-gltf';
      for (let i = 2; taken?.has(name); i++) name = `weather-gltf-${i}`;
      options.name = name;
    }
    const effect = new GLTFWeather(options);
    runtime.use(effect);
    return effect;
  }

  /** Engine owning the shader resources, checked by PBRModel.addLighting. */
  get owner(): Engine | undefined {
    return this.engine;
  }

  private alive(): void {
    if (this.disposed) throw new MargoError('disposed', 'GLTFWeather is disposed; attach a new effect');
  }

  /**
   * Adds a model once. The returned function removes its weather without disposing the model. A
   * `@margoengine/materials` mesh may be added too: it then takes its weather from this effect alone, and the scene's
   * `Puddles`, `Snow` and `PrecipitationCover` leave it (give this effect a `cover` to shelter it).
   */
  add(model: WeatherGLTFModel): () => void {
    this.alive();
    if (!this.engine) throw new MargoError('state', 'Attach GLTFWeather before adding models');
    if (this.removers.has(model)) return this.removers.get(model)!;
    const remove = model.addLighting(this);
    // The scene's Puddles, Snow and cover leave this model to this effect (KB-WEATHER-GLTFTWICE1).
    serveGLTF(model, 1);
    const detach = () => {
      remove();
      serveGLTF(model, -1);
      this.removers.delete(model);
    };
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

  /** Seconds on the rain rings' clock (the puddles' `time`). */
  get time(): number {
    return this.puddles.time;
  }

  /**
   * Moves the rain rings' clock by `delta` seconds without drawing; `seek` from `@margoengine/cutscene/seek` replays
   * these steps. Snow has no clock: it follows its weather.
   */
  advanceTime(delta: number): void {
    this.alive();
    this.puddles.advanceTime(delta);
  }

  /**
   * Back to time 0, as a fresh effect with the same options (GAP-FILM-RESET): the rain rings' clock starts again (snow
   * has none); the next frame update writes it to the GPU.
   */
  resetTime(): void {
    this.alive();
    this.puddles.resetTime();
  }

  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
    this.snow.onPreUpdate(delta);
    this.values.set(this.puddles.packed());
    this.values.set(this.snow.packed(), 8);
    if (this.uniform) this.engine!.gpu!.queue.writeBuffer(this.uniform, 0, this.values);
  }

  /** gltf\/pbr shading hook. Shared noise appears only once in the shader. */
  shader(source: string, group: number): string {
    this.alive();
    const start = source.indexOf('fn surface(i:Out,front:bool)->Surface {');
    const end = source.indexOf('return s;', start);
    if (start < 0 || end < 0)
      throw new MargoError('unsupported', 'GLTFWeather needs the standard gltf/pbr surface shader');
    const wet = this.options.puddles?.wetSurfaces ?? true;
    const edit = `{${puddleSurfaceCode(wet)}${snowSurfaceCode('weatherSnow.a.x')}}`;
    let code = source.slice(0, end) + edit + source.slice(end);
    if (code.split(PBR_PROJECTION).length !== 2)
      throw new MargoError('unsupported', 'GLTFWeather snow needs the standard gltf/pbr vertex projection');
    code = code.replace(PBR_PROJECTION, () => pbrLift('weather_snow_depth(p.xz,1.0,weatherSnow)'));
    const weatherShader = `${source.includes('fn weather_noise(') ? '' : noiseWGSL}
      ${puddleWGSL.slice(noiseWGSL.length)}${snowWGSL.slice(noiseWGSL.length)}
      struct WeatherGLTFUniform { puddles:WeatherPuddles, snow:WeatherSnow }
      @group(${group}) @binding(160) var<uniform> weatherGLTF:WeatherGLTFUniform;
      ${code.replaceAll('weatherPuddles', 'weatherGLTF.puddles').replaceAll('weatherSnow', 'weatherGLTF.snow')}`;
    return this.options.cover?.shader(weatherShader, group) ?? weatherShader;
  }

  /** Current uniform resource for gltf\/pbr's group 2. */
  bindings(): GPUBindGroupEntry[] {
    this.alive();
    return this.uniform
      ? [{ binding: 160, resource: { buffer: this.uniform } }, ...(this.options.cover?.bindings() ?? [])]
      : [];
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
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.disposed = true;
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
