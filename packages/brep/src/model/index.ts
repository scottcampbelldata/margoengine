// The modeler: B-rep topology with persistent names, primitives, extrusion and revolution, Booleans, fillets and
// chamfers, validation, and STEP export and meshing of what it makes. Exported from the package as one namespace,
// `model`, so its names (box, sphere, Face) do not stand beside the engine's own.
export { Body, Coedge, Edge, Face, History, Loop, Shell, Vertex } from './topology.js';
export type { HistoryEntry, Name } from './topology.js';
export { frameOf, curveEvaluator, surfaceEvaluator } from './geometry.js';
export type { CurveDef, Frame, SurfaceDef } from './geometry.js';
export type { WriterSpline } from '../step/write.js';
export { box, cylinder, extrude, revolve, sphere, torus } from './build.js';
export type { Profile, ProfileSegment } from './build.js';
export { validateBody } from './validate.js';
export type { ValidityProblem } from './validate.js';
export { bodiesToSTEP, meshBodies } from './export.js';
export type { BodyMeshes } from './export.js';
export { boolean } from './boolean.js';
export type { BooleanOperation } from './boolean.js';
export { chamfer, fillet } from './blend.js';
export { curveSurfaceCrossings, intersectSurfaces, signedDistance } from './intersect.js';
export type { SurfaceIntersection } from './intersect.js';
