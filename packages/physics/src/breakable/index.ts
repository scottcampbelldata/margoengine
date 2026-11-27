// Tree-shakable optional entry `@margoengine/physics/breakable`:
// Breakable rigid bodies over Margo's own physics kernel with 3D convex Voronoi fracture,
// connection graphs, support anchors (X-42), cumulative impact damage (X-43), debris policies,
// and a built-in debug wireframe overlay.
export { BreakableBody, BreakableWorld } from './breakable.js';
export type {
  BreakableAnchorMode,
  BreakableAnchorQuery,
  BreakableBodyOptions,
  BreakableBondInput,
  BreakableExplosionOptions,
  BreakableFractureMode,
  BreakableFragment,
  BreakableSnapshot,
  BreakableWorldOptions,
  BreakEvent,
} from './breakable.js';
export type { BreakableBond } from './graph.js';
export type {
  BreakableDebugRenderOptions,
  BreakableDebugStyle,
} from './debug.js';
export {
  computePolyhedronMassProperties,
  createBoxPolyhedron,
  createPolyhedronFromGeometry,
  voronoiFractureBox,
  voronoiFractureGeometry,
  voronoiFracturePolyhedron,
} from './polyhedron.js';
export type {
  BreakableCell,
  BreakableFracturePattern,
  BreakableMassProperties,
  BreakableMaterialGroup,
  BreakablePolyhedron,
  BreakablePolyhedronFace,
  CellAdjacency,
  VoronoiFractureResult,
} from './polyhedron.js';
