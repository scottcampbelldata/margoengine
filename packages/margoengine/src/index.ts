import {
  Engine,
  CADCameraControls,
  Geometry,
  PbrMaterial,
  box,
  type EngineKernel,
  type EngineOptions,
  type EnginePlugin,
  type Mesh,
  type Vec3,
} from '@margoengine/core';
import type { Engine as RuntimeEngine } from '@margoengine/core/extension';
import { loadedModel, worldBounds, type LoadedModel, type StageModel } from './model.js';

export * from '@margoengine/core';
export type { LoadedModel } from './model.js';
/** Options for `createStage`: engine options plus the stage's own. */
export interface StageOptions extends EngineOptions {
  /** Attach CAD camera controls to the canvas. Default true. */
  controls?: boolean;
  /** Start the frame loop right away. Default true. */
  autoStart?: boolean;
  /** Accessible label of a canvas the stage creates. Default 'Interactive 3D scene'. */
  label?: string;
  /** Receives engine errors (set as `engine.onError`). */
  onError?: (error: unknown) => void;
}
/** Options for `Stage.mesh`, `box` and `sphere`: `PbrMaterial` options plus placement. */
export type MeshOptions = NonNullable<ConstructorParameters<typeof PbrMaterial>[0]> & {
  /** Parent mesh. Default none (a root mesh). */
  parent?: Mesh;
  /** Local position in world units. */
  position?: Vec3;
  /** Local rotation, passed to `mesh.setRotation`. */
  rotation?: Vec3;
  /** Local scale per axis. */
  scale?: Vec3;
  /** Default ''. */
  name?: string;
};
/** Options for `Stage.load`. Format and framing belong to the stage; the rest are forwarded to a CAD import. */
export interface LoadOptions {
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
  smoothing?: boolean;
  /** Most parts (OBJ objects and groups, STEP/IGES meshes) the file may have, each one a core mesh (default 100,000; up to core's 8,388,608 entities). */
  maxParts?: number;
  /**
   * The worker is terminated and the import rejects after this many milliseconds (default 120,000). OpenCascade can
   * spend minutes tessellating a malformed STEP or IGES file; a worker that never answers is never waited on.
   */
  timeoutMs?: number;
  /** File format; default from the URL extension ('stp' is STEP, 'igs' IGES). An unknown format rejects with a TypeError. */
  format?: 'gltf' | 'glb' | 'stl' | 'obj' | 'step' | 'iges';
  /** Fit the camera to the loaded model. Default true. */
  fit?: boolean;
}

/** Rewrites a missing optional package into `Install <name>`. Every other failure, including AbortError, is rethrown. */
function missingInstall(error: unknown, name: string): never {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
  const message = error instanceof Error ? error.message : '';
  if (
    code === 'ERR_MODULE_NOT_FOUND' ||
    /Cannot find (module|package)|Failed to resolve|dynamically imported module/i.test(message)
  )
    throw new Error(`Install ${name}`);
  throw error instanceof Error ? error : new Error(message);
}

function loadPackage<T>(name: string, load: () => Promise<T>): Promise<T> {
  return load().catch((error: unknown) => missingInstall(error, name));
}

/**
 * UV sphere geometry centered on the origin, `segments` around and half as many rings (rounded up).
 * @throws RangeError when `radius` is not positive and finite or `segments` is not an integer 3..256.
 */
export function sphere(radius = 1, segments = 32): Geometry {
  if (typeof radius !== 'number' || !Number.isFinite(Math.fround(radius)) || Math.fround(radius) <= 0)
    throw new RangeError('Sphere radius');
  if (!Number.isInteger(segments) || segments < 3 || segments > 256) throw new RangeError('Sphere segments');
  const rings = Math.ceil(segments / 2),
    positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [];
  for (let ring = 0; ring <= rings; ring++) {
    const latitude = (ring * Math.PI) / rings,
      height = Math.cos(latitude),
      extent = Math.sin(latitude);
    for (let segment = 0; segment <= segments; segment++) {
      const longitude = (segment * Math.PI * 2) / segments;
      const x = extent * Math.cos(longitude),
        z = extent * Math.sin(longitude);
      positions.push(x * radius, height * radius, z * radius);
      normals.push(x, height, z);
      if (ring < rings && segment < segments) {
        const a = ring * (segments + 1) + segment,
          b = a + segments + 1;
        if (ring > 0) indices.push(a, a + 1, b);
        if (ring < rings - 1) indices.push(a + 1, b + 1, b);
      }
    }
  }
  return new Geometry(positions, normals, indices);
}

/**
 * Small facade over an engine for quick scenes: meshes with PBR materials, model loading with camera
 * fitting, and lazy access to the optional packages. Create one with `createStage`.
 * A missing optional peer rejects with `Install @margoengine/<name>`: gltf, machinery, creative (particles and
 * effects), scenery (sky), environment, or shadows.
 */
export class Stage {
  private readonly imports = new AbortController();

  constructor(readonly engine: EngineKernel) {
    engine.use({ name: 'margoengine-imports', setup() {}, dispose: () => this.imports.abort() });
  }

  get canvas(): HTMLCanvasElement {
    return this.engine.canvas;
  }
  onTick(callback: (delta: number) => void): () => void {
    return this.engine.onFrame((_, delta) => callback(delta));
  }
  use<T extends EnginePlugin>(plugin: T): T {
    this.engine.use(plugin);
    return plugin;
  }
  dispose(): void {
    this.engine.dispose();
  }

  mesh(geometry: Geometry, options: MeshOptions = {}): Mesh {
    const material = new PbrMaterial(options),
      mesh = this.engine.createMesh(options.parent);
    try {
      mesh.setGeometry(geometry).setMaterial(material);
      if (options.position) mesh.setPosition(options.position);
      if (options.rotation) mesh.setRotation(options.rotation);
      if (options.scale) mesh.setScale(options.scale);
      mesh.name = options.name ?? '';
      return mesh;
    } catch (error) {
      mesh.dispose();
      throw error;
    }
  }

  box({ size = [1, 1, 1], ...options }: MeshOptions & { size?: Vec3 } = {}): Mesh {
    if (size.length !== 3) throw new TypeError('Box: 3 values');
    return this.mesh(box(...size), options);
  }

  sphere({ radius = 1, segments = 32, ...options }: MeshOptions & { radius?: number; segments?: number } = {}): Mesh {
    return this.mesh(sphere(radius, segments), options);
  }

  fit(meshes: Iterable<Mesh> = (this.engine as unknown as RuntimeEngine).meshes.values()): void {
    const b = worldBounds(this.engine, meshes, new Float32Array(6), true);
    this.engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]], {
      aspect: Math.max(1, this.canvas.clientWidth) / Math.max(1, this.canvas.clientHeight),
    });
  }

  async load(url: string | URL, { format, fit = true, signal, ...options }: LoadOptions = {}): Promise<LoadedModel> {
    if (typeof fit !== 'boolean') throw new TypeError('Invalid fit');
    const target = new URL(url, globalThis.location?.href),
      extension = target.pathname.toLowerCase().split('.').at(-1);
    const kind = format ?? (extension === 'stp' ? 'step' : extension === 'igs' ? 'iges' : extension);
    if (!['gltf', 'glb', 'stl', 'obj', 'step', 'iges'].includes(kind ?? '')) throw new TypeError('Specify format');
    const abort = signal ? AbortSignal.any([signal, this.imports.signal]) : this.imports.signal;
    abort.throwIfAborted();
    const model =
      kind === 'gltf' || kind === 'glb'
        ? await (
            (await this.gltf()) as {
              loadGLTF(engine: EngineKernel, url: URL, options: { signal?: AbortSignal }): Promise<StageModel>;
            }
          ).loadGLTF(this.engine, target, { signal: abort })
        : await (
            await loadPackage('@margoengine/machinery', () => import('@margoengine/machinery/cad'))
          ).loadCAD(this.engine, target, {
            ...options,
            format: kind as 'stl' | 'obj' | 'step' | 'iges',
            signal: abort,
          });
    try {
      abort.throwIfAborted();
      if (fit) this.fit(model.meshes);
      return loadedModel(this.engine, model);
    } catch (error) {
      model.dispose();
      throw error;
    }
  }

  gltf(): Promise<object> {
    return loadPackage('@margoengine/gltf', () => import('@margoengine/gltf'));
  }
  machinery(): Promise<object> {
    return loadPackage('@margoengine/machinery', () => import('@margoengine/machinery'));
  }
  creative(): Promise<object> {
    return loadPackage('@margoengine/creative', () => import('@margoengine/creative'));
  }
  scenery(): Promise<object> {
    return loadPackage('@margoengine/scenery', () => import('@margoengine/scenery'));
  }

  async sky(options: object = {}): Promise<object> {
    const { SkyMoon } = await loadPackage('@margoengine/scenery', () => import('@margoengine/scenery/sky'));
    this.imports.signal.throwIfAborted();
    return this.use(new SkyMoon(options as never));
  }
  async particles(options: object = {}): Promise<object> {
    const { GPUParticles } = await loadPackage('@margoengine/creative', () => import('@margoengine/creative/particles'));
    this.imports.signal.throwIfAborted();
    return this.use(new GPUParticles(options as never));
  }
  async effects(options: object = {}): Promise<object> {
    const { PostProcessing } = await loadPackage('@margoengine/creative', () => import('@margoengine/creative/post'));
    this.imports.signal.throwIfAborted();
    return this.use(new PostProcessing(options as never));
  }
  /**
   * Loads `@margoengine/environment` and lights every mesh with image-based lighting from an `.hdr`, `.exr` or
   * UltraHDR `.jpg` URL (or a decoded source). Rejects with `AbortError`, attaching nothing, if the stage is disposed first.
   * A missing package rejects with `Install @margoengine/environment`.
   */
  async environment(source: string | URL | object, options?: object): Promise<object> {
    const { EnvironmentLighting } = await loadPackage('@margoengine/environment', () => import('@margoengine/environment'));
    return EnvironmentLighting.load(this.engine, source as never, options as never);
  }
  /**
   * Loads `@margoengine/shadows` and attaches cascaded shadows for the stage's directional light. Meshes present now
   * cast; add later ones with `shadows.add(mesh)`. Rejects with `AbortError` if the stage is disposed first.
   * A missing package rejects with `Install @margoengine/shadows`.
   */
  async shadows(options: object = {}): Promise<object> {
    const { Shadows } = await loadPackage('@margoengine/shadows', () => import('@margoengine/shadows'));
    this.imports.signal.throwIfAborted();
    const shadows = this.use(new Shadows(options as never));
    for (const mesh of (this.engine as unknown as RuntimeEngine).meshes.values()) shadows.add(mesh);
    return shadows;
  }
}

/**
 * Creates an engine on `target` (a CSS selector or element) and wraps it in a `Stage`. A canvas target is
 * used directly; any other element gets a new full-size canvas appended, removed again on dispose.
 * Rejects with a TypeError for invalid options or when the target is not an element.
 */
export async function createStage(
  target: string | HTMLElement,
  { controls = true, autoStart = true, label = 'Interactive 3D scene', onError, ...options }: StageOptions = {},
): Promise<Stage> {
  if (typeof controls !== 'boolean' || typeof autoStart !== 'boolean') throw new TypeError('Invalid stage options');
  if (typeof label !== 'string' || (onError !== undefined && typeof onError !== 'function'))
    throw new TypeError('Invalid stage options');
  const element = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
  const owner = element?.ownerDocument;
  if (!element || !owner?.defaultView || !(element instanceof owner.defaultView.HTMLElement))
    throw new TypeError('Expected element');
  const owned = element.tagName !== 'CANVAS',
    canvas = owned ? owner.createElement('canvas') : (element as HTMLCanvasElement);
  let engine: EngineKernel | undefined;
  try {
    if (owned) {
      canvas.style.cssText = 'display:block;width:100%;height:100%;min-height:150px';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', label);
      element.appendChild(canvas);
    }
    engine = await Engine.create(canvas, options);
    if (onError) engine.onError = onError;
    const app = new Stage(engine);
    engine.use({
      name: 'margoengine-mount',
      setup() {},
      dispose() {
        if (owned) canvas.remove();
      },
    });
    if (controls) {
      let navigation: CADCameraControls;
      engine.use({
        name: 'margoengine-controls',
        setup(instance) {
          navigation = new CADCameraControls(instance.camera, canvas);
        },
        onPreUpdate(delta) {
          navigation.update(delta);
        },
        dispose() {
          navigation?.dispose();
        },
      });
    }
    engine.render();
    if (autoStart) engine.start();
    return app;
  } catch (error) {
    try {
      engine?.dispose();
    } catch {}
    if (owned) canvas.remove();
    throw error;
  }
}
