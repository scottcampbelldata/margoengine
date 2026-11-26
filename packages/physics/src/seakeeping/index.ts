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
export { type Hull, type HullParams, HullSolver, SEA_VISCOSITY } from './solver.js';
export { type Deck, deckOf, stepDeck } from './deck.js';
export { type SlamStation, slamSlope, slamStations } from './slamming.js';
export { eddyRollCoefficient, FRICTION, frictionGirth } from './viscous.js';
export {
  addedMassInfinite,
  heaveAddedMassInfinite,
  hullSections,
  type LewisForm,
  lewisForm,
  type Section,
  swayAddedMassRigidLid,
} from './strips.js';
export {
  type HeaveSection,
  heaveSection,
  type LateralSection,
  lateralSection,
  type Scattering,
  scatterSection,
} from './radiation.js';
export { type HullMemory, hullMemory, type RadiationPair, stillWaterline } from './memory.js';
