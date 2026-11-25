// `@margoengine/physics/seakeeping`: a hull on the sea (docs/physics-solvers.md, SEA-08): the water's load on a rigid hull,
// integrated over its wetted surface, for the framework's rigid solver through `bodyForces`.
export {
  GRAVITY,
  type HullMesh,
  type HullPose,
  type Quat,
  SEA_WATER,
  type SeaQuery,
  type Vec3,
  type WettedLoads,
  wettedLoads,
} from './wetted.js';
export { type Hull, type HullParams, HullSolver } from './solver.js';
export {
  addedMassInfinite,
  heaveAddedMassInfinite,
  hullSections,
  type LewisForm,
  lewisForm,
  type Section,
  swayAddedMassInfinite,
} from './strips.js';
