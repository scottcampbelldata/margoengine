import type { Mat4, MutableVec2, MutableVec3 } from '@margoengine/math';
import type { PolygonFace } from './types.js';

/** A polygon whose corner UVs may be missing or invalid, so UV commands can repair them. */
export interface PaintFace extends Pick<PolygonFace, 'id' | 'vertices'> {
  uv: number[][];
}

/** Polygons whose geometry must be valid while their UVs may still be drafts. */
export interface PaintGeometry {
  vertices: MutableVec3[];
  faces: PaintFace[];
}

/** One mesh in a paint scene: its ID, world matrix, geometry and what it allows. */
export interface PaintObject extends PaintGeometry {
  id: string;
  worldMatrix: Mat4;
  canPaint: boolean;
  canProject: boolean;
  /** Whether mirrored paint may land on this object, including mirroring onto itself. */
  canMirror: boolean;
}

/** An RGBA8 image, rows top to bottom. Commands only read it while they run. */
export interface PaintTexture {
  width: number;
  height: number;
  pixels: ArrayLike<number>;
}

/** Owned top-left row-major RGBA8 command result. */
export interface PaintAtlas extends PaintTexture {
  pixels: number[];
}

/** Meshes sharing one texture atlas. Their order breaks ties between faces and mirror targets. */
export interface PaintScene {
  objects: PaintObject[];
  texture: PaintTexture;
}

/** Where a ray hit a face, with the UV there and, optionally, the local and world points. */
export interface PaintHit {
  objectId: string;
  faceId: string;
  uv: MutableVec2;
  distance: number;
  localPoint?: MutableVec3;
  worldPoint?: MutableVec3;
}

/** Brush mode. Dither alternates with `secondaryColor` on an atlas-aligned checkerboard; fully transparent paint never dithers. */
export interface PaintOptions {
  mode?: 'solid' | 'dither';
  secondaryColor?: string;
}

/** A UV command's new atlas, the geometry of the meshes it changed, and how many faces it packed. */
export interface PaintUVResult {
  texture: PaintAtlas;
  objects: (PaintGeometry & { id: string })[];
  packed: number;
}

/** The RGBA8 pixels of a changed rectangle, for a partial texture upload. */
export interface PaintPatch {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number[];
  sequence: number;
  revision: number;
}

/** Handle for the active stroke of a {@link MeshPaintSession}. Only the object `begin` returned works. */
export interface PaintStroke {
  readonly revision: number;
}
