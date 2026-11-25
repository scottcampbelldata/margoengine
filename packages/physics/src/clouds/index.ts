// `@margoengine/physics/clouds`: the physics framework's clouds (docs/physics-solvers.md, ATMO-03): moist convection in a box
// of air, with Kessler's warm rain.
export {
  AIR_HEAT_CAPACITY,
  CLOUD_LAYOUT,
  CLOUD_WATER_FIELD,
  CloudSolver,
  LATENT_HEAT,
  condense,
  rainSpeed,
  saturation,
  type CloudBubble,
  type CloudParams,
  type CloudRain,
  type CloudSample,
} from './convection.js';
