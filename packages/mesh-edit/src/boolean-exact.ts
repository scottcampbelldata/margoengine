// Public binary entry; batch orchestration stays in its own optional entry.
export { booleanMeshesExact } from './exact-kernel.js';
export type {
  ExactBooleanOptions,
  ExactBooleanResult,
  MeshBooleanFaceSource,
  MeshBooleanOperation,
} from './exact-kernel.js';
