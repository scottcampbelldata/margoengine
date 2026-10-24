import type { MutableVec2 } from '@margoengine/math';
import { cross, dot, normalize, sub } from '@margoengine/math/vec3';
import type { PaintFace, PaintGeometry, PaintObject, PaintScene, PaintUVResult } from './paint-types.js';
import {
  paintDilate,
  paintFaceKey,
  paintInterpolateUV,
  paintInwardUV,
  paintIslandIndex,
  paintRead,
  paintTexel,
  paintWorldVertices,
  paintWrite,
  validatePaintObject,
  validatePaintScene,
  type PaintRGBA,
} from './paint-common.js';
import { newellNormal } from './polygon.js';
import { clonePolygonMesh } from './result.js';
import { projectedTexelSample } from './uv-transfer.js';

const finiteUVPair = (uv: readonly number[]): boolean =>
  uv.length === 2 && Number.isFinite(uv[0]) && Number.isFinite(uv[1]);

function dimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1024 || height > 1024)
    throw new RangeError('Atlas dimensions need integers from 1 to 1024; choose supported canvas dimensions.');
}

function assertUVDensity(value: number, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum || value <= 0)
    throw new RangeError(
      `UV density must be positive and between ${minimum} and ${maximum}; choose a supported density.`,
    );
}

function projectable(scene: PaintScene, objectId: string): PaintObject {
  const mesh = scene.objects.find((object) => object.id === objectId);
  if (!mesh) throw new TypeError('UV projection needs an existing mesh object; select a mesh first.');
  if (!mesh.canProject) throw new TypeError('This mesh is not eligible for UV projection; unlock projection first.');
  return mesh;
}

function flatFace(face: PaintFace, world: ReturnType<typeof paintWorldVertices>) {
  const points = face.vertices.map((index) => world[index]),
    origin = points[0],
    tangent = normalize(sub(points[1], origin)),
    bitangent = normalize(cross(newellNormal(points), tangent));
  const flat: MutableVec2[] = points.map((point) => [
    dot(sub(point, origin), tangent),
    dot(sub(point, origin), bitangent),
  ]);
  const minU = Math.min(...flat.map((point) => point[0])),
    maxU = Math.max(...flat.map((point) => point[0])),
    minV = Math.min(...flat.map((point) => point[1])),
    maxV = Math.max(...flat.map((point) => point[1]));
  return { flat, minU, maxU, minV, maxV };
}

/** Place a rectangle at the first free spot, scanning rows top to bottom, and mark it used. */
function allocate(
  used: Uint8Array,
  atlasWidth: number,
  atlasHeight: number,
  width: number,
  height: number,
  exhaustionMessage: string,
): [number, number] {
  for (let y = 0; y <= atlasHeight - height; y++)
    searchColumn: for (let x = 0; x <= atlasWidth - width; x++) {
      for (let row = y; row < y + height; row++)
        for (let column = x; column < x + width; column++) if (used[row * atlasWidth + column]) continue searchColumn;
      mark(used, atlasWidth, atlasHeight, x, y, width, height);
      return [x, y];
    }
  throw new RangeError(exhaustionMessage);
}

function mark(
  used: Uint8Array,
  atlasWidth: number,
  atlasHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const left = Math.max(0, x),
    right = Math.min(atlasWidth, x + width);
  if (right <= left) return;
  for (let row = Math.max(0, y); row < Math.min(atlasHeight, y + height); row++)
    used.fill(1, row * atlasWidth + left, row * atlasWidth + right);
}

function reserveFaceUV(used: Uint8Array, atlasWidth: number, atlasHeight: number, face: PaintFace): void {
  if (!face.uv.length || face.uv.some((uv) => !finiteUVPair(uv))) return;
  const x = Math.floor(Math.min(...face.uv.map((uv) => uv[0])) * atlasWidth + 1e-6) - 1,
    y = Math.floor(Math.min(...face.uv.map((uv) => uv[1])) * atlasHeight + 1e-6) - 1,
    right = Math.ceil(Math.max(...face.uv.map((uv) => uv[0])) * atlasWidth - 1e-6) + 1,
    bottom = Math.ceil(Math.max(...face.uv.map((uv) => uv[1])) * atlasHeight - 1e-6) + 1;
  mark(used, atlasWidth, atlasHeight, x, y, right - x, bottom - y);
}

/** Mark the atlas space taken by existing islands, ready for {@link allocatePreparedFaceUV}. */
export function prepareFaceUVAllocation(
  objectId: string,
  originalFaceIds: readonly string[],
  occupied: readonly PaintObject[],
  atlasDimensions: [number, number],
  validateOccupied = false,
) {
  if (!Array.isArray(atlasDimensions) || atlasDimensions.length !== 2)
    throw new TypeError('Atlas dimensions need a width and height; supply two integer dimensions.');
  const [atlasWidth, atlasHeight] = atlasDimensions;
  dimensions(atlasWidth, atlasHeight);
  if (!Array.isArray(originalFaceIds) || originalFaceIds.some((id) => typeof id !== 'string'))
    throw new TypeError('Original face IDs need an array of strings; supply the retained face identities.');
  if (validateOccupied) for (const object of occupied) validatePaintObject(object);
  const originals = new Set(originalFaceIds),
    used = new Uint8Array(atlasWidth * atlasHeight);
  for (const object of occupied)
    for (const face of object.faces)
      if (object.id !== objectId || originals.has(face.id)) reserveFaceUV(used, atlasWidth, atlasHeight, face);
  return { originals, used, atlasWidth, atlasHeight };
}

/** Internal candidate allocator: source reservations are owned and candidate geometry was checked by the current Engine edit. */
export function allocatePreparedFaceUV(
  mesh: PaintObject,
  preparation: ReturnType<typeof prepareFaceUVAllocation>,
  pixelsPerUnit: number,
): PaintGeometry {
  if (!mesh.canProject) throw new TypeError('This mesh is not eligible for UV projection; unlock projection first.');
  assertUVDensity(pixelsPerUnit, 0.25, 128);
  const { originals, atlasWidth, atlasHeight } = preparation,
    used = preparation.used.slice(),
    next = clonePolygonMesh(mesh);
  for (const face of next.faces) if (originals.has(face.id)) reserveFaceUV(used, atlasWidth, atlasHeight, face);
  const world = paintWorldVertices(mesh);
  for (const face of next.faces) {
    if (originals.has(face.id)) continue;
    const { flat, minU, maxU, minV, maxV } = flatFace(face, world);
    const width = Math.max(1, Math.ceil((maxU - minU) * pixelsPerUnit - 1e-6)),
      height = Math.max(1, Math.ceil((maxV - minV) * pixelsPerUnit - 1e-6));
    const [x, y] = allocate(
      used,
      atlasWidth,
      atlasHeight,
      width + 2,
      height + 2,
      `The ${atlasWidth}×${atlasHeight} atlas has no free space for Auto UV at this density. Reduce density or free an island.`,
    );
    face.uv = flat.map(([u, v]) => [
      (x + 1 + (u - minU) * pixelsPerUnit) / atlasWidth,
      (y + 1 + (v - minV) * pixelsPerUnit) / atlasHeight,
    ]);
  }
  return next;
}

/**
 * Give the faces not listed in `originalFaceIds` their own UV islands, at exactly `pixelsPerUnit` world-space
 * texels. Listed faces keep their UVs. Every occupied island, plus a one-pixel border, is kept free; `occupied` may
 * be the scene before or after the edit. Returns new geometry without caller metadata.
 * @throws TypeError for a bad object, IDs or occupied list; RangeError for a bad density or dimensions, or when the
 * atlas has no room (inputs are left unchanged).
 */
export function allocateMeshFaceUV(
  mesh: PaintObject,
  originalFaceIds: readonly string[],
  occupied: readonly PaintObject[],
  pixelsPerUnit = 16,
  atlasDimensions: [number, number] = [128, 128],
): PaintGeometry {
  validatePaintObject(mesh);
  if (!mesh.canProject) throw new TypeError('This mesh is not eligible for UV projection; unlock projection first.');
  assertUVDensity(pixelsPerUnit, 0.25, 128);
  if (!Array.isArray(occupied)) throw new TypeError('Occupied meshes need an array; supply protected objects.');
  const preparation = prepareFaceUVAllocation(mesh.id, originalFaceIds, occupied, atlasDimensions, true);
  return allocatePreparedFaceUV(mesh, preparation, pixelsPerUnit);
}

/** UV operations may edit hidden but projectable objects; painting eligibility must not suppress their halos. */
const uvIndex = (scene: PaintScene) =>
  paintIslandIndex({
    texture: scene.texture,
    objects: scene.objects.map((object) => ({ ...object, canPaint: true })),
  });

/**
 * Re-project every face of one mesh into free atlas space, one island per face with a one-pixel border, and copy
 * its texture across. Each new texel copies one texel of the original atlas, never blended: the texel under its
 * centre, or for edge texels the one under the centre of the covered part. Each island spans a whole number of texels.
 * Faces whose old UVs were invalid become opaque grey. Borders are then filled from the island.
 * @throws TypeError for a bad scene or an ineligible mesh; RangeError for a bad density or a full atlas.
 */
export function projectMeshUV(scene: PaintScene, objectId: string, texelsPerUnit = 16): PaintUVResult {
  validatePaintScene(scene);
  assertUVDensity(texelsPerUnit, Number.MIN_VALUE, 1024);
  const mesh = projectable(scene, objectId),
    { width, height } = scene.texture,
    used = new Uint8Array(width * height),
    oldIndex = uvIndex(scene);
  for (const island of oldIndex.islands)
    if (island.objectId !== objectId)
      for (const pixel of island.mask) {
        const x = pixel % width,
          y = Math.floor(pixel / width);
        mark(used, width, height, x - 1, y - 1, 3, 3);
      }
  const world = paintWorldVertices(mesh),
    geometry = clonePolygonMesh(mesh);
  const plans = geometry.faces.map((face, index) => {
    const { flat, minU, maxU, minV, maxV } = flatFace(face, world);
    const contentWidth = Math.max(1, Math.ceil((maxU - minU) * texelsPerUnit - 1e-8)),
      contentHeight = Math.max(1, Math.ceil((maxV - minV) * texelsPerUnit - 1e-8)),
      [x, y] = allocate(
        used,
        width,
        height,
        contentWidth + 2,
        contentHeight + 2,
        'Texture atlas has no free space for these UVs and their padding. Reduce texels per unit or enlarge the atlas.',
      );
    face.uv = flat.map((point) => [
      (x + 1 + ((point[0] - minU) / (maxU - minU || 1)) * contentWidth) / width,
      (y + 1 + ((point[1] - minV) / (maxV - minV || 1)) * contentHeight) / height,
    ]);
    return { original: mesh.faces[index], face, x: x + 1, y: y + 1, width: contentWidth, height: contentHeight };
  });
  const texture = { width, height, pixels: Array.from(scene.texture.pixels) };
  const nextScene = {
      texture,
      objects: scene.objects.map((object) => (object.id === objectId ? { ...object, ...geometry } : object)),
    },
    nextIndex = uvIndex(nextScene);
  for (const plan of plans) {
    const island = nextIndex.faces.get(paintFaceKey(objectId, plan.face.id));
    if (!island) throw new RangeError('Projected face coverage is missing; repair the face or reduce its transform.');
    const identical =
      plan.original.uv.length === plan.face.uv.length &&
      plan.original.uv.every(
        (uv, corner) => uv.length === 2 && uv[0] === plan.face.uv[corner][0] && uv[1] === plan.face.uv[corner][1],
      );
    for (const pixel of island.mask) {
      if (identical) {
        paintWrite(texture.pixels, pixel, paintRead(scene.texture, pixel % width, Math.floor(pixel / width)));
        continue;
      }
      const x = pixel % width,
        y = Math.floor(pixel / width),
        sample = projectedTexelSample(plan.face.uv, x, y, width, height);
      if (!sample)
        throw new RangeError('Projected texel coverage cannot be resolved; repair the face or reduce its transform.');
      const i = sample.triangle;
      if (
        plan.original.uv.length !== plan.original.vertices.length ||
        plan.original.uv.some((point) => !finiteUVPair(point))
      )
        paintWrite(texture.pixels, pixel, [180, 185, 180, 255]);
      else {
        const oldUV = paintInwardUV(
            plan.original,
            paintInterpolateUV([plan.original.uv[0], plan.original.uv[i], plan.original.uv[i + 1]], sample.weights),
          ),
          [sourceX, sourceY] = paintTexel(oldUV, width, height);
        paintWrite(texture.pixels, pixel, paintRead(scene.texture, sourceX, sourceY));
      }
    }
  }
  for (const plan of plans) {
    const island = nextIndex.faces.get(paintFaceKey(objectId, plan.face.id));
    if (island) paintDilate(texture, island, nextIndex);
  }
  return { texture, objects: [{ ...geometry, id: objectId }], packed: plans.length };
}

function unmapped(face: PaintFace): boolean {
  if (
    face.uv.length !== face.vertices.length ||
    face.uv.length < 3 ||
    face.uv.some((uv) => !finiteUVPair(uv) || uv.some((value) => value < 0 || value > 1))
  )
    return true;
  return (
    Math.abs(
      face.uv.reduce((sum, point, index) => {
        const next = face.uv[(index + 1) % face.uv.length];
        return sum + point[0] * next[1] - next[0] * point[1];
      }, 0),
    ) < 1e-12
  );
}

/**
 * Give faces with missing or invalid UVs their own islands, filled with the colour of their first valid UV (opaque
 * grey when there is none). Limit it to one mesh with `objectId`, or pass mode `'selected'` to re-project that mesh
 * with `projectMeshUV`. Returns null when no face needs repair. All islands are placed before any pixel is written.
 * @throws TypeError for a bad scene, mode or mesh; RangeError for a bad density or a full atlas.
 */
export function packMeshUV(
  scene: PaintScene,
  objectId?: string,
  pixelsPerUnit = 16,
  mode: 'unmapped' | 'selected' = 'unmapped',
): PaintUVResult | null {
  validatePaintScene(scene);
  assertUVDensity(pixelsPerUnit, 0.25, 128);
  if (mode !== 'unmapped' && mode !== 'selected')
    throw new TypeError('Unknown UV packing mode; choose unmapped or selected.');
  if (objectId !== undefined) projectable(scene, objectId);
  if (mode === 'selected') {
    if (objectId === undefined) throw new TypeError('Selected UV packing needs a mesh object; select a mesh first.');
    return projectMeshUV(scene, objectId, pixelsPerUnit);
  }
  const pending = new Map<string, Set<string>>();
  for (const object of scene.objects)
    if (object.canProject && (objectId === undefined || object.id === objectId)) {
      const ids = new Set(object.faces.filter(unmapped).map((face) => face.id));
      if (ids.size) pending.set(object.id, ids);
    }
  const packed = [...pending.values()].reduce((sum, ids) => sum + ids.size, 0);
  if (!packed) return null;
  let objects = [...scene.objects];
  const changed: (PaintGeometry & { id: string })[] = [],
    initialized: { objectId: string; faceId: string; color: PaintRGBA }[] = [];
  for (const original of scene.objects) {
    const targets = pending.get(original.id);
    if (!targets) continue;
    const occupancy = objects.map((object) => ({
      ...object,
      faces: object.faces.filter((face) => !pending.get(object.id)?.has(face.id)),
    }));
    const geometry = allocateMeshFaceUV(
      original,
      original.faces.filter((face) => !targets.has(face.id)).map((face) => face.id),
      occupancy,
      pixelsPerUnit,
      [scene.texture.width, scene.texture.height],
    );
    objects = objects.map((object) => (object.id === original.id ? { ...object, ...geometry } : object));
    changed.push({ ...geometry, id: original.id });
    for (const face of original.faces.filter((face) => targets.has(face.id))) {
      const source = face.uv.find(finiteUVPair);
      const color: PaintRGBA = source
        ? paintRead(scene.texture, ...paintTexel(source, scene.texture.width, scene.texture.height))
        : [180, 185, 180, 255];
      initialized.push({ objectId: original.id, faceId: face.id, color });
    }
    pending.delete(original.id);
  }
  const texture = {
      width: scene.texture.width,
      height: scene.texture.height,
      pixels: Array.from(scene.texture.pixels),
    },
    index = uvIndex({ objects, texture });
  for (const entry of initialized) {
    const island = index.faces.get(paintFaceKey(entry.objectId, entry.faceId));
    if (!island) continue;
    for (const pixel of island.mask) paintWrite(texture.pixels, pixel, entry.color);
    paintDilate(texture, island, index);
  }
  return { texture, objects: changed, packed };
}

/**
 * Resize the atlas without resampling: the overlapping top-left part is copied and new space gets `fill`.
 * Corner UVs are rescaled so every island keeps its texels. Returns geometry without caller metadata.
 * @throws TypeError for a bad scene or fill; RangeError for bad dimensions or a shrink that would cut an island or
 * its one-pixel border.
 */
export function resizeMeshPaintAtlas(
  scene: PaintScene,
  width: number,
  height: number,
  fill: PaintRGBA = [38, 43, 48, 255],
): PaintUVResult {
  validatePaintScene(scene);
  dimensions(width, height);
  if (
    !Array.isArray(fill) ||
    fill.length !== 4 ||
    !Array.from(fill).every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)
  )
    throw new TypeError('Atlas fill needs four RGBA8 bytes; supply integer channels from 0 to 255.');
  const old = scene.texture;
  for (const object of scene.objects)
    for (const face of object.faces)
      for (const [u, v] of face.uv)
        if (u * old.width + 1 > width + 1e-6 || v * old.height + 1 > height + 1e-6)
          throw new RangeError(
            'Occupied UV islands and padding do not fit this canvas; choose larger atlas dimensions.',
          );
  const pixels = new Array<number>(width * height * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = fill[i & 3];
  const columns = Math.min(width, old.width) * 4;
  for (let y = 0; y < Math.min(height, old.height); y++)
    for (let i = 0; i < columns; i++) pixels[y * width * 4 + i] = old.pixels[y * old.width * 4 + i];
  const objects = scene.objects.map((object) => {
    const geometry = clonePolygonMesh(object);
    for (const face of geometry.faces)
      face.uv = face.uv.map(([u, v]) => [(u * old.width) / width, (v * old.height) / height]);
    return { ...geometry, id: object.id };
  });
  return { texture: { width, height, pixels }, objects, packed: 0 };
}
