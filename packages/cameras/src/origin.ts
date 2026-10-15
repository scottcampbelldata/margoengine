/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  type Camera,
  type Engine,
  type EnginePlugin,
  type Mesh as RuntimeMesh,
  type Vec3,
} from '@margoengine/core/extension';

export interface FloatingOriginOptions {
  /** Rebase when the camera is farther from the origin than `ratio` × its distance to `camera.target`. Default 1000. */
  ratio?: number;
}
/** Called after a rebase with the shift (new origin − old origin) and the new origin, both float64 world coordinates. */
export type RebaseListener = (shift: Vec3, origin: Vec3) => void;

/**
 * Floating origin for scenes kilometres from the world origin (plant layouts, BIM, GIS). Root meshes placed with
 * `place` keep float64 world positions on the CPU; core sees them relative to `origin`, a point near the camera, so
 * core's float32 matrices stay small. The camera, controls, picks, bvh hits and section planes work in those local
 * coordinates; `toWorld`/`toLocal` convert. When the camera drifts past the threshold the origin moves to the camera:
 * roots and camera shift together, so nothing visibly moves (one full transform update of the placed roots).
 */
export class FloatingOrigin implements EnginePlugin {
  readonly name = 'floating-origin';
  ratio = 1000;
  /** Number of rebases so far. */
  rebases = 0;
  private value: Vec3 = [0, 0, 0];
  private engine?: Engine;
  // Per root: float64 world xyz, then the float32 local xyz last written (a moved root is re-read from core).
  private readonly roots = new Map<RuntimeMesh, Float64Array>();
  private readonly listeners = new Set<RebaseListener>();
  /** Same as `engine.use(new FloatingOrigin(options))`; returns the FloatingOrigin. */
  static attach(engine: EngineKernel, options?: FloatingOriginOptions): FloatingOrigin {
    const value = new FloatingOrigin(options);
    engine.use(value);
    return value;
  }
  constructor({ ratio = 1000 }: FloatingOriginOptions = {}) {
    if (!(ratio > 0)) throw new RangeError('Invalid ratio');
    this.ratio = ratio;
  }
  setup(engine: EngineKernel): void {
    this.engine = engineRuntime(engine);
  }
  /** Float64 world position of local [0, 0, 0]. */
  get origin(): Vec3 {
    return [...this.value];
  }
  private get camera(): Camera {
    if (!this.engine) throw new Error('FloatingOrigin not attached');
    return this.engine.camera;
  }
  /** Places a root mesh (or a gltf-pro `model.root`) at a float64 world position and keeps it there across rebases. */
  place(mesh: Mesh, world: ArrayLike<number>): void {
    const m = meshRuntime(mesh);
    m.check();
    if (m.engine !== this.engine) throw new TypeError('Foreign mesh');
    if (m.engine.store.parents[m.id] !== -1) throw new TypeError('place() takes root meshes');
    const p = vector(world, 'Invalid world position'),
      entry = this.roots.get(m) ?? new Float64Array(6);
    entry.set(p);
    this.roots.set(m, entry);
    this.write(m, entry);
  }
  /** Stops tracking a mesh (it keeps its current local position). */
  forget(mesh: Mesh): void {
    this.roots.delete(meshRuntime(mesh));
  }
  /** Float64 world position of a placed root, or undefined. A root moved through `mesh.position` since is re-read. */
  worldPosition(mesh: Mesh): Vec3 | undefined {
    const m = meshRuntime(mesh),
      e = this.roots.get(m);
    if (!e) return;
    this.sync(m, e);
    return [e[0], e[1], e[2]];
  }
  /** Local (core) point → float64 world, e.g. a bvh hit point or a measurement anchor. */
  toWorld(local: ArrayLike<number>): Vec3 {
    const o = this.value;
    return [local[0] + o[0], local[1] + o[1], local[2] + o[2]];
  }
  /** Float64 world point → local (core) coordinates. */
  toLocal(world: ArrayLike<number>): Vec3 {
    const o = this.value;
    return [world[0] - o[0], world[1] - o[1], world[2] - o[2]];
  }
  /** World plane [nx, ny, nz, d] (n·x + d = 0) → local plane, e.g. for `SectionPlanes` options; redo it in `onRebase`. */
  toLocalPlane(plane: ArrayLike<number>): [number, number, number, number] {
    const o = this.value;
    return [plane[0], plane[1], plane[2], plane[3] + plane[0] * o[0] + plane[1] * o[1] + plane[2] * o[2]];
  }
  /** Points the camera in float64 world coordinates (rebasing first when needed). */
  lookAt(position: ArrayLike<number>, target: ArrayLike<number>): void {
    const p = vector(position, 'Invalid camera'),
      t = vector(target, 'Invalid camera'),
      c = this.camera;
    c.cancelFit();
    c.position = this.toLocal(p);
    c.target = this.toLocal(t);
    this.check();
  }
  /** Camera position in float64 world coordinates. */
  get cameraPosition(): Vec3 {
    return this.toWorld(this.camera.position);
  }
  /** Camera target in float64 world coordinates. */
  get cameraTarget(): Vec3 {
    return this.toWorld(this.camera.target);
  }
  /** Calls `listener(shift, origin)` after each rebase (shift app-held local data: saved views, planes); returns an unsubscribe. */
  onRebase(listener: RebaseListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Moves the origin to a float64 world point (default: the camera); the camera and placed roots shift with it. */
  rebase(origin: ArrayLike<number> = this.cameraPosition): void {
    const next = vector(origin, 'Invalid origin'),
      o = this.value,
      shift: Vec3 = [next[0] - o[0], next[1] - o[1], next[2] - o[2]],
      c = this.camera;
    this.value = next;
    const minus = (v: Vec3): Vec3 => [v[0] - shift[0], v[1] - shift[1], v[2] - shift[2]];
    c.position = minus(c.position);
    c.target = minus(c.target);
    // ponytail: finds core Camera's private (name-mangled) fitToBoundingBox animation by its keys; the origin test guards it.
    const fit = Object.values(c).find((v) => v && typeof v === 'object' && 'fromTarget' in v) as
      | Record<'position' | 'target' | 'from' | 'fromTarget', Vec3>
      | undefined;
    if (fit) for (const key of ['position', 'target', 'from', 'fromTarget'] as const) fit[key] = minus(fit[key]);
    for (const [m, e] of this.roots)
      if (m.engine.meshes.get(m.id) !== m) this.roots.delete(m);
      else {
        this.sync(m, e, o);
        this.write(m, e);
      }
    this.rebases++;
    for (const listener of this.listeners) listener(shift, this.origin);
  }
  /** Rebases when the camera is past the threshold; the engine calls it before each update. */
  onPreUpdate(): void {
    if (this.engine) this.check();
  }
  dispose(): void {
    this.engine = undefined;
    this.roots.clear();
    this.listeners.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  private check(): void {
    const c = this.camera,
      p = c.position,
      t = c.target;
    if (Math.hypot(p[0], p[1], p[2]) > this.ratio * Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2])) this.rebase();
  }
  private write(m: RuntimeMesh, e: Float64Array): void {
    const t = m.engine.store.transforms,
      o = this.value;
    t.x[m.id] = e[3] = Math.fround(e[0] - o[0]);
    t.y[m.id] = e[4] = Math.fround(e[1] - o[1]);
    t.z[m.id] = e[5] = Math.fround(e[2] - o[2]);
  }
  private sync(m: RuntimeMesh, e: Float64Array, o = this.value): void {
    const t = m.engine.store.transforms,
      x = t.x[m.id],
      y = t.y[m.id],
      z = t.z[m.id];
    if (x !== e[3] || y !== e[4] || z !== e[5]) {
      e[0] = x + o[0];
      e[1] = y + o[1];
      e[2] = z + o[2];
      e[3] = x;
      e[4] = y;
      e[5] = z;
    }
  }
}

function vector(value: ArrayLike<number>, message: string): Vec3 {
  if (
    !value ||
    value.length !== 3 ||
    ![0, 1, 2].every((i) => typeof value[i] === 'number' && Number.isFinite(value[i]))
  )
    throw new RangeError(message);
  return [value[0], value[1], value[2]];
}
