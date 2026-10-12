import type {EngineKernel, Vec3, VectorRef} from '@margoengine/core';
import type {Engine, EnginePlugin, FrameGraph, Mesh, PassContext} from '@margoengine/core/extension';
import {readResponse} from '../../shared/loading.js';
import {finiteVector} from '../../shared/math.js';
import {PlanetPass, type PlanetImages, type PlanetPassConfig} from './planet-pass.js';

export interface PlanetOptions {
  dayMap: string | URL;
  nightMap?: string | URL;
  /** Linear map: red = ocean specular strength, green = roughness. */
  specularRoughnessMap?: string | URL;
  /** Linear tangent-space RGB normal map; changes shading, not geometry. */
  normalMap?: string | URL;
  /** Linear grayscale cloud coverage. */
  clouds?: string | URL;
  radius?: number;
  /** Axial tilt in degrees. Default: 23.4. Rotation accessors use radians. */
  tilt?: number;
  sunDirection?: Vec3;
  atmosphere?: {color?: Vec3; intensity?: number};
  signal?: AbortSignal;
}

/** One WebGPU planet plugin per engine; created and attached asynchronously. */
export class Planet implements EnginePlugin {
  readonly name = 'planet';
  readonly clouds: {offsetU: number};
  private readonly controller = new AbortController();
  private readonly images: PlanetImages = {day: undefined!};
  private readonly sources: Array<[keyof PlanetImages, string]> = [];
  private readonly sun = new Float32Array(3);
  private readonly config: PlanetPassConfig;
  private readonly tilt: number;
  private engine?: Engine;
  private parent?: Mesh;
  private spin?: Mesh;
  private pass?: PlanetPass;
  private disposed = false;
  private offset = 0;

  private constructor(options: PlanetOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('Expected planet options');
    const radius = options.radius ?? 1, tilt = options.tilt ?? 23.4;
    const intensity = options.atmosphere?.intensity ?? 1.2;
    const color = options.atmosphere?.color ?? [0.3, 0.6, 1];
    for (const value of [radius * 1.01, tilt, intensity]) {
      if (typeof value !== 'number' || !Number.isFinite(Math.fround(value))) throw new RangeError('Planet parameters must be finite Float32 numbers');
    }
    if (typeof radius !== 'number' || Math.fround(radius) <= 0 || intensity < 0) throw new RangeError('Planet radius must be positive and atmosphere intensity non-negative');
    if (options.atmosphere !== undefined && (!options.atmosphere || typeof options.atmosphere !== 'object')) throw new TypeError('Expected atmosphere options');
    finiteVector(color, 3, 'Atmosphere color');
    if (color.some(value => value < 0)) throw new RangeError('Atmosphere color must be non-negative');
    this.config = {radius, atmosphereColor: [color[0], color[1], color[2]], atmosphereIntensity: intensity, nightIntensity: 3};
    this.tilt = tilt * Math.PI / 180;
    this.setSunDirection(options.sunDirection ?? [-1, 0.2, 0.5]);
    const maps = [['day', options.dayMap], ['night', options.nightMap], ['specular', options.specularRoughnessMap], ['normal', options.normalMap], ['clouds', options.clouds]] as const;
    for (const [name, source] of maps) {
      if (source === undefined && name !== 'day') continue;
      if (!(typeof source === 'string' && source.trim() || source instanceof URL)) throw new TypeError(`Expected ${name} map URL`);
      this.sources.push([name, String(source)]);
    }
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError('Expected AbortSignal');
    const planet = this;
    this.clouds = {
      get offsetU() {planet.check(); return planet.offset;},
      set offsetU(value: number) {
        planet.check();
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('Cloud offset must be finite');
        planet.offset = ((value % 1) + 1) % 1;
      },
    };
  }

  static async create(engine: EngineKernel, options: PlanetOptions): Promise<Planet> {
    const planet = new Planet(options);
    const signal = options.signal ? AbortSignal.any([options.signal, planet.controller.signal]) : planet.controller.signal;
    try {
      signal.throwIfAborted();
      engine.use(planet);
      await planet.load(signal);
      return planet;
    } catch (error) {
      planet.dispose();
      throw error;
    }
  }

  get rotation(): VectorRef {this.check(); if (!this.spin) throw new Error('Planet is not attached'); return this.spin.rotation;}

  setSunDirection(direction: Vec3): void {
    this.check(); finiteVector(direction, 3, 'Sun direction');
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (!length) throw new RangeError('Sun direction must be nonzero');
    for (let axis = 0; axis < 3; axis++) this.sun[axis] = direction[axis] / length;
  }

  private check(): void {if (this.disposed) throw new Error('Planet is disposed');}

  setup(engine: Engine): void {
    this.check();
    if (this.engine) throw new Error('Planet is already attached');
    if (!engine.gpu) throw new Error('Planet requires WebGPU');
    this.engine = engine;
    this.parent = engine.createMesh();
    this.parent.rotation.z = this.tilt;
    this.spin = engine.createMesh(this.parent);
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({name: 'planet:surface', order: 3, execute: this.surface});
    graph.add({name: 'planet:shell', order: 4, execute: this.shell});
  }

  private async load(signal: AbortSignal): Promise<void> {
    let decodedBytes = 0;
    for (const [name, url] of this.sources) {
      signal.throwIfAborted();
      const response = await fetch(url, {signal});
      const bytes = await readResponse(response, {maxBytes: 32 * 1024 * 1024, signal, label: `Planet ${name} map`});
      const image = await createImageBitmap(new Blob([bytes]), {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
      try {
        signal.throwIfAborted(); this.check();
        const limit = this.engine!.gpu!.limits.maxTextureDimension2D;
        decodedBytes += image.width * image.height * 4;
        if (image.width < 1 || image.height < 1 || image.width > limit || image.height > limit || decodedBytes > 256 * 1024 * 1024) throw new RangeError('Planet maps exceed GPU dimensions or 256 MiB decoded budget');
        this.images[name] = image;
      } catch (error) {image.close(); throw error;}
    }
    signal.throwIfAborted(); this.check();
    const device = this.engine!.gpu!;
    device.pushErrorScope('validation');
    let pass: PlanetPass;
    try {pass = this.createPass();}
    catch (error) {await device.popErrorScope().catch(() => null); throw error;}
    try {
      const error = await device.popErrorScope();
      signal.throwIfAborted(); this.check();
      if (error) throw new Error(`Planet GPU initialization failed: ${error.message}`);
      if (this.engine!.gpu === device) this.pass = pass;
      else if (!this.pass) this.pass = this.createPass();
    } finally {if (this.pass !== pass) pass.dispose();}
  }

  private createPass(): PlanetPass {
    const device = this.engine!.gpu!;
    return new PlanetPass(device, this.images, navigator.gpu.getPreferredCanvasFormat(), device.features.has('depth32float-stencil8') ? 'depth32float-stencil8' : 'depth32float', this.config);
  }

  private readonly surface = (context: PassContext): void => {
    if (!this.pass || context.backend !== 'webgpu') return;
    this.pass.updateFrame(context.camera.matrix, this.spin!.matrix, context.camera.position, this.sun, this.offset);
    this.pass.record(context, false);
  };

  private readonly shell = (context: PassContext): void => {
    if (this.pass && context.backend === 'webgpu') this.pass.record(context, true);
  };

  onDeviceRestored(engine: Engine): void {
    this.check();
    if (engine !== this.engine) throw new Error('Planet belongs to another engine');
    this.pass?.dispose(); this.pass = undefined;
    if (this.sources.every(([name]) => !!this.images[name])) this.pass = this.createPass();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort(new DOMException('Planet disposed', 'AbortError'));
    const engine = this.engine;
    if (engine?.hasPlugin(this.name)) engine.removePlugin(this.name);
    this.pass?.dispose(); this.pass = undefined;
    for (const [name] of this.sources) {this.images[name]?.close(); delete this.images[name];}
    this.spin?.dispose(); this.parent?.dispose();
    this.spin = this.parent = undefined;
    this.engine = undefined;
  }
}
