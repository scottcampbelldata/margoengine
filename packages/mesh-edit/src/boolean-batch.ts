import type { ExactBooleanOptions, MeshBooleanOperation } from './exact-kernel.js';
import { batchExactKernel } from './exact-kernel.js';
import type { PolygonMesh } from './types.js';

/** Options for batch booleans. There is no geometric tolerance or intermediate rounding. */
export interface MeshBatchBooleanOptions extends ExactBooleanOptions {}

/** Original solid index and face ID, even when several solids reuse the same face IDs. */
export interface MeshBatchFaceSource {
  input: number;
  face: string;
}

/** One materialized n-ary solid with complete per-operand face provenance. */
export interface MeshBatchBooleanResult {
  mesh: PolygonMesh;
  sources: Record<string, MeshBatchFaceSource>;
  faceMap: Record<string, string[]>[];
  nonManifoldEdges: number;
  collapsedFaces: number;
  diagnostics: string[];
  /** Deterministic work counts; no timing or speed claim. */
  work: { exactSpaces: number; materializations: number; treeBuilds: number };
}

/** N-ary union/intersection, or first solid minus the union of the rest. Empty lists return an empty mesh.
 * All operands share one exact coordinate space and round only once after balanced exact BSP reductions.
 * Empty operands are identities for union/subtraction, and absorbing for intersection.
 * @throws TypeError for invalid solids/options, RangeError for input limits, or the abort signal's reason.
 */
export function batchBooleanMeshes(
  meshes: readonly PolygonMesh[],
  operation: MeshBooleanOperation = 'union',
  options: MeshBatchBooleanOptions = {},
): MeshBatchBooleanResult {
  return batchExactKernel(meshes, operation, options);
}
