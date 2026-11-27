// @margoengine/physics/explosive: explosive sources (FIRE-05). The charge's energy, its TNT equivalent, Gurney metal
// speeds and the air and ground shares of a buried charge.
export {
  AIR_DEPTH_SCALE,
  airborneFraction,
  chargeEnergy,
  EXPLOSIVES,
  type EnergyBudget,
  energyBudget,
  type Explosive,
  GURNEY_FRACTION,
  type GurneyGeometry,
  gurneyVelocity,
  metalSpeed,
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
  FRAGMENT_WORDS,
} from './solver.js';
