/// <reference lib="esnext.disposable" />
import type { Mesh } from '@margoengine/core';
import type { TransformStore } from '@margoengine/core/extension';
import type { Component, ComponentObserver, Entity, NumericArray } from './index.js';

/** Schema of a full transform component: position `x y z`, unit quaternion `qx qy qz qw`, scale `sx sy sz`. */
export const transformSchema = {
  x: Float32Array,
  y: Float32Array,
  z: Float32Array,
  qx: Float32Array,
  qy: Float32Array,
  qz: Float32Array,
  qw: Float32Array,
  sx: Float32Array,
  sy: Float32Array,
  sz: Float32Array,
};
/** Settings of a {@link MeshBridge}. */
export interface MeshBridgeOptions {
  /** Dispose a linked mesh when its entity loses the component or is destroyed. Default false: the link just ends. */
  disposeMeshes?: boolean;
}

/** What the bridge reads of a runtime mesh; the public handle hides it (the same object, as `meshRuntime` says). */
type Slot = { readonly id: number; readonly engine: { readonly store: TransformStore } };
const slot = (mesh: Mesh) => mesh as unknown as Slot;

/**
 * Copies a transform component to core meshes in one call a frame. The component may hold any of the three groups of
 * {@link transformSchema}: position, quaternion, scale; a mesh keeps its own values for a group the component lacks.
 * A mesh's transform is relative to its parent, so hierarchies stay on the meshes (`mesh.setParent`).
 */
export class MeshBridge {
  private readonly entities: Entity[] = [];
  private readonly meshes: Mesh[] = [];
  private readonly places = new Map<Entity, number>();
  private readonly linked = new Set<Mesh>();
  private readonly observer: ComponentObserver;
  private readonly position: readonly [NumericArray, NumericArray, NumericArray] | undefined;
  private readonly rotation: readonly [NumericArray, NumericArray, NumericArray, NumericArray] | undefined;
  private readonly scale: readonly [NumericArray, NumericArray, NumericArray] | undefined;
  private readonly quaternion = [0, 0, 0, 1];
  /** @throws TypeError when the component has none of the three groups, or only part of one. */
  constructor(
    readonly component: Component,
    { disposeMeshes = false }: MeshBridgeOptions = {},
  ) {
    const fields = component.fields as Record<string, NumericArray>;
    const group = (names: readonly string[]) => {
      const found = names.filter((name) => Object.hasOwn(fields, name));
      if (found.length && found.length < names.length)
        throw new TypeError(`Partial transform component; give all of ${names.join(', ')} or none of them`);
      return found.length ? names.map((name) => fields[name]) : undefined;
    };
    this.position = group(['x', 'y', 'z']) as typeof this.position;
    this.rotation = group(['qx', 'qy', 'qz', 'qw']) as typeof this.rotation;
    this.scale = group(['sx', 'sy', 'sz']) as typeof this.scale;
    if (!this.position && !this.rotation && !this.scale)
      throw new TypeError('Component has no transform fields; use transformSchema or its x, y, z fields');
    this.observer = {
      onAdd() {},
      onChange() {},
      onRemove: (entity) => {
        const mesh = this.meshOf(entity);
        if (!mesh) return;
        this.unlink(entity);
        if (disposeMeshes) mesh.dispose();
      },
    };
    component.observers.push(this.observer);
  }
  /**
   * Tie `entity` to `mesh`. An entity without the component gets it, filled from the mesh's current transform, so the
   * mesh does not jump; one that has it keeps its values and the mesh takes them at the next `sync`. Linking an entity
   * again replaces its mesh.
   * @throws MargoError `'state'` when the entity is stale, or `'disposed'` when the mesh is disposed.
   * @throws TypeError when the mesh is linked to another entity.
   */
  link(entity: Entity, mesh: Mesh): this {
    this.component.world.check(entity);
    mesh.check();
    if (this.linked.has(mesh) && this.meshOf(entity) !== mesh)
      throw new TypeError('Mesh is already linked; unlink it first, or give each entity its own mesh');
    this.unlink(entity);
    if (this.component.index(entity) < 0) this.fill(entity, mesh);
    this.places.set(entity, this.entities.length);
    this.entities.push(entity);
    this.meshes.push(mesh);
    this.linked.add(mesh);
    return this;
  }
  /** End a link and leave the mesh as it is; false when `entity` has none. */
  unlink(entity: Entity): boolean {
    const place = this.places.get(entity);
    if (place === undefined) return false;
    const { entities, meshes } = this,
      lastEntity = entities.pop() as Entity,
      lastMesh = meshes.pop() as Mesh;
    this.linked.delete(place === entities.length ? lastMesh : meshes[place]);
    this.places.delete(entity);
    if (place < entities.length) {
      entities[place] = lastEntity;
      meshes[place] = lastMesh;
      this.places.set(lastEntity, place);
    }
    return true;
  }
  /** The mesh linked to `entity`, if any. */
  meshOf(entity: Entity): Mesh | undefined {
    const place = this.places.get(entity);
    return place === undefined ? undefined : this.meshes[place];
  }
  /**
   * Copy every linked entity's transform to its mesh; returns how many links were copied. Call it once a frame, after
   * the systems that move things. Values go through the mesh's own setters, so they get the same checks as a hand
   * write and `mesh.rotation` stays correct; a group equal to what the mesh already holds is left alone.
   * @throws MargoError `'disposed'` when a linked mesh was disposed; `unlink` it when you dispose it yourself.
   * @throws RangeError for a value the mesh refuses: not finite, a zero scale or a zero quaternion. Links before it stay copied.
   */
  sync(): number {
    const { entities, meshes, component, position, rotation, scale, quaternion } = this,
      count = entities.length;
    for (let i = 0; i < count; i++) {
      const mesh = meshes[i];
      mesh.check();
      const row = component.index(entities[i]),
        { id, engine } = slot(mesh),
        t = engine.store.transforms;
      if (position) {
        const x = position[0][row],
          y = position[1][row],
          z = position[2][row];
        if (t.x[id] !== x || t.y[id] !== y || t.z[id] !== z) mesh.position.set(x, y, z);
      }
      if (rotation) {
        const x = rotation[0][row],
          y = rotation[1][row],
          z = rotation[2][row],
          w = rotation[3][row];
        if (t.qx[id] !== x || t.qy[id] !== y || t.qz[id] !== z || t.qw[id] !== w) {
          quaternion[0] = x;
          quaternion[1] = y;
          quaternion[2] = z;
          quaternion[3] = w;
          mesh.setQuaternion(quaternion);
        }
      }
      if (scale) {
        const x = scale[0][row],
          y = scale[1][row],
          z = scale[2][row];
        if (t.sx[id] !== x || t.sy[id] !== y || t.sz[id] !== z) mesh.scale.set(x, y, z);
      }
    }
    return count;
  }
  /** End every link and stop watching the component. Safe to call twice. */
  stop(): void {
    const { observers } = this.component,
      at = observers.indexOf(this.observer);
    if (at >= 0) observers.splice(at, 1);
    this.entities.length = this.meshes.length = 0;
    this.places.clear();
    this.linked.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.stop();
  }
  private fill(entity: Entity, mesh: Mesh): void {
    const { id, engine } = slot(mesh),
      t = engine.store.transforms,
      values: Record<string, number> = {};
    if (this.position) Object.assign(values, { x: t.x[id], y: t.y[id], z: t.z[id] });
    if (this.rotation) Object.assign(values, { qx: t.qx[id], qy: t.qy[id], qz: t.qz[id], qw: t.qw[id] });
    if (this.scale) Object.assign(values, { sx: t.sx[id], sy: t.sy[id], sz: t.sz[id] });
    this.component.add(entity, values);
  }
}
