/// <reference lib="esnext.disposable" preserve="true" />
import type { Engine, Mesh } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import type { BVHBuildOptions } from './build.js';
import type { MutableVec3 } from '@margoengine/math';
import { transformPoint } from './math.js';
import {
  Raycaster,
  engineProxies,
  hitUV,
  localRay,
  proxyHit,
  sphereEntry,
  worldHit,
  type IntersectOptions,
  type ModelLike,
  type RaycasterHit,
} from './raycaster.js';
import { captureEntries, type SnapshotEntry, type SnapshotRuntime } from './snapshot-source.js';
import { SnapshotTree } from './snapshot-tree.js';
import { RaycastProjection } from './projection.js';
import {
  createVisibilityQuery,
  type RaycastVisibilityOptions,
  type RaycastVisibilityQuery,
} from './visibility-query.js';

/** Capture settings for {@link RaycastSnapshot.capture}. Building the snapshot's BVHs never changes source geometry. */
export interface RaycastSnapshotOptions extends IntersectOptions {
  /** Options for the snapshot's own local BVHs. A Raycaster's `bvhOptions` does not affect a snapshot. */
  bvhOptions?: BVHBuildOptions;
}
/** Depth-only hit from {@link RaycastSnapshot.intersectDepth}: the fields depth and alpha tests need, all owned. */
export interface RaycastDepthHit {
  /** World distance from the ray origin. */
  distance: number;
  /** World hit point. */
  point: MutableVec3;
  /** TEXCOORD_0 at the hit, for model primitives only. */
  uv?: [number, number];
}
/** Raycaster settings copied at query start, so filters that change the Raycaster cannot affect a running query. */
interface QueryState {
  origin: MutableVec3;
  direction: MutableVec3;
  near: number;
  far: number;
  side: Raycaster['side'];
  first: boolean;
  layers: number;
  filter: Raycaster['filter'];
}
const SIDES: readonly Raycaster['side'][] = ['material', 'front', 'back', 'double'];

/**
 * A static frame of the scene for many CPU raycasts: geometry and UVs, world transforms, material sides, layer masks,
 * visibility, object membership and the camera mapping are copied at capture, so later edits need a new capture.
 * Hits carry the captured numbers and the original mesh, model and primitive objects. Meshes removed (or whose id was
 * reused) and disposed models are skipped; queries after the engine or snapshot is disposed throw.
 * Core meshes, static PBR models, instances and pick proxies are tested in local space under a Float64 top-level
 * tree. A visible deformed (skinned or morphed) source makes capture throw rather than silently test its bind pose.
 */
export class RaycastSnapshot {
  private runtime: SnapshotRuntime | null;
  private entries: SnapshotEntry[];
  private tree: SnapshotTree | null;
  private projection: RaycastProjection | null;

  private constructor(runtime: SnapshotRuntime, entries: SnapshotEntry[], projection: RaycastProjection) {
    this.runtime = runtime;
    this.entries = entries;
    this.projection = projection;
    this.tree = new SnapshotTree(entries.map((e) => e.sphere));
  }

  /**
   * Captures the given meshes and models, and the engine's pick proxies anchored on them. Geometry shared by several
   * draws is copied once. `refresh` (default true) runs the transform kernel first; the camera is updated either way.
   * Capture never changes source geometry and returns only when complete. Empty geometry is left out and draws with a
   * singular transform are skipped.
   * @throws TypeError for an invalid engine, object list or options; RangeError for malformed geometry, transforms or
   * camera; MargoError `disposed` for a disposed engine, `unsupported` for a visible deformed source (use
   * `await Raycaster.intersectModel(model)` for its current pose).
   */
  static capture(
    engine: Engine,
    objects: Iterable<Mesh | ModelLike>,
    options: RaycastSnapshotOptions = {},
  ): RaycastSnapshot {
    const runtime = engine as unknown as SnapshotRuntime;
    if (!runtime?.store || typeof runtime.meshes?.get !== 'function' || !runtime.camera || !runtime.canvas)
      throw new TypeError('RaycastSnapshot needs an Engine with a camera and canvas; pass a live Engine.');
    if (runtime.disposed) throw new MargoError('disposed', 'Snapshot engine is disposed; capture a live Engine.');
    if (!objects || typeof objects[Symbol.iterator] !== 'function')
      throw new TypeError('Snapshot objects must be an iterable of meshes and models; pass an array.');
    const { bvhOptions, refresh = true } = (options ?? {}) as RaycastSnapshotOptions;
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      (bvhOptions !== undefined && (!bvhOptions || typeof bvhOptions !== 'object' || Array.isArray(bvhOptions)))
    )
      throw new TypeError('Snapshot options must be an object with optional bvhOptions; pass an object or omit it.');
    if (typeof refresh !== 'boolean')
      throw new TypeError('Snapshot refresh must be a boolean; use true to update transforms, false after rendering.');
    if (refresh) runtime.store.tick(false);
    const projection = RaycastProjection.capture(engine);
    const entries = captureEntries(objects, engineProxies(engine), runtime, bvhOptions);
    if (runtime.disposed)
      throw new MargoError('disposed', 'Snapshot engine was disposed during capture; capture a live Engine.');
    return new RaycastSnapshot(runtime, entries, projection);
  }

  /** Whether {@link RaycastSnapshot.dispose} has released this snapshot. */
  get disposed(): boolean {
    return this.runtime === null;
  }

  /** Releases the captured geometry, bounds and engine references. Idempotent; capture a new snapshot to query again. */
  dispose(): void {
    this.runtime = null;
    this.entries = [];
    this.tree = null;
    this.projection?.dispose();
    this.projection = null;
  }

  /** Same as {@link RaycastSnapshot.dispose}, for `using` declarations. */
  [Symbol.dispose](): void {
    this.dispose();
  }

  private open(): SnapshotRuntime {
    if (!this.runtime)
      throw new MargoError('disposed', 'RaycastSnapshot is disposed; capture a new snapshot before querying.');
    if (this.runtime.disposed)
      throw new MargoError('disposed', 'Snapshot engine is disposed; capture a live Engine instead.');
    return this.runtime;
  }

  /**
   * Sets `raycaster` through a canvas point in CSS pixels with the captured camera and canvas size (points outside the
   * canvas are valid), with the same arithmetic as `Raycaster.setFromEngine` but no camera update or inversion per ray.
   * @throws TypeError for a non-Raycaster; RangeError for non-finite coordinates; MargoError `disposed` after disposal.
   */
  setFromCanvas(raycaster: Raycaster, x: number, y: number): Raycaster {
    this.open();
    return this.projection!.setFromCanvas(raycaster, x, y);
  }

  /**
   * A visibility query over this snapshot with its own captured alpha atlas and ray policy. Dispose the query before
   * this snapshot and any projection it borrows.
   * @throws TypeError or RangeError for invalid options; MargoError `disposed` after disposal.
   */
  createVisibilityQuery(options: RaycastVisibilityOptions = {}): RaycastVisibilityQuery {
    this.open();
    return createVisibilityQuery(this, this.projection!, options, queryState, () => this.open());
  }

  /** Same hits, order, settings and liveness as {@link RaycastSnapshot.intersect}, with only distance, point and uv. */
  intersectDepth(raycaster: Raycaster): RaycastDepthHit[] {
    return this.query(raycaster, true);
  }

  /**
   * Tests the captured scene with a Raycaster's ray, near/far, side, layers, firstHitOnly and filter, all copied at
   * query start. Filters run in capture order on the bounding-sphere candidates and may issue nested queries; liveness
   * is checked again after each filter, so a disposed or reused handle never receives a hit. Results are owned by the
   * caller and never alias snapshot data.
   * @throws TypeError for an invalid raycaster, side or filter; RangeError for a non-finite or non-normalized ray, or
   * invalid near/far or layers (set the ray with `Raycaster.set`; use 0 <= near <= far, far may be Infinity);
   * MargoError `disposed` once the engine or snapshot is disposed, also from inside a filter.
   */
  intersect(raycaster: Raycaster): RaycasterHit[] {
    return this.query(raycaster, false);
  }

  private query(raycaster: Raycaster, depthOnly: true): RaycastDepthHit[];
  private query(raycaster: Raycaster, depthOnly: false): RaycasterHit[];
  private query(raycaster: Raycaster, depthOnly: boolean): (RaycasterHit | RaycastDepthHit)[] {
    const runtime = this.open(),
      state = queryState(raycaster),
      entries = this.entries;
    const live = (e: SnapshotEntry) =>
      runtime.meshes.get(e.id) === e.node &&
      e.node.id === e.id &&
      !e.model?.disposed &&
      (!e.root || (e.root.id === e.rootId && runtime.meshes.get(e.rootId!) === e.root));
    const candidates: { index: number; entry: number }[] = [];
    for (const index of this.tree!.candidates(state.origin, state.direction)) {
      const e = entries[index];
      if (!(e.mask & state.layers) || !live(e)) continue;
      const entry = sphereEntry(e.sphere, state.origin, state.direction, state.near, state.far);
      if (entry < 0) continue;
      if (state.filter) {
        const allowed = state.filter(e.node as unknown as Mesh, e.model ?? undefined);
        this.open();
        if (!allowed || !live(e)) continue;
      }
      candidates.push({ index, entry });
    }
    if (state.first) candidates.sort((a, b) => a.entry - b.entry || a.index - b.index);
    const hits: (RaycasterHit | RaycastDepthHit)[] = [],
      local = new Float64Array(3),
      direction = [0, 0, 0],
      ray = { origin: local, direction };
    let best = state.far;
    for (const candidate of candidates) {
      const e = entries[candidate.index];
      if (!live(e)) continue;
      if (state.first && candidate.entry > best) break;
      const length = localRay(e.inverse, state.origin, state.direction, local, direction),
        far = state.first ? best : state.far,
        mesh = e.node as unknown as Mesh;
      if (e.proxy) {
        const hit = proxyHit(mesh, e.model, e.proxy, e.inverse, local, direction, state, far);
        if (!hit) continue;
        if (state.first) {
          best = hit.distance;
          hits.length = 0;
        }
        hits.push(depthOnly ? { distance: hit.distance, point: hit.point } : hit);
        continue;
      }
      const bvh = e.geometry!.bvh,
        options = {
          near: state.near * length,
          far: far * length,
          side: state.side === 'material' ? e.side : state.side,
        },
        found = state.first ? [bvh.raycastFirst(ray, options)] : bvh.raycast(ray, options);
      for (const hit of found) {
        if (!hit) continue;
        const distance = hit.distance / length;
        if (state.first) {
          if (distance > best) continue;
          best = distance;
          hits.length = 0;
        }
        let result: RaycasterHit | RaycastDepthHit;
        if (depthOnly) {
          const point: MutableVec3 = [0, 0, 0];
          transformPoint(e.matrix, hit.point[0], hit.point[1], hit.point[2], point);
          result = { distance, point };
        } else {
          const rich = worldHit(mesh, hit, e.matrix, e.inverse, length);
          if (e.primitive) {
            rich.model = e.model!;
            rich.primitive = e.primitive;
            rich.primitiveIndex = e.index;
            rich.nodeIndex = e.nodeIndex;
            if (e.instance !== undefined) rich.instanceId = e.instance;
          }
          result = rich;
        }
        if (e.primitive) result.uv = hitUV(e.geometry!.vertices, hit);
        hits.push(result);
      }
    }
    return hits.sort((a, b) => a.distance - b.distance);
  }
}

/** Copies and validates a Raycaster's settings; also validates a visibility query's ray policy at creation. */
function queryState(ray: Raycaster): QueryState {
  if (!(ray instanceof Raycaster))
    throw new TypeError('Snapshot intersection needs a Raycaster; create one and set its ray.');
  const o = ray.origin,
    d = ray.direction,
    origin: MutableVec3 = [o[0], o[1], o[2]],
    direction: MutableVec3 = [d[0], d[1], d[2]];
  if (
    !origin.every(Number.isFinite) ||
    !direction.every(Number.isFinite) ||
    Math.abs(Math.hypot(d[0], d[1], d[2]) - 1) > 1e-12
  )
    throw new RangeError('Snapshot rays need a finite origin and normalized direction; set them with Raycaster.set.');
  const { near, far, layers, side, firstHitOnly, filter } = ray;
  if (!Number.isFinite(near) || near < 0 || !(far >= near))
    throw new RangeError(
      'Snapshot ray distances need finite 0 <= near <= far (far may be Infinity); repair the Raycaster range.',
    );
  if (!Number.isInteger(layers) || layers < 0 || layers > 0xffffffff)
    throw new RangeError('Snapshot layers need an unsigned 32-bit mask; use 0xffffffff for every layer.');
  if (!SIDES.includes(side) || typeof firstHitOnly !== 'boolean' || (filter !== null && typeof filter !== 'function'))
    throw new TypeError(
      'Snapshot ray settings need a valid side, a boolean firstHitOnly and a function or null filter; repair the Raycaster.',
    );
  return { origin, direction, near, far, side, first: firstHitOnly, layers, filter };
}
