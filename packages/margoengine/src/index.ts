import {Engine, CADCameraControls, Geometry, PbrMaterial, box, type EngineKernel, type EngineOptions, type EnginePlugin, type Mesh, type Vec3} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import type {CADFormat, CADImportOptions} from '@margoengine/machinery';
import type {ParticleOptions, PostOptions} from '@margoengine/creative';
import type {SkyMoonConfig} from '@margoengine/scenery';
import {loadedModel, worldBounds, type LoadedModel} from './model.js';

export * from '@margoengine/core';
export type {LoadedModel} from './model.js';
export interface StageOptions extends EngineOptions {
  controls?: boolean;
  autoStart?: boolean;
  label?: string;
  onError?: (error: unknown) => void;
}
export type MeshOptions = NonNullable<ConstructorParameters<typeof PbrMaterial>[0]> & {
  parent?: Mesh;
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  name?: string;
};
export interface LoadOptions extends CADImportOptions {format?: 'gltf' | 'glb' | CADFormat; fit?: boolean}

export function sphere(radius = 1, segments = 32): Geometry {
  if (typeof radius !== 'number' || !Number.isFinite(Math.fround(radius)) || Math.fround(radius) <= 0) throw new RangeError('Sphere radius');
  if (!Number.isInteger(segments) || segments < 3 || segments > 256) throw new RangeError('Sphere segments');
  const rings = Math.ceil(segments / 2), positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (let ring = 0; ring <= rings; ring++) {
    const latitude = ring * Math.PI / rings;
    for (let segment = 0; segment <= segments; segment++) {
      const longitude = segment * Math.PI * 2 / segments;
      const normal = [Math.sin(latitude) * Math.cos(longitude), Math.cos(latitude), Math.sin(latitude) * Math.sin(longitude)];
      positions.push(...normal.map(value => value * radius)); normals.push(...normal);
      if (ring < rings && segment < segments) {
        const a = ring * (segments + 1) + segment, b = a + segments + 1;
        if (ring > 0) indices.push(a, a + 1, b);
        if (ring < rings - 1) indices.push(a + 1, b + 1, b);
      }
    }
  }
  return new Geometry(positions, normals, indices);
}

export class Stage {
  private readonly imports = new AbortController();

  constructor(readonly engine: EngineKernel) {
    engine.use({name: 'margoengine-imports', setup() {}, dispose: () => this.imports.abort()});
  }

  get canvas(): HTMLCanvasElement {return this.engine.canvas;}
  onTick(callback: (delta: number) => void): () => void {return this.engine.onFrame((_, delta) => callback(delta));}
  use<T extends EnginePlugin>(plugin: T): T {this.engine.use(plugin); return plugin;}
  dispose(): void {this.engine.dispose();}

  mesh(geometry: Geometry, options: MeshOptions = {}): Mesh {
    const material = new PbrMaterial(options), mesh = this.engine.createMesh(options.parent);
    try {
      mesh.setGeometry(geometry).setMaterial(material);
      if (options.position) mesh.setPosition(options.position);
      if (options.rotation) mesh.setRotation(options.rotation);
      if (options.scale) mesh.setScale(options.scale);
      mesh.name = options.name ?? '';
      return mesh;
    } catch (error) {mesh.dispose(); throw error;}
  }

  box({size = [1, 1, 1], ...options}: MeshOptions & {size?: Vec3} = {}): Mesh {
    if (size.length !== 3) throw new TypeError('Box: 3 values');
    return this.mesh(box(...size), options);
  }

  sphere({radius = 1, segments = 32, ...options}: MeshOptions & {radius?: number; segments?: number} = {}): Mesh {
    return this.mesh(sphere(radius, segments), options);
  }

  fit(meshes: Iterable<Mesh> = engineRuntime(this.engine).meshes.values()): void {
    const b = worldBounds(this.engine, meshes, new Float32Array(6), true);
    this.engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]], {aspect: Math.max(1, this.canvas.clientWidth) / Math.max(1, this.canvas.clientHeight)});
  }

  async load(url: string | URL, {format, fit = true, signal, ...options}: LoadOptions = {}): Promise<LoadedModel> {
    if (typeof fit !== 'boolean') throw new TypeError('Invalid fit');
    const target = new URL(url, globalThis.location?.href), extension = target.pathname.toLowerCase().split('.').at(-1);
    const kind = format ?? (extension === 'stp' ? 'step' : extension === 'igs' ? 'iges' : extension);
    if (!['gltf', 'glb', 'stl', 'obj', 'step', 'iges'].includes(kind ?? '')) throw new TypeError('Specify format');
    const abort = signal ? AbortSignal.any([signal, this.imports.signal]) : this.imports.signal;
    abort.throwIfAborted();
    const model = kind === 'gltf' || kind === 'glb'
      ? await (await this.gltf()).loadGLTF(this.engine, target, {signal: abort})
      : await (await this.machinery()).loadCAD(this.engine, target, {...options, format: kind as CADFormat, signal: abort});
    try {abort.throwIfAborted(); if (fit) this.fit(model.meshes); return loadedModel(this.engine, model);}
    catch (error) {model.dispose(); throw error;}
  }

  gltf(): Promise<typeof import('@margoengine/gltf')> {return import('@margoengine/gltf');}
  machinery(): Promise<typeof import('@margoengine/machinery')> {return import('@margoengine/machinery');}
  creative(): Promise<typeof import('@margoengine/creative')> {return import('@margoengine/creative');}
  scenery(): Promise<typeof import('@margoengine/scenery')> {return import('@margoengine/scenery');}

  async sky(options: SkyMoonConfig = {}) {return this.use(new (await this.scenery()).SkyMoon(options));}
  async particles(options: ParticleOptions = {}) {return this.use(new (await this.creative()).GPUParticles(options));}
  async effects(options: PostOptions = {}) {return this.use(new (await this.creative()).PostProcessing(options));}
}

export async function createStage(target: string | HTMLElement, {controls = true, autoStart = true, label = 'Interactive 3D scene', onError, ...options}: StageOptions = {}): Promise<Stage> {
  if (typeof controls !== 'boolean' || typeof autoStart !== 'boolean') throw new TypeError('Invalid controls');
  if (typeof label !== 'string' || onError !== undefined && typeof onError !== 'function') throw new TypeError('Invalid label/onError');
  const element = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
  if (!element || !element.ownerDocument?.defaultView || !(element instanceof element.ownerDocument.defaultView.HTMLElement)) throw new TypeError('Expected HTMLElement');
  const owned = element.tagName !== 'CANVAS', canvas = owned ? element.ownerDocument.createElement('canvas') : element as HTMLCanvasElement;
  let engine: EngineKernel | undefined;
  try {
    if (owned) {
      canvas.style.cssText = 'display:block;width:100%;height:100%;min-height:150px';
      canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', label); element.appendChild(canvas);
    }
    engine = await Engine.create(canvas, options);
    if (onError) engine.onError = onError;
    const app = new Stage(engine);
    engine.use({name: 'margoengine-mount', setup() {}, dispose() {if (owned) canvas.remove();}});
    if (controls) {
      let navigation: CADCameraControls;
      engine.use({name: 'margoengine-controls', setup(instance) {navigation = new CADCameraControls(instance.camera, canvas);}, onPreUpdate(delta) {navigation.update(delta);}, dispose() {navigation?.dispose();}});
    }
    engine.render();
    if (autoStart) engine.start();
    return app;
  } catch (error) {try {engine?.dispose();} catch {} if (owned) canvas.remove(); throw error;}
}
