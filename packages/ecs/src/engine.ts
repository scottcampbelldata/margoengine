/// <reference lib="esnext.disposable" />
import type { Mesh } from '@margoengine/core';
import type { TransformStore } from '@margoengine/core/extension';
import { TransformWriter } from '@margoengine/scene/bulk';
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

/** The links of one engine: a `TransformWriter` takes the meshes of one engine, and `links[i]` is its row `i`. */
interface Batch {
  readonly writer: TransformWriter;
  readonly links: Int32Array;
  /** Mesh slot of each row and component row of each link, read once a sync. */
  readonly ids: Int32Array;
  readonly rows: Int32Array;
}

/**
 * Copies a transform component to core meshes in one bulk step a frame, through `TransformWriter` from
 * `@margoengine/scene/bulk`. The component may hold any of the three groups of {@link transformSchema}: position,
 * quaternion, scale; a mesh keeps its own values for a group the component lacks.
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
  /** Undefined when the links changed; `sync` builds it again. */
  private batches: Batch[] | undefined;
  /** Rows gathered for one write; float64, so a value reaches the writer's checks exactly as the component holds it. */
  private scratch = new Float64Array(0);
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
    this.batches = undefined;
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
    this.batches = undefined;
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
   * the systems that move things. Each group goes to `TransformWriter` in one write per run of rows that changed, so a
   * world that moves everything costs one write a group. The result is what the mesh's setters give, `mesh.rotation`
   * included, and a group equal to what the mesh already holds is left alone. The first sync after a link changes builds
   * the writer again, about one pass over the links.
   * @throws MargoError `'disposed'` when a linked mesh was disposed, before anything is written; `unlink` it when you dispose it yourself.
   * @throws RangeError for a value the mesh refuses: not finite, a zero scale or a zero quaternion. Writes before it stay copied.
   */
  sync(): number {
    const { entities, meshes, component, position, rotation, scale } = this,
      count = entities.length;
    const batches = (this.batches ??= this.group());
    for (const { links, ids, rows } of batches)
      for (let i = 0; i < links.length; i++) {
        const link = links[i],
          mesh = meshes[link];
        mesh.check();
        ids[i] = slot(mesh).id;
        rows[i] = component.index(entities[link]);
      }
    for (const batch of batches) {
      const t = slot(meshes[batch.links[0]]).engine.store.transforms;
      if (position) this.write(batch, 'positions', position, [t.x, t.y, t.z]);
      if (rotation) this.write(batch, 'quaternions', rotation, [t.qx, t.qy, t.qz, t.qw]);
      if (scale) this.write(batch, 'scales', scale, [t.sx, t.sy, t.sz]);
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
    this.batches = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.stop();
  }
  /** The links, one batch per engine: an app may draw one world on two canvases. */
  private group(): Batch[] {
    const { meshes } = this,
      byEngine = new Map<object, number[]>();
    for (let i = 0; i < meshes.length; i++) {
      const { engine } = slot(meshes[i]),
        links = byEngine.get(engine);
      if (links) links.push(i);
      else byEngine.set(engine, [i]);
    }
    return [...byEngine.values()].map((links) => ({
      writer: new TransformWriter(links.map((link) => meshes[link])),
      links: Int32Array.from(links),
      ids: new Int32Array(links.length),
      rows: new Int32Array(links.length),
    }));
  }
  /** Writes one group of `batch`: one `TransformWriter` call per run of rows that differ from what the meshes hold. */
  private write(
    { writer, ids, rows }: Batch,
    field: 'positions' | 'quaternions' | 'scales',
    columns: readonly NumericArray[],
    held: readonly NumericArray[],
  ): void {
    const width = columns.length,
      size = ids.length,
      [a, b, c, d = c] = columns,
      [p, q, r, s = r] = held;
    if (this.scratch.length < size * 4) this.scratch = new Float64Array(size * 4);
    const scratch = this.scratch;
    let from = -1;
    for (let i = 0; i <= size; i++) {
      // `d` and `s` repeat the third column when a group has three, so one compare serves both widths.
      const row = rows[i],
        id = ids[i],
        differs = i < size && (p[id] !== a[row] || q[id] !== b[row] || r[id] !== c[row] || s[id] !== d[row]);
      if (differs) {
        if (from < 0) from = i;
        const at = (i - from) * width;
        scratch[at] = a[row];
        scratch[at + 1] = b[row];
        scratch[at + 2] = c[row];
        if (width === 4) scratch[at + 3] = d[row];
      } else if (from >= 0) {
        writer.write({ [field]: scratch }, { from, count: i - from });
        from = -1;
      }
    }
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
