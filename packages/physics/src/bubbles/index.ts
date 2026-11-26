// `@margoengine/physics/bubbles`: bubbles in the water (FW-4; SEA-13's plumes): the cloud and aerated plume a ship's
// propeller and stern leave, and any air the water takes in, as parcels carried by the water's flow, rising, swelling,
// dissolving and laying foam where they surface.
export {
  AIR_DIFFUSIVITY,
  AIR_HENRY,
  airDensity,
  BUBBLE_RADII,
  BubbleSolver,
  dissolution,
  PARCEL_WORDS,
  riseSpeed,
  SEA_VISCOSITY_KINEMATIC,
  shipAeration,
  spectrumShares,
  type BubbleFoam,
  type BubbleParams,
  type BubbleSource,
} from './solver.js';
