// The `points` entry: picking points and sprites in the same Raycaster call as meshes. `PointRaycaster` is a Raycaster
// whose intersect calls also take point clouds and sprite batches, and finds those of a PointsPlugin by itself. Shapes
// are structural: this module has no dependency on the points package.
import type { Engine, Mesh } from '@margoengine/core';
import type { MutableVec3 } from '@margoengine/math';
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { hiddenInTree } from '../../shared/visibility.js';
import { viewMatrix } from '../../shared/view.js';
import { transformPoint } from './math.js';
import {
  getMeshLayers,
  localRay,
  Raycaster,
  type IntersectOptions,
  type ModelLike,
  type RaycastRuntime,
  type RaycasterHit,
} from './raycaster.js';

/** What every pickable material has. */
interface PickableMaterial {
  readonly clippingPlanes: readonly (readonly number[])[];
  readonly clipIntersection: boolean;
}
/** The fields of a @margoengine/points `PointCloud` that picking reads. */
export interface PickablePoints {
  readonly positions: Float32Array;
  readonly sizes: Float32Array | null;
  readonly visible: boolean;
  readonly matrix: Float32Array;
  readonly attachedMesh: Mesh | null;
  readonly blocks: {
    readonly order: Uint32Array;
    readonly starts: Uint32Array;
    readonly counts: Uint32Array;
    readonly bounds: Float32Array;
    readonly length: number;
  };
  readonly material: PickableMaterial & {
    readonly size: number;
    readonly sizeUnits: 'pixels' | 'world';
    readonly minPixelSize: number;
    readonly maxPixelSize: number;
  };
}
/** The fields of a @margoengine/points `SpriteBatch` that picking reads. */
export interface PickableSprites {
  readonly count: number;
  /** 16 floats a sprite: position xyz, rotation, size wh, center xy, uv rect, linear RGBA. */
  readonly data: Float32Array;
  readonly visible: boolean;
  readonly matrix: Float32Array;
  readonly attachedMesh: Mesh | null;
  readonly material: PickableMaterial & { readonly rotation: number; readonly sizeUnits: 'pixels' | 'world' };
}
/** A hit from a {@link PointRaycaster}. Mesh hits have none of the three fields below. */
export interface PointRaycasterHit extends RaycasterHit {
  /** Point and sprite hits: the cloud or batch. `mesh` is the mesh it follows, else {@link UNATTACHED}. */
  target?: PickablePoints | PickableSprites;
  /** Index of the point or sprite in `target`. */
  index?: number;
  /** World distance from the ray to the point's centre; 0 for a sprite the ray crosses. */
  offset?: number;
}
/** The `mesh` of a hit on a cloud or batch that follows no mesh. Read `hit.target` for what was hit. */
export const UNATTACHED = Object.freeze({ id: -1 }) as unknown as Mesh;

const SPRITE_STRIDE = 16;
const isPoints = (value: object): value is PickablePoints => 'positions' in value && 'blocks' in value;
const isSprites = (value: object): value is PickableSprites => 'data' in value && 'attachedMesh' in value;

interface PickView {
  /** View-projection matrix. */
  matrix: ArrayLike<number>;
  /** Drawing-buffer pixels per world unit at clip w 1. */
  focal: number;
  /** Drawing-buffer pixels per CSS pixel. */
  ratio: number;
  right: MutableVec3;
  up: MutableVec3;
  back: MutableVec3;
}
interface PluginLike {
  pointClouds?: Iterable<PickablePoints>;
  spriteBatches?: Iterable<PickableSprites>;
}

function pickView(runtime: RaycastRuntime): PickView {
  const { canvas, camera } = runtime;
  camera.update(canvas.width / canvas.height, runtime.backend === 'webgpu');
  const m = camera.matrix,
    v = viewMatrix(new Float32Array(16), camera);
  return {
    matrix: m,
    focal: 0.5 * canvas.height * Math.hypot(m[1], m[5], m[9]),
    ratio: canvas.height / (canvas.clientHeight || canvas.height),
    right: [v[0], v[4], v[8]],
    up: [v[1], v[5], v[9]],
    back: [v[2], v[6], v[10]],
  };
}

function clipped(material: PickableMaterial, p: ArrayLike<number>): boolean {
  const planes = material.clippingPlanes;
  if (!planes.length) return false;
  let behind = 0;
  for (const q of planes) if (q[0] * p[0] + q[1] * p[1] + q[2] * p[2] + q[3] < 0) behind++;
  return material.clipIntersection ? behind === planes.length : behind > 0;
}

const clipW = (m: ArrayLike<number>, p: ArrayLike<number>): number => m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];

/**
 * A Raycaster that also hits points and sprites. `intersectEngine` adds the clouds and batches of the engine's
 * PointsPlugin; `intersectObjects` takes them in its list beside meshes and models. Hits come sorted together, and
 * `near`, `far`, `layers` and `filter` (through the followed mesh; a cloud that follows none has no layers and no filter)
 * and `firstHitOnly` apply to them all.
 */
export class PointRaycaster extends Raycaster {
  /**
   * How near the ray must pass a point's centre to hit it, or how far beyond a sprite's edge. A point drawn larger than
   * this hits across its drawn size. Default 3, in `thresholdUnits`.
   */
  threshold = 3;
  /** 'pixels' (CSS pixels, default) or 'world'. */
  thresholdUnits: 'pixels' | 'world' = 'pixels';

  override intersectEngine(engine: Engine, options?: IntersectOptions): PointRaycasterHit[] {
    const hits = super.intersectEngine(engine, options),
      targets: (PickablePoints | PickableSprites)[] = [];
    for (const plugin of (engine as unknown as { plugins?: Map<string, PluginLike> }).plugins?.values() ?? [])
      targets.push(...(plugin.pointClouds ?? []), ...(plugin.spriteBatches ?? []));
    return this.merge(hits, targets, engine);
  }

  override intersectObjects(
    engine: Engine,
    objects: Iterable<Mesh | ModelLike | PickablePoints | PickableSprites>,
    options?: IntersectOptions,
  ): PointRaycasterHit[] {
    const rest: (Mesh | ModelLike)[] = [],
      targets: (PickablePoints | PickableSprites)[] = [];
    for (const object of new Set(objects))
      if (isPoints(object) || isSprites(object)) targets.push(object);
      else rest.push(object);
    return this.merge(super.intersectObjects(engine, rest, options), targets, engine);
  }

  private merge(
    hits: PointRaycasterHit[],
    targets: readonly (PickablePoints | PickableSprites)[],
    engine: Engine,
  ): PointRaycasterHit[] {
    if (!targets.length) return hits;
    if (!(this.threshold >= 0) || !Number.isFinite(this.threshold))
      throw new RangeError('Invalid threshold; pass a finite number of at least 0.');
    if (this.thresholdUnits !== 'pixels' && this.thresholdUnits !== 'world')
      throw new TypeError("Invalid thresholdUnits; use 'pixels' or 'world'.");
    const runtime = engine as unknown as RaycastRuntime,
      view = pickView(runtime);
    for (const target of targets) {
      const world = this.followed(runtime, target);
      if (!world) continue;
      if (isPoints(target)) this.points(target, world, view, hits);
      else this.sprites(target, world, view, hits);
    }
    hits.sort((a, b) => a.distance - b.distance || (a.index ?? 0) - (b.index ?? 0));
    if (this.firstHitOnly) hits.length = Math.min(hits.length, 1);
    return hits;
  }

  // World matrix of a target that can be hit, else null.
  private followed(runtime: RaycastRuntime, target: PickablePoints | PickableSprites): ArrayLike<number> | null {
    if (!target.visible) return null;
    const mesh = target.attachedMesh;
    if (!mesh) return target.matrix;
    const id = (mesh as unknown as { id: number }).id;
    if (runtime.meshes.get(id) !== (mesh as unknown) || hiddenInTree(runtime.store, id)) return null;
    if (!(getMeshLayers(mesh) & this.layers) || (this.filter && !this.filter(mesh))) return null;
    return runtime.store.matrices.subarray(id * 16, id * 16 + 16);
  }

  /** World radius of the threshold at clip w `w`. */
  private reach(view: PickView, w: number): number {
    return this.thresholdUnits === 'world' ? this.threshold : (this.threshold * view.ratio * w) / view.focal;
  }

  private points(cloud: PickablePoints, world: ArrayLike<number>, view: PickView, out: PointRaycasterHit[]): void {
    const inverse = new Float64Array(16);
    if (!invertMatrix(world, inverse)) return;
    const { positions, sizes, material, blocks } = cloud,
      { size, sizeUnits, minPixelSize, maxPixelSize } = material,
      o = this.origin,
      d = this.direction,
      local = new Float64Array(3),
      direction = [0, 0, 0],
      p: MutableVec3 = [0, 0, 0],
      // Clip w of a local point: a linear form, whose peak over a box sits at a corner picked per axis by sign.
      clip = multiplyMatrices(view.matrix, world, new Float64Array(16)),
      stretch = Math.hypot(...inverse.subarray(0, 3), ...inverse.subarray(4, 7), ...inverse.subarray(8, 11)),
      { focal } = view;
    localRay(inverse, o, d, local, direction);
    let largest = size;
    if (sizes) for (let i = 0; i < sizes.length; i++) if (sizes[i] * size > largest) largest = sizes[i] * size;
    // World radius a point of diameter `value` is drawn at, at clip w `w`.
    const drawn = (value: number, w: number): number => {
      const px = sizeUnits === 'world' ? (value * focal) / w : value;
      return (0.5 * Math.min(Math.max(px, minPixelSize), maxPixelSize) * w) / focal;
    };
    const found: PointRaycasterHit[] = [];
    for (let block = 0; block < blocks.length; block++) {
      const b = block * 6,
        bounds = blocks.bounds,
        deepest =
          clip[15] +
          (clip[3] > 0 ? clip[3] * bounds[b + 3] : clip[3] * bounds[b]) +
          (clip[7] > 0 ? clip[7] * bounds[b + 4] : clip[7] * bounds[b + 1]) +
          (clip[11] > 0 ? clip[11] * bounds[b + 5] : clip[11] * bounds[b + 2]);
      if (!(deepest > 1e-6)) continue;
      const most = Math.max(sizeUnits === 'world' ? largest / 2 : 0, drawn(largest, deepest), this.reach(view, deepest)),
        pad = most * stretch * (1 + 1e-5);
      if (!crosses(bounds, b, local, direction, this.near - most, this.far + most, pad)) continue;
      for (let slot = blocks.starts[block], end = slot + blocks.counts[block]; slot < end; slot++) {
        const index = blocks.order[slot],
          at = index * 3;
        transformPoint(world, positions[at], positions[at + 1], positions[at + 2], p);
        const vx = p[0] - o[0],
          vy = p[1] - o[1],
          vz = p[2] - o[2],
          along = vx * d[0] + vy * d[1] + vz * d[2],
          offset = Math.sqrt(Math.max(vx * vx + vy * vy + vz * vz - along * along, 0));
        if (offset > most || along < this.near || along > this.far) continue;
        const w = clipW(view.matrix, p);
        if (!(w > 1e-6)) continue;
        if (offset > Math.max(drawn(size * (sizes ? sizes[index] : 1), w), this.reach(view, w))) continue;
        if (clipped(material, p)) continue;
        found.push(hit(cloud, index, along, p.slice() as MutableVec3, offset, d, [positions[at], positions[at + 1], positions[at + 2]]));
      }
    }
    out.push(...found);
  }

  private sprites(batch: PickableSprites, world: ArrayLike<number>, view: PickView, out: PointRaycasterHit[]): void {
    const { data, material } = batch,
      { right, up, back, focal } = view,
      o = this.origin,
      d = this.direction,
      facing = d[0] * back[0] + d[1] * back[1] + d[2] * back[2],
      pixels = material.sizeUnits === 'pixels',
      p: MutableVec3 = [0, 0, 0];
    if (!facing) return;
    for (let index = 0; index < batch.count; index++) {
      const s = index * SPRITE_STRIDE;
      transformPoint(world, data[s], data[s + 1], data[s + 2], p);
      const w = clipW(view.matrix, p);
      if (!(w > 1e-6)) continue;
      const vx = p[0] - o[0],
        vy = p[1] - o[1],
        vz = p[2] - o[2],
        t = (vx * back[0] + vy * back[1] + vz * back[2]) / facing;
      if (t < this.near || t > this.far) continue;
      // Where the ray crosses the sprite's plane, in the sprite's own axes and units.
      const unit = pixels ? w / focal : 1,
        hx = o[0] + t * d[0] - p[0],
        hy = o[1] + t * d[1] - p[1],
        hz = o[2] + t * d[2] - p[2],
        x = (hx * right[0] + hy * right[1] + hz * right[2]) / unit,
        y = (hx * up[0] + hy * up[1] + hz * up[2]) / unit,
        angle = data[s + 3] + material.rotation,
        cos = Math.cos(angle),
        sin = Math.sin(angle),
        width = data[s + 4],
        height = data[s + 5],
        u = (x * cos + y * sin) / width + data[s + 6],
        v = (y * cos - x * sin) / height + data[s + 7],
        grow = this.reach(view, w) / unit,
        gu = grow / width,
        gv = grow / height;
      if (!(width > 0 && height > 0) || u < -gu || u > 1 + gu || v < -gv || v > 1 + gv) continue;
      const point: MutableVec3 = [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
      if (clipped(material, point)) continue;
      const result = hit(batch, index, t, point, 0, d, [data[s], data[s + 1], data[s + 2]]),
        cu = Math.min(Math.max(u, 0), 1),
        cv = Math.min(Math.max(v, 0), 1);
      result.uv = [data[s + 8] + (data[s + 10] - data[s + 8]) * cu, data[s + 9] + (data[s + 11] - data[s + 9]) * (1 - cv)];
      out.push(result);
    }
  }
}

function hit(
  target: PickablePoints | PickableSprites,
  index: number,
  distance: number,
  point: MutableVec3,
  offset: number,
  d: ArrayLike<number>,
  localPoint: MutableVec3,
): PointRaycasterHit {
  const normal: MutableVec3 = [-d[0], -d[1], -d[2]];
  return {
    mesh: target.attachedMesh ?? UNATTACHED,
    distance,
    point,
    normal,
    faceNormal: normal.slice() as MutableVec3,
    faceIndex: -1,
    barycoord: [0, 0, 0],
    frontFace: true,
    localPoint,
    target,
    index,
    offset,
  };
}

/** Whether a local ray, t in [near, far], crosses box `b` of `f` grown by `pad`. */
function crosses(
  f: ArrayLike<number>,
  b: number,
  o: ArrayLike<number>,
  d: ArrayLike<number>,
  near: number,
  far: number,
  pad: number,
): boolean {
  let t0 = near,
    t1 = far;
  for (let k = 0; k < 3; k++) {
    const low = f[b + k] - pad,
      high = f[b + k + 3] + pad;
    if (d[k] === 0) {
      if (o[k] < low || o[k] > high) return false;
      continue;
    }
    const a = (low - o[k]) / d[k],
      c = (high - o[k]) / d[k];
    t0 = Math.max(t0, Math.min(a, c));
    t1 = Math.min(t1, Math.max(a, c));
  }
  return t0 <= t1;
}
