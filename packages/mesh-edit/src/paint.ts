import type { MutableVec3, Vec3 } from '@margoengine/math';
import { cross, dot, normalize, sub } from '@margoengine/math/vec3';
import { transformPoint } from './matrix.js';
import {
  finiteUVs,
  paintBarycentricUV,
  paintDilate,
  paintFaceKey,
  paintInterpolateUV,
  paintInwardUV,
  paintIslandIndex,
  paintTexel,
  paintWorldVertices,
  paintWrite,
  validatePaintScene,
  type PaintIsland,
  type PaintIslandIndex,
  type PaintRGBA,
  type PaintWeights,
  type PaintWriteObserver,
} from './paint-common.js';
import type { PaintAtlas, PaintFace, PaintHit, PaintObject, PaintOptions, PaintScene } from './paint-types.js';
import { newellNormal } from './polygon.js';

/** Top-left nearest-filtered UV-to-texel mapping, without a renderer or texture object. */
export const meshPaintTexel = paintTexel;

/**
 * Bytes of a `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` sRGB colour (the `#` is optional); alpha defaults to 255.
 * @throws TypeError for anything else.
 */
export function paintColorBytes(color: string): PaintRGBA {
  if (typeof color !== 'string') throw new TypeError('Paint color must be a hexadecimal string, such as #e89054.');
  let hex = color.replace(/^#/, '');
  if (/^[0-9a-f]{3,4}$/i.test(hex)) hex = [...hex].map((character) => character + character).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex))
    throw new TypeError('Paint color must be a hexadecimal string, such as #e89054.');
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
    hex.length === 8 ? parseInt(hex.slice(6), 16) : 255,
  ];
}

const finitePoint = (point: unknown): boolean =>
  Array.isArray(point) && point.length === 3 && point.every((value) => Number.isFinite(value));

function validateHit(hit: PaintHit): void {
  if (
    !hit ||
    typeof hit.objectId !== 'string' ||
    typeof hit.faceId !== 'string' ||
    !Number.isFinite(hit.distance) ||
    !Array.isArray(hit.uv) ||
    hit.uv.length !== 2 ||
    !Number.isFinite(hit.uv[0]) ||
    !Number.isFinite(hit.uv[1])
  )
    throw new TypeError('Paint hit needs objectId, faceId, a finite UV pair and distance; pass a surface hit.');
  for (const point of [hit.localPoint, hit.worldPoint])
    if (point !== undefined && !finitePoint(point))
      throw new TypeError('Paint hit points need finite XYZ triples; repair or omit localPoint/worldPoint.');
}

/**
 * Validate a dab completely before any write: brush size, options and colours.
 * @returns The primary bytes and, for dither with a visible primary, the secondary bytes.
 */
function paintColors(color: string, size: number, options: PaintOptions): [PaintRGBA, PaintRGBA | undefined] {
  if (!Number.isFinite(size) || size < 1 || size > 128)
    throw new RangeError('Brush size must be between 1 and 128 pixels; choose a supported size.');
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    (options.mode !== undefined && options.mode !== 'solid' && options.mode !== 'dither')
  )
    throw new TypeError("Paint options need mode 'solid' or 'dither'; fix the options object.");
  const rgba = paintColorBytes(color),
    secondary = options.secondaryColor === undefined ? undefined : paintColorBytes(options.secondaryColor);
  return [rgba, options.mode === 'dither' && rgba[3] !== 0 ? (secondary ?? paintColorBytes('#252c32')) : undefined];
}

/** Square dab clipped to the image, an optional island mask and excluded pixels; dither alternates on atlas parity. */
function brush(
  atlas: PaintAtlas,
  x: number,
  y: number,
  color: PaintRGBA,
  size: number,
  island: PaintIsland | undefined,
  secondary: PaintRGBA | undefined,
  excluded: ReadonlySet<number>,
  observe?: PaintWriteObserver,
): void {
  size = Math.round(size);
  const { width, height, pixels } = atlas,
    startX = Math.max(0, Math.floor(x) - Math.floor(size / 2)),
    startY = Math.max(0, Math.floor(y) - Math.floor(size / 2)),
    endX = Math.min(width, Math.floor(x) - Math.floor(size / 2) + size),
    endY = Math.min(height, Math.floor(y) - Math.floor(size / 2) + size);
  for (let by = startY; by < endY; by++)
    for (let bx = startX; bx < endX; bx++) {
      const pixel = by * width + bx;
      if ((!island || island.mask.has(pixel)) && !excluded.has(pixel))
        paintWrite(pixels, pixel, secondary && (bx + by) % 2 ? secondary : color, observe);
    }
}

/** Run `write` on an owned copy of the scene's atlas; the copy, or null when no byte changed. */
function onCopy(scene: PaintScene, write: (atlas: PaintAtlas, observe: PaintWriteObserver) => void): PaintAtlas | null {
  const atlas: PaintAtlas = {
    width: scene.texture.width,
    height: scene.texture.height,
    pixels: Array.from(scene.texture.pixels),
  };
  let changed = false;
  write(atlas, () => {
    changed = true;
  });
  return changed ? atlas : null;
}

/**
 * Paint a face-local square dab and its one-pixel halo, optionally mirrored; ineligible UV owners protect shared
 * pixels. Returns an owned atlas, or null when nothing changed.
 * @throws TypeError for a malformed scene, hit, colour or options, or a hit on a missing face; RangeError for size.
 */
export function paintMeshSurface(
  scene: PaintScene,
  hit: PaintHit,
  color: string,
  size = 1,
  symmetry = false,
  options: PaintOptions = {},
): PaintAtlas | null {
  validatePaintScene(scene);
  const index = paintIslandIndex(scene);
  return onCopy(scene, (atlas, observe) =>
    applyPreparedPaintSurface(scene, index, atlas, hit, color, size, symmetry, options, observe),
  );
}

/**
 * Fill whole faces and their one-pixel borders, with no brush-size limit. Uses the same shared-pixel protection
 * and atlas-aligned dither as surface paint. Targets are checked before any write; faces on objects that cannot be
 * painted are skipped and duplicates count once. Returns an owned atlas, or null when nothing changed.
 * @throws TypeError for an unknown target, a target without valid UVs, or bad colour or options; RangeError for
 * scene limits.
 */
export function fillMeshPaintFaces(
  scene: PaintScene,
  targets: readonly { objectId: string; faceId: string }[],
  color: string,
  options: PaintOptions = {},
): PaintAtlas | null {
  validatePaintScene(scene);
  return fillPreparedMeshPaintFaces(scene, targets, color, options);
}

/** Internal full-face fill for a validated owned scene and optional exact prepared raster index. */
export function fillPreparedMeshPaintFaces(
  scene: PaintScene,
  targets: readonly { objectId: string; faceId: string }[],
  color: string,
  options: PaintOptions = {},
  preparedIndex?: PaintIslandIndex,
): PaintAtlas | null {
  if (!Array.isArray(targets))
    throw new TypeError('Face fill needs a target array; supply existing object and face IDs.');
  const [rgba, secondary] = paintColors(color, 1, options),
    index = preparedIndex ?? paintIslandIndex(scene),
    objects = new Map(scene.objects.map((object) => [object.id, object])),
    faceIds = new Map(scene.objects.map((object) => [object.id, new Set(object.faces.map((face) => face.id))])),
    chosen = new Map<string, PaintIsland>();
  for (const target of targets) {
    if (!target || typeof target.objectId !== 'string' || typeof target.faceId !== 'string')
      throw new TypeError('Face fill targets need objectId and faceId strings; select existing faces.');
    const object = objects.get(target.objectId);
    if (!object || !faceIds.get(target.objectId)!.has(target.faceId))
      throw new TypeError('Face fill target no longer exists; select an existing object and face.');
    if (!object.canPaint) continue;
    const key = paintFaceKey(target.objectId, target.faceId),
      island = index.faces.get(key);
    if (!island) throw new TypeError('Face fill target has invalid UVs; allocate or repair its UV island first.');
    chosen.set(key, island);
  }
  if (!chosen.size) return null;
  return onCopy(scene, (atlas, observe) => {
    for (const island of chosen.values())
      for (const pixel of island.mask)
        if (!index.protected.has(pixel)) {
          const parity = ((pixel % atlas.width) + Math.floor(pixel / atlas.width)) % 2;
          paintWrite(atlas.pixels, pixel, secondary && parity ? secondary : rgba, observe);
        }
    for (const island of chosen.values()) paintDilate(atlas, island, index, observe);
  });
}

/** Shared validated write kernel; mirrored lookup completes before the first write. */
function applySurfaceTargets(
  scene: PaintScene,
  hit: PaintHit,
  index: PaintIslandIndex,
  atlas: PaintAtlas,
  rgba: PaintRGBA,
  size: number,
  symmetry: boolean,
  secondary: PaintRGBA | undefined,
  observe?: PaintWriteObserver,
): void {
  const hits = [hit],
    mirrored = symmetry ? mirrorHit(scene, hit) : null;
  if (mirrored) hits.push(mirrored);
  const touched = new Map<string, PaintIsland>(),
    targets: { island: PaintIsland; x: number; y: number }[] = [];
  for (const target of hits) {
    const island = index.faces.get(paintFaceKey(target.objectId, target.faceId));
    if (!island) continue;
    const [x, y] = paintTexel(paintInwardUV(island.face, target.uv), atlas.width, atlas.height);
    targets.push({ island, x, y });
  }
  for (const { island, x, y } of targets) {
    brush(atlas, x, y, rgba, size, island, secondary, index.protected, observe);
    touched.set(island.key, island);
  }
  for (const target of touched.values()) paintDilate(atlas, target, index, observe);
}

/** Internal owned-scene entry point; never revalidates or copies prepared geometry/image storage. */
export function applyPreparedPaintSurface(
  scene: PaintScene,
  index: PaintIslandIndex,
  atlas: PaintAtlas,
  hit: PaintHit,
  color: string,
  size: number,
  symmetry: boolean,
  options: PaintOptions,
  observe: PaintWriteObserver,
): void {
  validateHit(hit);
  if (typeof symmetry !== 'boolean') throw new TypeError('Paint symmetry must be a boolean; pass true or false.');
  const [rgba, secondary] = paintColors(color, size, options);
  const source = scene.objects.find((object) => object.id === hit.objectId);
  if (source && !source.canPaint) return;
  if (!index.faces.has(paintFaceKey(hit.objectId, hit.faceId)))
    throw new TypeError('Painted face no longer exists or has invalid UVs; repick the surface.');
  applySurfaceTargets(scene, hit, index, atlas, rgba, size, symmetry, secondary, observe);
}

/** Internal atlas entry point sharing the exact surface/free-canvas kernels. */
export function applyPreparedPaintAtlas(
  scene: PaintScene,
  index: PaintIslandIndex,
  atlas: PaintAtlas,
  x: number,
  y: number,
  color: string,
  size: number,
  options: PaintOptions,
  observe: PaintWriteObserver,
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new RangeError('Atlas paint coordinates must be finite pixels; pass a point on the atlas.');
  const [rgba, secondary] = paintColors(color, size, options),
    { width, height } = atlas;
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const pixel = Math.floor(y) * width + Math.floor(x),
    island = index.islands.find((candidate) => candidate.mask.has(pixel));
  if (!island) {
    brush(atlas, x, y, rgba, size, undefined, secondary, index.reserved, observe);
    return;
  }
  if (!scene.objects.find((object) => object.id === island.objectId)?.canPaint) return;
  const hit: PaintHit = {
    objectId: island.objectId,
    faceId: island.face.id,
    uv: [(Math.floor(x) + 0.5) / width, (Math.floor(y) + 0.5) / height],
    distance: 0,
  };
  applySurfaceTargets(scene, hit, index, atlas, rgba, size, false, secondary, observe);
}

/**
 * Paint a dab at atlas pixel coordinates. Over a face it uses the same face clipping and halo rules as surface
 * paint; on free canvas it never enters reserved island or padding pixels. Returns an owned atlas, or null.
 * @throws RangeError for non-finite coordinates or size; TypeError for a malformed scene, colour or options.
 */
export function paintMeshAtlas(
  scene: PaintScene,
  x: number,
  y: number,
  color: string,
  size = 1,
  options: PaintOptions = {},
): PaintAtlas | null {
  validatePaintScene(scene);
  const index = paintIslandIndex(scene);
  return onCopy(scene, (atlas, observe) =>
    applyPreparedPaintAtlas(scene, index, atlas, x, y, color, size, options, observe),
  );
}

function barycentric3(point: Vec3, a: Vec3, b: Vec3, c: Vec3): PaintWeights | null {
  const first = sub(b, a),
    second = sub(c, a),
    relative = sub(point, a),
    normal = cross(first, second);
  const length = Math.hypot(...normal);
  if (
    length < 1e-12 ||
    Math.abs(dot(normal, relative)) / length > Math.max(1, Math.hypot(...first), Math.hypot(...second)) * 1e-5
  )
    return null;
  const d00 = dot(first, first),
    d01 = dot(first, second),
    d11 = dot(second, second),
    d20 = dot(relative, first),
    d21 = dot(relative, second);
  const denominator = d00 * d11 - d01 * d01;
  if (Math.abs(denominator) < 1e-15) return null;
  const u = (d11 * d20 - d01 * d21) / denominator,
    v = (d00 * d21 - d01 * d20) / denominator,
    w = 1 - u - v,
    inside = (value: number) => value >= -1e-5 && value <= 1.00001;
  return inside(w) && inside(u) && inside(v) ? [w, u, v] : null;
}

const interpolate3 = (points: readonly Vec3[], weights: PaintWeights): MutableVec3 => [
  points[0][0] * weights[0] + points[1][0] * weights[1] + points[2][0] * weights[2],
  points[0][1] * weights[0] + points[1][1] * weights[1] + points[2][1] * weights[2],
  points[0][2] * weights[0] + points[1][2] * weights[1] + points[2][2] * weights[2],
];
type PointHit = { face: PaintFace; uv: [number, number]; localPoint: MutableVec3; score: number };

/** A face with one finite UV pair per corner, as surface lookups need. */
const strictUVs = (face: PaintFace): boolean => face.uv.length === face.vertices.length && finiteUVs(face);

/** The fan triangle containing `point` whose normal best matches `desiredNormal`, with its UV and local point. */
function findPointOnMesh(
  mesh: PaintObject,
  point: MutableVec3,
  desiredNormal: Vec3,
  positions = mesh.vertices,
): PointHit | null {
  let best: PointHit | null = null;
  for (const face of mesh.faces) {
    if (!strictUVs(face)) continue;
    for (let i = 1; i < face.vertices.length - 1; i++) {
      const indices = [face.vertices[0], face.vertices[i], face.vertices[i + 1]],
        triangle = indices.map((index) => positions[index]),
        weights = barycentric3(point, triangle[0], triangle[1], triangle[2]);
      if (!weights) continue;
      const score = dot(normalize(cross(sub(triangle[1], triangle[0]), sub(triangle[2], triangle[0]))), desiredNormal);
      if (best && best.score >= score) continue;
      best = {
        face,
        uv: paintInwardUV(face, paintInterpolateUV([face.uv[0], face.uv[i], face.uv[i + 1]], weights)),
        localPoint:
          positions === mesh.vertices
            ? [...point]
            : interpolate3(
                indices.map((index) => mesh.vertices[index]),
                weights,
              ),
        score,
      };
    }
  }
  return best;
}

const mirrorX = (point: Vec3): MutableVec3 => [-point[0], point[1], point[2]];

function mirrorHit(scene: PaintScene, hit: PaintHit): PaintHit | null {
  const mesh = scene.objects.find((object) => object.id === hit.objectId),
    face = mesh?.faces.find((candidate) => candidate.id === hit.faceId);
  if (!mesh || !mesh.canPaint || !face || !strictUVs(face)) return null;
  let local = hit.localPoint;
  for (let i = 1; !local && i < face.vertices.length - 1; i++) {
    const weights = paintBarycentricUV(hit.uv, face.uv[0], face.uv[i], face.uv[i + 1]);
    if (weights)
      local = interpolate3(
        [mesh.vertices[face.vertices[0]], mesh.vertices[face.vertices[i]], mesh.vertices[face.vertices[i + 1]]],
        weights,
      );
  }
  if (!local) return null;
  // Object-local X first: a symmetric limb on the same object, unless it lands on the hit's own texel.
  const reflected = mirrorX(local),
    candidate = mesh.canMirror
      ? findPointOnMesh(mesh, reflected, mirrorX(newellNormal(face.vertices.map((index) => mesh.vertices[index]))))
      : null,
    { width, height } = scene.texture,
    hitTexel = paintTexel(hit.uv, width, height),
    candidateTexel = candidate && paintTexel(candidate.uv, width, height);
  if (candidate && (candidateTexel![0] !== hitTexel[0] || candidateTexel![1] !== hitTexel[1]))
    return localMirror(mesh, hit, candidate, reflected);
  // Then world X: a separately modelled limb on another eligible object.
  const world = hit.worldPoint ?? transformPoint(mesh.worldMatrix, local, 'Paint world matrix'),
    reflectedWorld = mirrorX(world),
    worldPoints = paintWorldVertices(mesh),
    sourceNormal = mirrorX(newellNormal(face.vertices.map((index) => worldPoints[index])));
  for (const object of scene.objects) {
    if (object.id === mesh.id || !object.canMirror) continue;
    const target = findPointOnMesh(object, reflectedWorld, sourceNormal, paintWorldVertices(object));
    if (target)
      return {
        objectId: object.id,
        faceId: target.face.id,
        uv: [...target.uv],
        distance: hit.distance,
        localPoint: [...target.localPoint],
        worldPoint: [...reflectedWorld],
      };
  }
  return candidate ? localMirror(mesh, hit, candidate, reflected) : null;
}

const localMirror = (mesh: PaintObject, hit: PaintHit, candidate: PointHit, reflected: MutableVec3): PaintHit => ({
  objectId: hit.objectId,
  faceId: candidate.face.id,
  uv: [...candidate.uv],
  distance: hit.distance,
  localPoint: [...reflected],
  worldPoint: transformPoint(mesh.worldMatrix, reflected, 'Paint world matrix'),
});

/**
 * The mirror image of a paint hit, or null when there is none. Object-local X is tried first (a symmetric part of
 * the same object, unless it lands on the same texel), then world X on other objects that allow mirroring.
 * @throws TypeError for a bad scene or hit.
 */
export function mirrorMeshPaintHit(scene: PaintScene, hit: PaintHit): PaintHit | null {
  validatePaintScene(scene);
  validateHit(hit);
  return mirrorHit(scene, hit);
}
