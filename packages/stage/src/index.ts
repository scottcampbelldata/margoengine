import {
  Engine,
  Geometry,
  PbrMaterial,
  box,
  type EngineKernel,
  type EngineOptions,
  type EnginePlugin,
  type Mesh,
  type Scene,
  type Vec3,
} from '@margoengine/core';
import { CADCameraControls } from './controls.js';
import { worldBounds } from './model.js';
import { rangeError, typeError } from '../../shared/errors.js';

export * from '@margoengine/core';
export { CADCameraControls } from './controls.js';
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
  /** Scene to put the mesh in (`engine.createScene()`). Default the engine's default scene. */
  scene?: Scene;
};
/**
 * UV sphere geometry centered on the origin, `segments` around and half as many rings (rounded up).
 * @throws RangeError when `radius` is not positive and finite or `segments` is not an integer 3..256.
 */
export function sphere(radius = 1, segments = 32): Geometry {
  if (typeof radius !== 'number' || !Number.isFinite(Math.fround(radius)) || Math.fround(radius) <= 0)
    throw rangeError('Sphere radius', 'geometry');
  if (!Number.isInteger(segments) || segments < 3 || segments > 256)
    throw rangeError('Sphere segments: 3..256', 'geometry');
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
 * Small facade over an engine for quick scenes: meshes with PBR materials and camera fitting. Create one with
 * `createStage`. Optional features are separate entries that take the stage, so an app bundles only the ones it
 * imports: `addGLTF` (`@margoengine/stage/gltf`), `addSky` (`/sky`), `addParticles` (`/particles`),
 * `addEffects` (`/effects`), `addEnvironment` (`/environment`) and `addShadows` (`/shadows`).
 */
export class Stage {
  /** Aborts when the stage (its engine) is disposed; pending feature loads reject with AbortError. */
  readonly signal: AbortSignal;

  constructor(readonly engine: EngineKernel) {
    const disposal = new AbortController();
    this.signal = disposal.signal;
    engine.use({ name: 'margoengine-imports', setup() {}, dispose: () => disposal.abort() });
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
      mesh = (options.scene ?? this.engine).createMesh(options.parent);
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
    if (size.length !== 3) throw typeError('Box: 3 values', 'arguments');
    return this.mesh(box(...size), options);
  }

  sphere({ radius = 1, segments = 32, ...options }: MeshOptions & { radius?: number; segments?: number } = {}): Mesh {
    return this.mesh(sphere(radius, segments), options);
  }

  fit(meshes: Iterable<Mesh> = this.engine.scene.meshes.values()): void {
    const b = worldBounds(this.engine, meshes, new Float32Array(6), true);
    this.engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]], {
      aspect: Math.max(1, this.canvas.clientWidth) / Math.max(1, this.canvas.clientHeight),
    });
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
  if (typeof controls !== 'boolean' || typeof autoStart !== 'boolean')
    throw typeError('Invalid stage options', 'arguments');
  if (typeof label !== 'string' || (onError !== undefined && typeof onError !== 'function'))
    throw typeError('Invalid stage options', 'arguments');
  const element = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
  const owner = element?.ownerDocument;
  if (!element || !owner?.defaultView || !(element instanceof owner.defaultView.HTMLElement))
    throw typeError('Expected element', 'arguments');
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
