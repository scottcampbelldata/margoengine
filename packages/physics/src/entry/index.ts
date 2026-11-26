// `@margoengine/physics/entry`: bodies going into the water and out of it (SEA-14 of docs/physics-solvers.md): the slam,
// the air cavity and its seal, the splashes, the waves and the foam a cannonball, a diver, a launched hull or a breaching
// whale makes, as a solver of the physics framework beside the rigid solver.
export {
  EntrySolver,
  JET_SPEED_RATIO,
  spheroid,
  WATER_SURFACE_TENSION,
  WATER_VISCOSITY,
  type EntryBody,
  type EntryFoam,
  type EntryParams,
  type EntrySplash,
} from './solver.js';
export { CAVITY_ALPHA, cavityThreshold, constantSpeedPinch, sectionRadius2, WETTING_XI } from './cavity.js';
export { sectionArea, slam, slamProfile, wagnerRadius, type Slam, type SlamProfile } from './slam.js';
