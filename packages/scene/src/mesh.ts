// The same helpers as members of every mesh, for code that reads `mesh.children` and `mesh.lookAt(...)`. One explicit call
// adds them, because importing a package must change nothing by itself.
import { Mesh as RuntimeMesh } from '@margoengine/core/extension';
import type { Mesh } from '@margoengine/core';
import {
  children,
  getWorldPosition,
  getWorldQuaternion,
  getWorldScale,
  lookAt,
  parent,
  traverse,
  userData,
} from './index.js';
import type { LookAtOptions, VectorTarget, WorldPoint, WorldQuaternion } from './index.js';
import type { MutableVec3 } from '@margoengine/math';

/** The members {@link extendMeshes} adds to every mesh. */
export interface SceneGraphMembers {
  /** Direct children in attach order, as a new array. */
  readonly children: Mesh[];
  /** The parent, or null. Change it with `setParent`. */
  readonly parent: Mesh | null;
  /** The mesh's own object for anything you want to keep with it. */
  userData: Record<string, unknown>;
  /** Calls `visitor` for this mesh and every mesh below it, parents first. */
  traverse(visitor: (mesh: Mesh) => void): void;
  /** Turns this mesh so its +Z points at a world point or mesh. */
  lookAt(target: WorldPoint, options?: LookAtOptions): this;
  /** Turns this mesh so its +Z points at world point (x, y, z). */
  lookAt(x: number, y: number, z: number): this;
  /** World position, in `out` or a new `[x, y, z]`. */
  getWorldPosition(): MutableVec3;
  getWorldPosition<T extends VectorTarget>(out: T): T;
  /** World rotation `[x, y, z, w]`, in `out` or a new array. */
  getWorldQuaternion(out?: WorldQuaternion): WorldQuaternion;
  /** World scale, in `out` or a new `[x, y, z]`. */
  getWorldScale(): MutableVec3;
  getWorldScale<T extends VectorTarget>(out: T): T;
}

declare module '@margoengine/core' {
  interface Mesh extends SceneGraphMembers {}
}
// The class plugins are typed against gets the same members, or importing this entry would stop every package's plugin
// fitting `engine.use`: the public Mesh would have members the runtime Mesh lacks.
declare module '@margoengine/core/extension' {
  interface Mesh extends SceneGraphMembers {}
}

/**
 * Adds `children`, `parent`, `userData`, `traverse`, `lookAt`, `getWorldPosition`, `getWorldQuaternion` and
 * `getWorldScale` to every mesh of every engine on this thread, from then on and for meshes that already exist. Calling
 * it again changes nothing. Their types come with this entry.
 */
export function extendMeshes(): void {
  if ('traverse' in RuntimeMesh.prototype) return;
  const self = (mesh: unknown) => mesh as Mesh;
  Object.defineProperties(RuntimeMesh.prototype, {
    children: {
      configurable: true,
      get() {
        return children(self(this));
      },
    },
    parent: {
      configurable: true,
      get() {
        return parent(self(this));
      },
    },
    userData: {
      configurable: true,
      get() {
        return userData(self(this));
      },
      set(value: Record<string, unknown>) {
        userData(self(this), value);
      },
    },
    traverse: {
      configurable: true,
      writable: true,
      value(visitor: (mesh: Mesh) => void) {
        traverse(self(this), visitor);
      },
    },
    lookAt: {
      configurable: true,
      writable: true,
      value(target: WorldPoint | number, second?: number | LookAtOptions, z?: number) {
        return typeof target === 'number'
          ? lookAt(self(this), [target, second as number, z as number])
          : lookAt(self(this), target, second as LookAtOptions | undefined);
      },
    },
    getWorldPosition: {
      configurable: true,
      writable: true,
      value(out?: VectorTarget) {
        return out === undefined ? getWorldPosition(self(this)) : getWorldPosition(self(this), out);
      },
    },
    getWorldQuaternion: {
      configurable: true,
      writable: true,
      value(out?: WorldQuaternion) {
        return getWorldQuaternion(self(this), out);
      },
    },
    getWorldScale: {
      configurable: true,
      writable: true,
      value(out?: VectorTarget) {
        return out === undefined ? getWorldScale(self(this)) : getWorldScale(self(this), out);
      },
    },
  });
}
