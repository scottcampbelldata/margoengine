// @margoengine/physics/explosive: explosive sources (FIRE-05). The charge's energy, its TNT equivalent, Gurney metal
// speeds and the air and ground shares of a buried charge, and the ground's share split into shock, crater work and heat.
export {
  AIR_DEPTH_SCALE,
  airborneFraction,
  type CraterLaw,
  chargeEnergy,
  EXPLOSIVES,
  type EnergyBudget,
  energyBudget,
  type Explosive,
  GURNEY_FRACTION,
  type GroundOptions,
  type GurneyGeometry,
  gurneyVelocity,
  metalSpeed,
  SONDER_CRATER_LAW,
  scaledCraterRadius,
  scaledDepth,
  TNT_JOULES_PER_KG,
  tntEquivalent,
} from './charge.js';
export {
  type ChargeCase,
  type ChargeOptions,
  EXPLOSION_LAYOUT,
  EXPLOSION_WORDS,
  type ExplosionCounts,
  type ExplosionParams,
  ExplosionSolver,
  type ExplosionSolverOptions,
  FRAGMENT_WORDS,
  GUN_SAMPLES,
  type GunMount,
  HIT_WORDS,
  type HullPlate,
  type ImpactTarget,
} from './solver.js';
export {
  closedVesselPressure,
  type Firing,
  fireGun,
  type GunOptions,
  HISTORY_WORDS,
  type Propellant,
  PROPELLANTS,
} from './gun.js';
export { bedHeight, type FlightBed, flyFragments } from './flight.js';
