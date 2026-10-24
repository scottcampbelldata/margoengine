import type { Mat4, MutableVec2, MutableVec3 } from '@margoengine/math';

/** One polygon: a caller-chosen ID, its corner vertex indices in order, and a UV for each corner. */
export interface PolygonFace {
  id: string;
  vertices: number[];
  uv: MutableVec2[];
}

/** Editable polygons over shared vertices. Commands never change their input; results own new arrays. */
export interface PolygonMesh {
  vertices: MutableVec3[];
  faces: PolygonFace[];
}

/** Options shared by commands that create faces. */
export interface MeshEditOptions {
  createId?: () => string;
}

/** The mesh an edit produced, and where each input vertex and face went. */
export interface MeshEditResult {
  mesh: PolygonMesh;
  /** For each input vertex, the output vertices it became (itself, if kept, plus any new copies). */
  vertexMap: number[][];
  /** Old face ID to retained and descendant output face IDs. */
  faceMap: Record<string, string[]>;
  createdVertices: number[];
  /** Input vertices that were dropped, including ones welded into another vertex. */
  removedVertices: number[];
  createdFaces: string[];
  removedFaces: string[];
  affectedFaces: string[];
  diagnostics: string[];
}

/** What to edit: the whole object, or listed vertices, edges or faces. Edge IDs are `${lowerVertex}:${higherVertex}`. */
export type ComponentSelection =
  | { mode: 'object' }
  | { mode: 'vertex'; vertices: readonly number[] }
  | { mode: 'edge'; edges: readonly string[] }
  | { mode: 'face'; faces: readonly string[] };

/** Owned edit provenance for edges as well as vertices and faces. */
export interface ComponentEditResult extends MeshEditResult {
  /** For each input edge, the output edges it became; empty when it was removed. */
  edgeMap: Record<string, string[]>;
  createdEdges: string[];
  removedEdges: string[];
}

/** Options for {@link transformMeshComponents}. */
export interface ComponentTransformOptions extends MeshEditOptions {
  /** The object's local-to-world matrix; identity when omitted. Mirrored matrices are fine. */
  worldMatrix?: Mat4;
  /** Positive finite world-space grid step; omitted disables snapping. */
  snapStep?: number;
  /** What to do with a face the move makes non-planar: split it into triangles (default) or throw. */
  nonPlanarFaces?: 'triangulate' | 'reject';
}

/** Where a quad ring starts: the edge of quad `faceId` from `corner` to the next corner. */
export interface QuadRingSeed {
  faceId: string;
  corner: number;
}

/** A traced quad ring: its faces and the edges it crosses, in order and all pointing the same way. An open ring has one more edge than faces. */
export interface QuadRing {
  closed: boolean;
  edges: { id: string; from: number; to: number }[];
  faces: string[];
}

/** Result of {@link cutMeshQuadRing}, with the new loop's vertices and edges in order. */
export interface QuadRingCutResult extends ComponentEditResult {
  ring: { closed: boolean; vertices: number[]; edges: string[] };
}

/** Primitive shapes {@link createPrimitiveMesh} can build, each centred in a unit box. */
export type PrimitiveMeshKind = 'cube' | 'plane' | 'cylinder' | 'wedge';

/** One oriented polygon edge, with its starting corner in that polygon. */
export interface PolygonEdgeIncidence {
  faceId: string;
  corner: number;
  from: number;
  to: number;
}

/** One edge and every face corner that uses it. One use is a boundary edge; more than two is non-manifold. */
export interface PolygonEdge {
  id: string;
  vertices: [number, number];
  incidences: PolygonEdgeIncidence[];
}

/** Triangles with flat normals for rendering or export, tagged with their source faces and vertices. */
export interface CompiledPolygonMesh {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  /** Per source polygon: one 4 for a quad, otherwise one 3 per triangle (the layout the OBJ exporter expects). */
  faceSizes: number[];
  /** One source face ID per output triangle. */
  triangleFaces: string[];
  /** One source vertex index per expanded render corner. */
  cornerVertices: number[];
}
