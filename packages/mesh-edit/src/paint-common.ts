import type { MutableVec2, MutableVec3 } from '@margoengine/math';
import { affineMatrix, transformPoints } from './matrix.js';
import type { PaintAtlas, PaintFace, PaintObject, PaintScene, PaintTexture } from './paint-types.js';
import { assertPolygonMesh } from './polygon.js';

/** Internal RGBA byte tuple shared by pure UV and paint operations. */
export type PaintRGBA = [number, number, number, number];
/** Internal barycentric tuple; float64 arithmetic is retained until texel selection. */
export type PaintWeights = [number, number, number];
/** One face's conservative raster coverage; shared-raster keys are not topology island identities. */
export interface PaintIsland {
  objectId: string;
  face: PaintFace;
  mask: Set<number>;
  key: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
/** Internal raster index; public commands never expose cached coverage or borrowed face references. */
export interface PaintIslandIndex {
  islands: PaintIsland[];
  faces: Map<string, PaintIsland>;
  padding: Map<number, Set<string>>;
  protected: Set<number>;
  reserved: Set<number>;
  halos: Map<string, [number, number][]>;
}
const islandCache = new WeakMap<
  PaintObject[],
  {
    signature: string;
    islands: PaintIsland[];
    padding: Map<number, Set<string>>;
  }
>();

/** Collision-free object/face identity within an independently validated scene. */
export const paintFaceKey = (objectId: string, faceId: string): string => JSON.stringify([objectId, faceId]);

/**
 * Check RGBA8 image dimensions before any storage is read or copied.
 * @throws RangeError unless both are positive safe integers with at most 16777216 texels.
 */
export function paintTextureSize(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 16_777_216
  )
    throw new RangeError(
      'Paint texture needs positive integer dimensions with at most 16777216 texels; resize the atlas.',
    );
}

/** Whether every corner UV is a finite pair (the corner count is checked separately where it matters). */
export const finiteUVs = (face: PaintFace): boolean =>
  face.uv.every((uv) => uv.length === 2 && Number.isFinite(uv[0]) && Number.isFinite(uv[1]));

/** Validate a bounded RGBA8 scene and explicit caller policy without reading any app schema. */
export function validatePaintScene(scene: PaintScene): void {
  if (!scene || !Array.isArray(scene.objects) || !scene.texture)
    throw new TypeError('Paint scene needs objects and a texture; supply both.');
  validatePaintTexture(scene.texture);
  const ids = new Set<string>();
  for (const object of scene.objects) {
    validatePaintObject(object);
    if (ids.has(object.id)) throw new TypeError('Paint object IDs must be unique; assign distinct object IDs.');
    ids.add(object.id);
  }
}

/** Validate an independently usable bounded RGBA8 image, without requiring scene geometry. */
export function validatePaintTexture(texture: PaintTexture): void {
  if (!texture) throw new TypeError('Paint needs a texture; supply width, height and RGBA8 pixels.');
  const { width, height, pixels } = texture;
  paintTextureSize(width, height);
  if (!pixels || pixels.length !== width * height * 4)
    throw new TypeError('Paint texture needs width*height*4 RGBA8 bytes; repair the image storage.');
  for (let i = 0; i < pixels.length; i++) {
    const value = pixels[i];
    if (!Number.isInteger(value) || value < 0 || value > 255)
      throw new TypeError('Paint texture channels must be RGBA8 bytes; repair the image storage.');
  }
}

/** Validate a standalone object: identity, explicit eligibility, an affine transform and polygon geometry with draft UVs. */
export function validatePaintObject(object: PaintObject): void {
  if (!object || typeof object.id !== 'string' || !object.id.length)
    throw new TypeError('Paint object IDs must be nonempty; assign each object an ID.');
  if (
    typeof object.canPaint !== 'boolean' ||
    typeof object.canProject !== 'boolean' ||
    typeof object.canMirror !== 'boolean'
  )
    throw new TypeError('Paint eligibility must be explicit booleans; set canPaint, canProject and canMirror.');
  affineMatrix(object.worldMatrix, 'Paint world matrix');
  assertPolygonMesh(object, true, true);
}

/** Nearest texel of a top-left UV, clamped so the maximum boundary stays in the image. */
export const nearestTexel = (u: number, v: number, width: number, height: number): [number, number] => [
  Math.max(0, Math.min(width - 1, Math.floor(u * width))),
  Math.max(0, Math.min(height - 1, Math.floor(v * height))),
];

/**
 * The texel a top-left UV falls in, clamped so UVs of exactly 1 stay in the image.
 * @throws RangeError for a non-finite UV pair or dimensions that are not positive integers.
 */
export function paintTexel(uv: readonly number[], width: number, height: number): [number, number] {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Array.isArray(uv) ||
    uv.length !== 2 ||
    !Number.isFinite(uv[0]) ||
    !Number.isFinite(uv[1])
  )
    throw new RangeError('Texel lookup needs a finite UV pair and positive integer dimensions; check both.');
  return nearestTexel(uv[0], uv[1], width, height);
}

/** Barycentric weights of a 2D point in a UV triangle, or null outside it (with the established tolerances). */
export function paintBarycentricUV(
  point: readonly number[],
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
): PaintWeights | null {
  const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(denominator) < 1e-14) return null;
  const first = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / denominator;
  const second = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / denominator;
  const third = 1 - first - second;
  const inside = (value: number) => value >= -1e-7 && value <= 1.0000001;
  return inside(first) && inside(second) && inside(third) ? [first, second, third] : null;
}

/** Interpolate one source UV triangle without introducing float32 rounding. */
export const paintInterpolateUV = (points: readonly (readonly number[])[], weights: readonly number[]): MutableVec2 => [
  points[0][0] * weights[0] + points[1][0] * weights[1] + points[2][0] * weights[2],
  points[0][1] * weights[0] + points[1][1] * weights[1] + points[2][1] * weights[2],
];

/** Clamp a UV inside the face's UV bounds, pulling the maximum edges inward so they stay in content. */
export function paintInwardUV(face: PaintFace, uv: readonly number[]): MutableVec2 {
  const result: MutableVec2 = [0, 0];
  for (let axis = 0; axis < 2; axis++) {
    let minimum = Infinity,
      maximum = -Infinity;
    for (const point of face.uv) {
      minimum = Math.min(minimum, point[axis]);
      maximum = Math.max(maximum, point[axis]);
    }
    result[axis] = maximum > minimum ? Math.max(minimum, Math.min(maximum - 1e-9, uv[axis])) : minimum;
  }
  return result;
}

/** World positions of an object's vertices; hierarchy belongs to the caller. */
export const paintWorldVertices = (object: PaintObject): MutableVec3[] =>
  transformPoints(object.worldMatrix, object.vertices, 'Paint world matrix');

/** Visit the in-image pixels of the 3x3 block centred on `pixel`. */
function forBlock(pixel: number, width: number, height: number, visit: (index: number) => void): void {
  const x = pixel % width,
    y = (pixel - x) / width;
  for (let dy = -1; dy <= 1; dy++) {
    if (y + dy < 0 || y + dy >= height) continue;
    for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && x + dx < width) visit((y + dy) * width + x + dx);
  }
}

function pointInPolygon(point: readonly number[], polygon: readonly (readonly number[])[]): boolean {
  for (let i = 1; i < polygon.length - 1; i++)
    if (paintBarycentricUV(point, polygon[0], polygon[i], polygon[i + 1])) return true;
  return false;
}

function segmentTouchesCell(a: readonly number[], b: readonly number[], x: number, y: number): boolean {
  let low = 0,
    high = 1;
  for (let axis = 0; axis < 2; axis++) {
    const start = axis ? y : x,
      difference = b[axis] - a[axis];
    if (Math.abs(difference) < 1e-12) {
      if (a[axis] < start || a[axis] > start + 1) return false;
    } else {
      const one = (start - a[axis]) / difference,
        two = (start + 1 - a[axis]) / difference;
      low = Math.max(low, Math.min(one, two));
      high = Math.min(high, Math.max(one, two));
      if (low > high) return false;
    }
  }
  return true;
}

function makeIsland(objectId: string, face: PaintFace, width: number, height: number): PaintIsland {
  const polygon: MutableVec2[] = face.uv.map((uv) => [uv[0] * width, uv[1] * height]);
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const [u, v] of polygon) {
    left = Math.min(left, u);
    top = Math.min(top, v);
    right = Math.max(right, u);
    bottom = Math.max(bottom, v);
  }
  const minX = Math.max(0, Math.min(width - 1, Math.floor(left + 1e-8))),
    minY = Math.max(0, Math.min(height - 1, Math.floor(top + 1e-8))),
    maxX = Math.max(minX, Math.min(width - 1, Math.ceil(right - 1e-8) - 1)),
    maxY = Math.max(minY, Math.min(height - 1, Math.ceil(bottom - 1e-8) - 1));
  const mask = new Set<number>(),
    center = [0, 0];
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      center[0] = x + 0.5;
      center[1] = y + 0.5;
      if (
        pointInPolygon(center, polygon) ||
        polygon.some((a, i) => segmentTouchesCell(a, polygon[(i + 1) % polygon.length], x, y))
      )
        mask.add(y * width + x);
    }
  return { objectId, face, mask, key: [...mask].join(','), minX, minY, maxX, maxY };
}

/** Build fresh conservative content/halo ownership, retaining ineligible owners as reservations. */
export function paintIslandIndex(scene: PaintScene): PaintIslandIndex {
  const { width, height } = scene.texture;
  const signature =
    `${width}:${height}:` +
    JSON.stringify(scene.objects.map((object) => [object.id, object.faces.map((face) => [face.id, face.uv])]));
  let cached = islandCache.get(scene.objects);
  if (!cached || cached.signature !== signature) {
    const islands = scene.objects.flatMap((object) =>
      object.faces
        .filter((face) => face.uv.length >= 3 && finiteUVs(face))
        .map((face) => makeIsland(object.id, face, width, height)),
    );
    const padding = new Map<number, Set<string>>();
    for (const island of islands)
      for (const pixel of island.mask)
        forBlock(pixel, width, height, (index) => {
          const owners = padding.get(index);
          if (owners) owners.add(island.key);
          else padding.set(index, new Set([island.key]));
        });
    cached = { signature, islands, padding };
    islandCache.set(scene.objects, cached);
  }
  return indexFromRaster(scene, cached);
}

/** Orthogonal neighbours first, then diagonals: the halo's stable tie order. */
const NEIGHBOURS = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

/** Internal complete index assembly from immutable conservative rasters. */
function indexFromRaster(scene: PaintScene, cached: Pick<PaintIslandIndex, 'islands' | 'padding'>): PaintIslandIndex {
  const { width, height } = scene.texture;
  // Raster coverage is reusable; current face references and eligibility must never come from a stale scene.
  const currentFaces = new Map(
    scene.objects.flatMap((object) => object.faces.map((face) => [paintFaceKey(object.id, face.id), face] as const)),
  );
  const islands = cached.islands.map((island) => ({
    ...island,
    face: currentFaces.get(paintFaceKey(island.objectId, island.face.id))!,
  }));
  const faces = new Map(islands.map((island) => [paintFaceKey(island.objectId, island.face.id), island]));
  const protectedPixels = new Set<number>();
  const ineligible = new Set(scene.objects.filter((object) => !object.canPaint).map((object) => object.id));
  for (const island of islands)
    if (ineligible.has(island.objectId))
      for (const pixel of island.mask) forBlock(pixel, width, height, (index) => protectedPixels.add(index));
  const halos = new Map<string, [number, number][]>();
  for (const island of islands) {
    if (halos.has(island.key)) continue;
    const halo: [number, number][] = [];
    for (let y = Math.max(0, island.minY - 1); y <= Math.min(height - 1, island.maxY + 1); y++)
      for (let x = Math.max(0, island.minX - 1); x <= Math.min(width - 1, island.maxX + 1); x++) {
        const pixel = y * width + x,
          owners = cached.padding.get(pixel);
        // Skip content, protected texels and padding another island also claims.
        if (
          island.mask.has(pixel) ||
          protectedPixels.has(pixel) ||
          (owners && (owners.size > 1 || !owners.has(island.key)))
        )
          continue;
        for (const [dx, dy] of NEIGHBOURS)
          if (
            x + dx >= 0 &&
            x + dx < width &&
            y + dy >= 0 &&
            y + dy < height &&
            island.mask.has((y + dy) * width + x + dx)
          ) {
            halo.push([pixel, (y + dy) * width + x + dx]);
            break;
          }
      }
    halos.set(island.key, halo);
  }
  return {
    islands,
    faces,
    padding: cached.padding,
    protected: protectedPixels,
    reserved: new Set(cached.padding.keys()),
    halos,
  };
}

/** Internal extension for retained source UVs plus newly allocated faces; masks and padding never mutate the base. */
export function appendPaintIslandIndex(
  scene: PaintScene,
  base: PaintIslandIndex,
  objectId: string,
  addedFaces: readonly PaintFace[],
): PaintIslandIndex {
  const { width, height } = scene.texture,
    added = addedFaces.map((face) => makeIsland(objectId, face, width, height)),
    padding = new Map(base.padding),
    copied = new Set<number>();
  for (const island of added)
    for (const pixel of island.mask)
      forBlock(pixel, width, height, (at) => {
        if (!copied.has(at)) {
          padding.set(at, new Set(padding.get(at)));
          copied.add(at);
        }
        padding.get(at)!.add(island.key);
      });
  return indexFromRaster(scene, { islands: [...base.islands, ...added], padding });
}

/** Read one RGBA texel without sharing the input's array or typed-array storage. */
export function paintRead(texture: PaintTexture, x: number, y: number): PaintRGBA {
  const offset = (y * texture.width + x) * 4;
  return [texture.pixels[offset], texture.pixels[offset + 1], texture.pixels[offset + 2], texture.pixels[offset + 3]];
}

/** Observe the original bytes immediately before an actual texel change. */
export type PaintWriteObserver = (index: number, original: PaintRGBA) => void;

/** Replace one RGBA texel; paint uses byte replacement rather than alpha blending. */
export function paintWrite(
  pixels: number[],
  index: number,
  color: readonly number[],
  observe?: PaintWriteObserver,
): void {
  const offset = index * 4;
  if (
    pixels[offset] === color[0] &&
    pixels[offset + 1] === color[1] &&
    pixels[offset + 2] === color[2] &&
    pixels[offset + 3] === color[3]
  )
    return;
  observe?.(index, [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]]);
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = color[3];
}

/** Refresh a face's halo from interior only, with stable orthogonal/diagonal tie order. */
export function paintDilate(
  texture: PaintAtlas,
  island: PaintIsland,
  index: PaintIslandIndex,
  observe?: PaintWriteObserver,
): void {
  const { pixels, width } = texture;
  for (const [pixel, source] of index.halos.get(island.key) ?? [])
    paintWrite(pixels, pixel, paintRead(texture, source % width, Math.floor(source / width)), observe);
}
