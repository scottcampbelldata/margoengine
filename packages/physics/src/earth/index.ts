// `@margoengine/physics/earth`: the physics framework's solid-earth solvers (docs/physics-solvers.md, families EARTH and BREAK).
// The terrain bed first (PA-37): the registry field every ground writer adds to and every reader samples, and the collider
// that follows it.
export {
  BED_CHANGE_FIELD,
  BED_FIELD,
  BED_LAYOUT,
  BedChange,
  TerrainBed,
  bedFromPort,
  bedSurface,
  bedVertexAreas,
  bedVertexCount,
  bedVolume,
  type BedShape,
  type TerrainBedParams,
} from './bed.js';
export { BedCollider, type BedColliderOptions } from './bed-collider.js';
