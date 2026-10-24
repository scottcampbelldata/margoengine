import type { MutableVec3 } from '@margoengine/math';
import type { PaintAtlas, PaintScene } from './paint-types.js';
import { paintTextureSize, validatePaintScene } from './paint-common.js';

/**
 * Owned copy of a caller scene. Mutable storage is copied first, with structural guards so malformed or unbounded
 * arrays are never traversed; validation then examines the owned snapshot, never the caller's version.
 */
export function snapshotPaintScene(input: PaintScene): PaintScene & { texture: PaintAtlas } {
  if (!input || !Array.isArray(input.objects) || !input.texture)
    throw new TypeError('Paint scene needs objects and a texture; supply both.');
  const { width, height, pixels } = input.texture;
  paintTextureSize(width, height);
  if (!pixels || pixels.length !== width * height * 4)
    throw new TypeError('Paint texture needs width*height*4 RGBA8 bytes; repair the image storage.');
  const texture: PaintAtlas = { width, height, pixels: Array.from(pixels) };
  const objects = Array.from(input.objects, (object) => {
    if (!object || !Array.isArray(object.vertices) || !Array.isArray(object.faces))
      throw new TypeError('Paint geometry needs vertices and faces arrays; supply indexed polygons.');
    if (object.vertices.length > 200_000 || object.faces.length > 200_000)
      throw new RangeError('Paint geometry exceeds 200000 vertices or faces; split the mesh.');
    if (!object.worldMatrix || object.worldMatrix.length !== 16)
      throw new TypeError('Paint world matrix needs 16 column-major numbers; supply an affine matrix.');
    return {
      id: object.id,
      canPaint: object.canPaint,
      canProject: object.canProject,
      canMirror: object.canMirror,
      worldMatrix: Array.from(object.worldMatrix),
      vertices: Array.from(object.vertices, (point) =>
        Array.isArray(point) ? (Array.from(point) as MutableVec3) : point,
      ),
      faces: Array.from(object.faces, (face) => {
        if (!face || !Array.isArray(face.vertices) || !Array.isArray(face.uv))
          throw new TypeError('Paint faces need corner index and UV arrays; repair the face data.');
        if (face.vertices.length > 64)
          throw new TypeError('Paint faces need 3 to 64 corner indices; split larger polygons.');
        return {
          id: face.id,
          vertices: Array.from(face.vertices),
          uv: Array.from(face.uv, (uv) => (Array.isArray(uv) ? Array.from(uv) : uv)),
        };
      }),
    };
  });
  const scene = { objects, texture };
  validatePaintScene(scene);
  return scene;
}
