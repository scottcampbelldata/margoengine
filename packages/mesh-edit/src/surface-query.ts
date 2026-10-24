/// <reference lib="esnext.disposable" preserve="true" />
import type { BVHHit } from '@margoengine/bvh/tree';
import { MargoError, type MutableVec2, type MutableVec3, type Vec3 } from '@margoengine/math';
import { nearestTexel, paintTextureSize } from './paint-common.js';
import type { PaintHit, PaintTexture } from './paint-types.js';
import {
  captureSurfaceSource,
  copySurfaceTriangle,
  type SurfaceSource,
  type SurfaceTriangle,
  type CapturedSurface,
} from './surface-source.js';

/** A world-space ray. `direction` must be normalized. */
export interface SurfaceRay {
  origin: ArrayLike<number>;
  direction: ArrayLike<number>;
}

/** Options for {@link MeshSurfaceQuery.intersect}. Visibility and which helpers count are up to the caller. */
export interface SurfaceQueryOptions {
  /** Order of the hits: by `'distance'` (default) or in `'source'` order (capture order, then triangle order). */
  order?: 'distance' | 'source';
  /** Only these captured objects. An unknown ID throws; an empty list finds nothing. */
  objectIds?: readonly string[];
  /** Hits must be farther than this; default 0.00001. */
  near?: number;
  /** Hits may be at most this far; default Infinity. */
  far?: number;
  /** Return only the nearest accepted hit (on a tie, the first in source order). Default false. */
  firstHitOnly?: boolean;
  /** Atlas for alpha tests and `texel`. Read only during this call, so a live paint atlas needs no recapture. */
  texture?: PaintTexture;
  /** Keep hits on transparent texels. Default false. Without a texture every hit is kept. */
  includeTransparent?: boolean;
  /** Lowest alpha byte that counts as opaque; default 6. Only the alpha bytes actually sampled are checked. */
  alphaThreshold?: number;
}

/** A surface hit, ready to pass to the painter. The UV is clamped inside the face's UV bounds. */
export interface SurfaceHit extends PaintHit {
  triangleIndex: number;
  barycoord: MutableVec3;
  localPoint: MutableVec3;
  worldPoint: MutableVec3;
  /** `origin + direction * distance`, for code that works along the ray. */
  rayPoint: MutableVec3;
  /** The texel under `uv`, when a texture was given. */
  texel?: MutableVec2;
}

/** Copies of every captured object's world vertices and triangles; triangle corners point into `objects[].vertices`. */
export interface SurfaceFrame {
  objects: { objectId: string; vertices: MutableVec3[] }[];
  triangles: SurfaceTriangle[];
}

/** Like {@link SurfaceFrame}, but triangles carry only IDs and world corners. */
export interface SurfaceWorldFrame {
  objects: { objectId: string; vertices: MutableVec3[] }[];
  triangles: Pick<SurfaceTriangle, 'objectId' | 'faceId' | 'triangleIndex' | 'a' | 'b' | 'c'>[];
}

/**
 * Ray picking on editable meshes, in float64, with UVs and alpha.
 * The constructor copies each source's polygons, triangulation and world matrix and builds one BVH per source;
 * capture again after topology, UV or transform changes. Rays hit both sides of each triangle. Hits sort by
 * distance, then by source and triangle order. Everything returned is a copy. This queries the editable source, not
 * a posed or rendered frame.
 * @throws TypeError for a bad source, ray, option, texture or triangulation; RangeError for bad distances, alpha
 * threshold or overflowing transforms; MargoError `state` when called again from inside a texture getter, and
 * `disposed` after dispose.
 */
export class MeshSurfaceQuery {
  #sources: CapturedSurface[] | null;
  #busy = false;

  constructor(sources: readonly SurfaceSource[]) {
    if (!Array.isArray(sources))
      throw new TypeError('Surface query needs an ordered source array; supply editable sources.');
    const captured = Array.from(sources, captureSurfaceSource),
      ids = new Set<string>();
    for (const s of captured) {
      if (ids.has(s.objectId))
        throw new TypeError('Surface query object IDs must be unique; assign distinct source identities.');
      ids.add(s.objectId);
    }
    this.#sources = captured;
  }

  /** Whether {@link MeshSurfaceQuery.dispose} has been called. */
  get disposed(): boolean {
    return this.#sources === null;
  }

  #open(): CapturedSurface[] {
    if (!this.#sources) throw new MargoError('disposed', 'Surface query is disposed; capture a new MeshSurfaceQuery.');
    return this.#sources;
  }

  /** Copies of every captured triangle, in source then triangle order. */
  triangles(): SurfaceTriangle[] {
    return this.#open().flatMap((s) => s.triangles.map((t) => copySurfaceTriangle(t)));
  }

  /** Copies of all world vertices and triangles, with triangle corners shared within the result. */
  frame(): SurfaceFrame {
    const triangles: SurfaceTriangle[] = [];
    const objects = this.#open().map((s) => {
      const { vertices, points } = copyWorldPoints(s);
      for (const triangle of s.triangles) triangles.push(copySurfaceTriangle(triangle, points));
      return { objectId: s.objectId, vertices };
    });
    return { objects, triangles };
  }

  /** World vertices and triangle corners only, for overlays. */
  worldFrame(): SurfaceWorldFrame {
    const triangles: SurfaceWorldFrame['triangles'] = [];
    const objects = this.#open().map((s) => {
      const { vertices, points } = copyWorldPoints(s);
      for (const t of s.triangles)
        triangles.push({
          objectId: t.objectId,
          faceId: t.faceId,
          triangleIndex: t.triangleIndex,
          a: points.get(t.a)!,
          b: points.get(t.b)!,
          c: points.get(t.c)!,
        });
      return { objectId: s.objectId, vertices };
    });
    return { objects, triangles };
  }

  /** Copies of one object's world vertices, loose ones included. An unknown ID throws. */
  worldVertices(objectId: string): MutableVec3[] {
    const source = this.#open().find((s) => s.objectId === objectId);
    if (!source) throw new TypeError('Surface objectId is not captured; use a captured source identity.');
    return source.points.map((p) => [...p]);
  }

  /** Every surface hit along the ray (or the nearest, with `firstHitOnly`), skipping transparent texels. */
  intersect(input: SurfaceRay, options: SurfaceQueryOptions = {}): SurfaceHit[] {
    this.#open();
    if (this.#busy)
      throw new MargoError('state', 'Surface query is already running; finish the current query before reentry.');
    this.#busy = true;
    try {
      if (!input || !input.origin || !input.direction || !options || typeof options !== 'object')
        throw new TypeError('Surface query needs a finite normalized ray and options object; supply both ray vectors.');
      const origin = Array.from(input.origin),
        direction = Array.from(input.direction);
      if (
        origin.length !== 3 ||
        direction.length !== 3 ||
        !origin.every(Number.isFinite) ||
        !direction.every(Number.isFinite) ||
        Math.abs(Math.hypot(...direction) - 1) > 1e-10
      )
        throw new TypeError('Surface ray needs finite XYZ origin and normalized direction; normalize before querying.');
      const {
        near = 1e-5,
        far = Infinity,
        firstHitOnly = false,
        includeTransparent = false,
        texture,
        alphaThreshold = 6,
        objectIds,
        order = 'distance',
      } = options;
      if (!Number.isFinite(near) || near < 0 || !(far >= near) || (far !== Infinity && !Number.isFinite(far)))
        throw new RangeError('Surface distances need finite near >= 0 and far >= near; correct the distance range.');
      if (typeof firstHitOnly !== 'boolean' || typeof includeTransparent !== 'boolean')
        throw new TypeError('Surface firstHitOnly/includeTransparent must be booleans; supply explicit query policy.');
      if (!Number.isInteger(alphaThreshold) || alphaThreshold < 0 || alphaThreshold > 255)
        throw new RangeError('Surface alphaThreshold needs a byte from 0 to 255; choose a valid cutoff.');
      if (order !== 'distance' && order !== 'source')
        throw new TypeError('Surface order must be distance or source; choose an explicit hit ordering.');
      if (objectIds !== undefined && (!Array.isArray(objectIds) || !objectIds.every((id) => typeof id === 'string')))
        throw new TypeError('Surface objectIds needs a string array; supply captured source identities.');
      const ids = objectIds === undefined ? null : new Set(objectIds),
        sources = this.#open();
      if (ids && Array.from(ids).some((id) => !sources.some((s) => s.objectId === id)))
        throw new TypeError('Surface objectIds contains an uncaptured identity; recapture or correct the selection.');
      const image = texture === undefined ? null : captureTexture(texture);
      this.#open();
      const ray = { origin, direction },
        hits: SurfaceHit[] = [];
      let best: SurfaceHit | null = null;
      for (const source of sources) {
        if (!source.bvh || (ids && !ids.has(source.objectId))) continue;
        // The BVH's near bound is inclusive and ours is strict, so hits at exactly `near` are dropped here.
        const candidates = source.bvh.raycast(ray, { near, far: best ? best.distance : far, side: 'double' });
        if (order === 'source' && !firstHitOnly) candidates.sort((a, b) => a.faceIndex - b.faceIndex);
        for (const candidate of candidates) {
          if (!(candidate.distance > near)) continue;
          const hit = this.#hit(
            source.triangles[candidate.faceIndex],
            candidate,
            origin,
            direction,
            image,
            includeTransparent,
            alphaThreshold,
          );
          if (!hit) continue;
          if (!firstHitOnly) hits.push(hit);
          // Candidates are sorted by distance, so the first accepted one is this source's nearest; an earlier source
          // keeps an equal distance.
          else if (!best || hit.distance < best.distance) best = hit;
          if (firstHitOnly) break;
        }
      }
      this.#open();
      if (firstHitOnly) return best ? [best] : [];
      return order === 'source' ? hits : hits.sort((a, b) => a.distance - b.distance);
    } finally {
      this.#busy = false;
    }
  }

  /** The hit for one BVH candidate, or null when the texture is transparent there. */
  #hit(
    triangle: SurfaceTriangle,
    candidate: BVHHit,
    origin: readonly number[],
    direction: readonly number[],
    image: PaintTexture | null,
    includeTransparent: boolean,
    alphaThreshold: number,
  ): SurfaceHit | null {
    const [w, u, v] = candidate.barycoord,
      { distance } = candidate,
      [ua, ub, uc] = triangle.uv,
      bounds = triangle.bounds,
      uv: MutableVec2 = [ua[0] * w + ub[0] * u + uc[0] * v, ua[1] * w + ub[1] * u + uc[1] * v];
    // Keep the UV inside the face's UV bounds, pulling the maximum edges in so they stay on the face's texels.
    for (let axis = 0; axis < 2; axis++)
      if (bounds[axis + 2] > bounds[axis])
        uv[axis] = Math.max(bounds[axis], Math.min(bounds[axis + 2] - 1e-9, uv[axis]));
    const texel = image ? nearestTexel(uv[0], uv[1], image.width, image.height) : undefined;
    if (texel && !includeTransparent) {
      const alpha = image!.pixels[(texel[1] * image!.width + texel[0]) * 4 + 3];
      this.#open();
      if (!Number.isInteger(alpha) || alpha < 0 || alpha > 255)
        throw new TypeError('Surface sampled alpha is not an RGBA8 byte; repair the texture before querying.');
      if (alpha < alphaThreshold) return null;
    }
    const hit: SurfaceHit = {
      objectId: triangle.objectId,
      faceId: triangle.faceId,
      triangleIndex: triangle.triangleIndex,
      distance,
      barycoord: [w, u, v],
      uv,
      localPoint: blend(triangle.local[0], triangle.local[1], triangle.local[2], w, u, v),
      worldPoint: blend(triangle.a, triangle.b, triangle.c, w, u, v),
      rayPoint: [
        origin[0] + direction[0] * distance,
        origin[1] + direction[1] * distance,
        origin[2] + direction[2] * distance,
      ],
    };
    if (texel) hit.texel = texel;
    return hit;
  }

  /** Release everything captured. Safe to call more than once, even from inside a texture getter. */
  dispose(): void {
    this.#sources = null;
  }

  /** Same as `dispose()`, for `using` declarations. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

function copyWorldPoints(source: CapturedSurface): { vertices: MutableVec3[]; points: Map<MutableVec3, MutableVec3> } {
  const vertices: MutableVec3[] = [],
    points = new Map<MutableVec3, MutableVec3>();
  for (const point of source.points) {
    const copy: MutableVec3 = [...point];
    vertices.push(copy);
    points.set(point, copy);
  }
  return { vertices, points };
}

/** Barycentric blend `a * w + b * u + c * v`. */
const blend = (a: Vec3, b: Vec3, c: Vec3, w: number, u: number, v: number): MutableVec3 => [
  a[0] * w + b[0] * u + c[0] * v,
  a[1] * w + b[1] * u + c[1] * v,
  a[2] * w + b[2] * u + c[2] * v,
];

function captureTexture(texture: PaintTexture): PaintTexture {
  if (!texture || typeof texture !== 'object')
    throw new TypeError('Surface texture needs RGBA8 image data; supply width, height and pixels.');
  const { width, height, pixels } = texture;
  paintTextureSize(width, height);
  if (!pixels || pixels.length !== width * height * 4)
    throw new TypeError('Surface texture needs width*height*4 RGBA8 channels; repair the image storage.');
  return { width, height, pixels };
}
