import type { EngineKernel, Mesh, Scene } from '@margoengine/core';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import { fault, typeError } from '../../shared/errors.js';
import { deferMutation } from './mutations.js';

/** Observable committed scene mutations. */
export type SceneEventType = 'added' | 'removed' | 'disposed';
/** Immutable lifecycle description. For removed, parent is the previous parent; null means scene root. */
export interface SceneEvent {
  readonly type: SceneEventType;
  readonly mesh: Mesh;
  readonly parent: Mesh | null;
  readonly scene: Scene;
}
/** Subscription options. Listener removal is automatic on abort, once, or observer disposal. */
export interface SceneListenerOptions {
  signal?: AbortSignal;
  once?: boolean;
  mesh?: Mesh;
  scene?: Scene;
}
type Listener = { type: SceneEventType; callback: (event: SceneEvent) => void; options: SceneListenerOptions; off: () => void };
const installed = new WeakSet<EngineKernel>();

/**
 * Explicit per-engine lifecycle observer, including existing meshes, scene disposal and engine disposal.
 * Installs reversible instance wrappers, never global prototypes or core changes. Events follow successful mutation.
 * Dispose the observer to restore its wrappers; errors in listeners go to engine.onError after every listener runs.
 */
export class SceneEvents {
  /** Installs a reversible lifecycle observer on this engine. */
  static attach(engine: EngineKernel): SceneEvents {
    return new SceneEvents(engine);
  }
  private active = true;
  private readonly runtime;
  private readonly listeners = new Set<Listener>();
  private readonly restoreMeshes = new Map<Mesh, () => void>();
  private readonly restoring: (() => void)[] = [];
  private readonly removing = new Set<Mesh>();

  constructor(private readonly engine: EngineKernel) {
    const runtime = this.runtime = engineRuntime(engine);
    if (runtime.disposed) throw fault('disposed', 'SceneEvents: engine disposed');
    if (installed.has(engine)) throw fault('state', 'SceneEvents: dispose the existing observer before making another', 'scene');
    installed.add(engine);
    try {
    for (const mesh of runtime.meshes.values()) this.watch(mesh);
    const create = runtime.createMesh, remove = runtime.remove, observer = this;
    this.restoring.push(this.wrap(runtime, 'createMesh', function (this: typeof runtime, ...args: Parameters<typeof create>) {
      const mesh = create.apply(this, args);
      if (observer.active) { observer.watch(mesh); observer.emit([observer.event('added', mesh, observer.parentOf(mesh))]); }
      return mesh;
    }));
    this.restoring.push(this.wrap(runtime, 'remove', function (this: typeof runtime, mesh: Parameters<typeof remove>[0]) {
      if (!observer.active) return remove.call(this, mesh);
      mesh.check();
      const previous = observer.parentOf(mesh);
      const detached = [...(mesh.kids ?? [])].map((id) => runtime.meshes.get(id)!).filter(Boolean);
      observer.removing.add(mesh);
      try { remove.call(this, mesh); }
      finally { observer.removing.delete(mesh); }
      const events = detached.filter((child) => runtime.store.parents[child.id] === -1)
        .map((child) => observer.event('removed', child, mesh));
      events.push(observer.event('removed', mesh, previous), observer.event('disposed', mesh, previous));
      observer.restoreMeshes.get(mesh)?.(); observer.restoreMeshes.delete(mesh);
      observer.emit(events);
    }));
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  private parentOf(mesh: Mesh): Mesh | null {
    const r = meshRuntime(mesh);
    return r.engine.meshes.get(r.engine.store.parents[r.id]) ?? null;
  }
  private event(type: SceneEventType, mesh: Mesh, parent: Mesh | null): SceneEvent {
    return Object.freeze({ type, mesh, parent, scene: meshRuntime(mesh).scene });
  }
  private wrap<T extends object, K extends keyof T>(target: T, key: K, replacement: T[K]): () => void {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement });
    return () => {
      if (target[key] !== replacement) return;
      if (original) Object.defineProperty(target, key, original);
      else delete target[key];
    };
  }
  private watch(mesh: Mesh): void {
    if (this.restoreMeshes.has(mesh)) return;
    const setParent = mesh.setParent, observer = this;
    this.restoreMeshes.set(mesh, this.wrap(mesh, 'setParent', function (this: Mesh, next: Mesh | null) {
      if (!observer.active || observer.removing.has(mesh)) return setParent.call(this, next);
      const previous = observer.parentOf(mesh);
      const result = setParent.call(this, next);
      if (previous !== next) {
        const events: SceneEvent[] = [];
        if (previous) events.push(observer.event('removed', mesh, previous));
        if (next) events.push(observer.event('added', mesh, next));
        observer.emit(events);
      }
      return result;
    }));
  }
  private emit(events: SceneEvent[]): void {
    if (deferMutation(this.runtime, () => this.emit(events))) return;
    const errors: unknown[] = [];
    // Snapshot per event: new listeners do not run during that event; removed listeners are respected.
    for (const event of events) for (const listener of [...this.listeners]) {
      const { options } = listener;
      if (!this.active || !this.listeners.has(listener) || listener.type !== event.type ||
        (options.mesh && options.mesh !== event.mesh) || (options.scene && options.scene !== event.scene)) continue;
      if (options.once) listener.off();
      try { listener.callback(event); } catch (error) { errors.push(error); }
    }
    for (const error of errors) queueMicrotask(() => this.engine.onError(error));
  }
  /** Subscribe to committed mutations. Returns an idempotent unsubscribe function. No initial replay. */
  on(type: SceneEventType, callback: (event: SceneEvent) => void, options: SceneListenerOptions = {}): () => void {
    if (!this.active) throw fault('disposed', 'SceneEvents: observer disposed');
    if (!['added', 'removed', 'disposed'].includes(type) || typeof callback !== 'function')
      throw typeError('SceneEvents.on: supply an event type and listener', 'arguments');
    const ownOptions = { ...options };
    const listener: Listener = { type, callback, options: ownOptions, off: () => {
      this.listeners.delete(listener); ownOptions.signal?.removeEventListener('abort', listener.off);
    } };
    if (!ownOptions.signal?.aborted) {
      this.listeners.add(listener);
      ownOptions.signal?.addEventListener('abort', listener.off, { once: true });
    }
    return listener.off;
  }
  /** Remove every subscription and restore instance methods still owned by this observer. */
  dispose(): void {
    if (!this.active) return;
    this.active = false;
    for (const listener of this.listeners) listener.off();
    for (const restore of this.restoreMeshes.values()) restore();
    for (const restore of this.restoring) restore();
    this.restoreMeshes.clear(); this.restoring.length = 0;
    installed.delete(this.engine);
  }
  /** Dispose the observer when a using block ends. */
  [Symbol.dispose](): void { this.dispose(); }
}
