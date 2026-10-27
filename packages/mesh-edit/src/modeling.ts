// @margoengine/mesh-edit/modeling: topology modelling on the same editable polygon meshes as the root entry. Edge
// bevel, edge slide, dissolve, merge by distance, bridge, concave faces, knife, subdivision, booleans,
// simplification, UV unwrap, lightmap UVs, flat-tile merging and import from triangles; its own entry so editors that only paint or move components never
// load it.
export type {
  PolygonFace,
  PolygonMesh,
  MeshEditOptions,
  MeshEditResult,
  ComponentEditResult,
} from './types.js';
export { weldMeshVertices, type WeldOptions, type WeldResult } from './weld.js';
export { dissolveMeshComponents, type DissolveSelection } from './dissolve.js';
export { slideMeshEdges, type EdgeSlideOptions } from './slide.js';
export { bridgeMeshEdgeLoops, type BridgeOptions } from './bridge.js';
export { bevelMeshEdges } from './bevel-edges.js';
export { triangulatePolygon, convexPolygonPieces, splitMeshConcaveFaces } from './concave.js';
export { knifeMeshFaces, type KnifeOptions, type KnifeResult } from './knife.js';
export { subdivideMesh, type SubdivideOptions } from './subdivide.js';
export {
  booleanMeshes,
  type MeshBooleanOperation,
  type MeshBooleanOptions,
  type MeshBooleanResult,
  type MeshBooleanFaceSource,
} from './boolean.js';
export {
  simplifyMesh,
  meshLODChain,
  type SimplifyOptions,
  type SimplifyResult,
  type LODChainOptions,
} from './simplify.js';
export {
  unwrapMesh,
  meshLightmapUVs,
  type UVPin,
  type ChartOptions,
  type UnwrapOptions,
  type UVChart,
  type UnwrapResult,
  type LightmapUVResult,
} from './unwrap.js';
export { mergeFlatFaces, type MergeFlatOptions, type MergeFlatResult } from './flat.js';
export {
  polygonMeshFromTriangles,
  type TriangleSource,
  type ImportMeshOptions,
  type ImportMeshResult,
} from './import.js';
