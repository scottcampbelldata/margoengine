/// <reference lib="esnext.disposable" preserve="true" />
// The `scene` entry: one top-level tree over every draw of a scene, so a raycast crosses a city in log time instead of
// testing each mesh's bounding sphere in turn. It selects candidates only; each one then goes through the Raycaster's
// own per-object test, so hits, ordering and settings are those of `intersectEngine`.
import type { Engine, Mesh } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { multiplyMatrices } from '@margoengine/math/mat4';
import { meshTriangles } from '../../shared/mesh-source.js';
import { ownLayers as maskOf } from '../../shared/view-rect.js';
import {
  deformedError,
  deformedNode,
  engineModels,
  engineProxies,
  getMeshLayers,
  isModel,
  primitiveEntry,
  worldSphere,
  type Candidate,
  type IntersectOptions,
  type ModelLike,
  type ModelPrimitiveLike,
  type PickProxy,
  type Raycaster,
  type RaycasterHit,
  type RaycastRuntime,
  type RuntimeMesh,
} from './raycaster.js';
import { SnapshotTree } from './snapshot-tree.js';

/** What {@link SceneBVH.update} did. */
export type SceneBVHUpdate = 'unchanged' | 'refit' | 'rebuilt';
/** Options of a {@link SceneBVH}. */
export interface SceneBVHOptions {
  /** Cover only these meshes and models, as `intersectObjects` does. Default: everything `intersectEngine` tests. */
  objects?: Iterable<Mesh | ModelLike>;
  /** Refit until the tree costs this many times what it cost when built, then rebuild it. Default 1.5. */
  rebuildThreshold?: number;
}

interface Item {
  node: RuntimeMesh;
  model: ModelLike | null;
  primitive: ModelPrimitiveLike | null;
  index: number;
  ownLayers: boolean;
  proxy: ArrayLike<number> | null;
  instance: number;
  /** Local bounding sphere, and the values last seen in it. */
  bounds: ArrayLike<number>;
  local: Float64Array;
  /** World matrix last seen. */
  matrix: Float32Array;
  /** World bounding sphere: what the tree holds. */
  sphere: Float64Array;
}
interface Deformed {
  node: RuntimeMesh;
  mask: number;
  model: ModelLike | null;
}

const NOWHERE = new Float64Array(4);

/**
 * A top-level BVH over all meshes, model primitives, instances and pick proxies of an engine. `intersect` answers what
 * `raycaster.intersectEngine` answers, without visiting every object. By default each `intersect` first looks for
 * anything that moved; to cast many rays a frame, call `update()` once and pass `{refresh: false}`.
 */
export class SceneBVH {
  readonly #engine: Engine;
  readonly #runtime: RaycastRuntime;
  readonly #objects: Set<Mesh | ModelLike> | null;
  readonly #threshold: number;
  #items: Item[] = [];
  #deformed: Deformed[] = [];
  #tree: SnapshotTree | null = null;
  #cost = 0;
  #disposed = false;

  constructor(engine: Engine, { objects, rebuildThreshold = 1.5 }: SceneBVHOptions = {}) {
    if (!(rebuildThreshold >= 1)) throw new RangeError('Invalid rebuildThreshold; pass a number of at least 1.');
    this.#engine = engine;
    this.#runtime = engine as unknown as RaycastRuntime;
    this.#objects = objects ? new Set(objects) : null;
    this.#threshold = rebuildThreshold;
  }

  /** Objects the tree holds: one per mesh, primitive, instance and proxy. Current as of the last update. */
  get size(): number {
    return this.#items.length;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Adds a mesh or model to a scene made with `objects`; the next update takes it in. */
  add(object: Mesh | ModelLike): void {
    this.#chosen().add(object);
  }

  /** Removes a mesh or model from a scene made with `objects`; the next update drops it. */
  remove(object: Mesh | ModelLike): boolean {
    return this.#chosen().delete(object);
  }

  /**
   * Brings the tree up to date: 'rebuilt' when objects came or went or a refit left the tree too slow, 'refit' when
   * some moved, 'unchanged' otherwise. Costs one pass over the objects' matrices.
   */
  update({ refresh = true }: IntersectOptions = {}): SceneBVHUpdate {
    this.#live();
    if (refresh) this.#runtime.store.tick(false);
    const before = this.#items,
      items: Item[] = [],
      deformed: Deformed[] = [],
      scratch = new Float32Array(16);
    let same = true,
      moved = false;
    const visit = (
      node: RuntimeMesh,
      model: ModelLike | null,
      primitive: ModelPrimitiveLike | null,
      index: number,
      ownLayers: boolean,
      proxy: ArrayLike<number> | null,
      bounds: ArrayLike<number>,
      world: Float32Array,
      offset: number,
      instance = -1,
    ): void => {
      let item = before[items.length];
      if (
        !item ||
        item.node !== node ||
        item.model !== model ||
        item.primitive !== primitive ||
        item.instance !== instance ||
        item.proxy !== proxy
      ) {
        same = false;
        item = {
          node,
          model,
          primitive,
          index,
          ownLayers,
          proxy,
          instance,
          bounds,
          local: new Float64Array(4).fill(Number.NaN),
          matrix: new Float32Array(16).fill(Number.NaN),
          sphere: new Float64Array(4),
        };
      }
      items.push(item);
      item.index = index;
      item.bounds = bounds;
      let changed = false;
      for (let k = 0; k < 4; k++)
        if (item.local[k] !== bounds[k]) {
          item.local[k] = bounds[k];
          changed = true;
        }
      for (let k = 0; k < 16; k++)
        if (item.matrix[k] !== world[offset + k]) {
          item.matrix[k] = world[offset + k];
          changed = true;
        }
      if (!changed) return;
      moved = true;
      worldSphere(item.matrix, 0, bounds, item.sphere);
      // A sphere that is not finite never answers a ray, here or in the Raycaster; it only must not poison the tree.
      if (!item.sphere.every(Number.isFinite)) item.sphere.set(NOWHERE);
    };
    this.#collect(visit, deformed, scratch);
    this.#items = items;
    this.#deformed = deformed;
    if (!same || items.length !== before.length || !this.#tree) {
      this.#tree = new SnapshotTree(items.map((item) => item.sphere));
      this.#cost = this.#tree.cost();
      return 'rebuilt';
    }
    if (!moved) return 'unchanged';
    this.#tree.refit(items.map((item) => item.sphere));
    if (this.#tree.cost() <= this.#cost * this.#threshold) return 'refit';
    this.#tree = new SnapshotTree(items.map((item) => item.sphere));
    this.#cost = this.#tree.cost();
    return 'rebuilt';
  }

  /**
   * The hits of `raycaster` over the scene, sorted by distance: its origin, direction, near, far, side, layers, filter
   * and firstHitOnly all count. With `{refresh: false}` the tree stays as of the last `update()`, so objects moved since
   * are found at their old place.
   */
  intersect(raycaster: Raycaster, { refresh = true }: IntersectOptions = {}): RaycasterHit[] {
    this.#live();
    if (refresh || !this.#tree) this.update({ refresh });
    const runtime = this.#runtime,
      items = this.#items;
    for (const { node, mask, model } of this.#deformed)
      if (raycaster.usable(runtime, node, mask, model)) throw deformedError();
    const candidates: Candidate[] = [];
    for (const at of this.#tree!.candidates(raycaster.origin, raycaster.direction)) {
      const { node, model, primitive, index, ownLayers, proxy, instance, bounds, matrix } = items[at],
        entry = raycaster.entry(matrix, 0, bounds),
        mask = ownLayers || !model ? getMeshLayers(node as unknown as Mesh) : (maskOf(node) ?? maskOf(model.root) ?? 1);
      if (entry < 0 || !raycaster.usable(runtime, node, mask, model)) continue;
      const candidate: Candidate = { node, entry, model, primitive, index };
      if (ownLayers) candidate.ownLayers = true;
      if (proxy) candidate.sphere = proxy;
      if (instance >= 0) {
        candidate.matrix = matrix;
        candidate.instance = instance;
      }
      candidates.push(candidate);
    }
    return raycaster.castCandidates(runtime, candidates);
  }

  /** Lets go of the tree. */
  dispose(): void {
    this.#disposed = true;
    this.#items = [];
    this.#deformed = [];
    this.#tree = null;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  // Every object in the order of Raycaster.intersect, so filters run in the same order.
  #collect(
    visit: (
      node: RuntimeMesh,
      model: ModelLike | null,
      primitive: ModelPrimitiveLike | null,
      index: number,
      ownLayers: boolean,
      proxy: ArrayLike<number> | null,
      bounds: ArrayLike<number>,
      world: Float32Array,
      offset: number,
      instance?: number,
    ) => void,
    deformed: Deformed[],
    scratch: Float32Array,
  ): void {
    const runtime = this.#runtime,
      matrices = runtime.store.matrices,
      engine = this.#engine,
      chosen = this.#objects;
    const meshes: Iterable<RuntimeMesh> = chosen
        ? ([...chosen].filter((object) => !isModel(object)) as unknown as RuntimeMesh[])
        : runtime.meshes.values(),
      models: ModelLike[] = chosen ? ([...chosen].filter((object) => isModel(object)) as ModelLike[]) : engineModels(engine),
      modelSet = new Set(models);
    let proxies: PickProxy[] = engineProxies(engine);
    if (chosen) proxies = proxies.filter((p) => chosen.has(p.anchor) || chosen.has(p.model as ModelLike));
    for (const mesh of meshes) {
      if (runtime.meshes.get(mesh.id) !== mesh) continue;
      const source = meshTriangles(mesh as unknown as Mesh);
      if (source?.kind === 'pbr') {
        if (source.source.primitives.some((p) => p.deformed))
          deformed.push({ node: mesh, mask: getMeshLayers(mesh as unknown as Mesh), model: null });
        else {
          const owner = source.source.model as unknown as ModelLike;
          if (!modelSet.has(owner))
            for (const primitive of source.source.primitives) {
              const p = primitive as unknown as ModelPrimitiveLike;
              visit(mesh, owner, p, owner.primitives.indexOf(p), true, null, primitiveEntry(p).sphere, matrices, mesh.id * 16);
            }
        }
      }
      if (mesh.geometry) visit(mesh, null, null, -1, false, null, mesh.geometry.bounds, matrices, mesh.id * 16);
    }
    for (const model of models) {
      if (model.disposed) continue;
      const rootMask = maskOf(model.root);
      model.primitives.forEach((primitive, index) => {
        const node = primitive.node as unknown as RuntimeMesh,
          instances = primitive.instances;
        if (deformedNode(primitive.node)) {
          deformed.push({ node, mask: maskOf(node) ?? rootMask ?? 1, model });
          return;
        }
        const sphere = primitiveEntry(primitive).sphere;
        if (!instances) {
          visit(node, model, primitive, index, false, null, sphere, matrices, node.id * 16);
          return;
        }
        if (runtime.meshes.get(node.id) !== node) return;
        const world = matrices.subarray(node.id * 16, node.id * 16 + 16);
        for (let k = 0; k < instances.count; k++) {
          multiplyMatrices(world, instances.data.subarray(k * 24, k * 24 + 16), scratch);
          visit(node, model, primitive, index, false, null, sphere, scratch, 0, k);
        }
      });
    }
    for (const { anchor, sphere, model } of proxies) {
      const node = anchor as unknown as RuntimeMesh;
      if (runtime.meshes.get(node.id) === node)
        visit(node, isModel(model) ? model : null, null, -1, true, sphere, sphere, matrices, node.id * 16);
    }
  }

  #chosen(): Set<Mesh | ModelLike> {
    if (!this.#objects)
      throw new MargoError('state', 'This SceneBVH covers the whole engine; make one with `objects` to add or remove.');
    return this.#objects;
  }

  #live(): void {
    if (this.#disposed) throw new MargoError('disposed', 'SceneBVH is disposed; make a new one to raycast.');
    if (this.#runtime.disposed) throw new MargoError('disposed', 'Engine is disposed; raycast against a live Engine.');
  }
}
