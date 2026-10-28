// @margoengine/biomes: biome maps from a heightmap and a few climate settings. Everything that decides the output is
// integer arithmetic (spec decision D9), so the same seed gives the same bytes on every platform.
export {
  ONE,
  TURN,
  atan2,
  clampInt,
  degreesToAngle,
  divFloor,
  divWide,
  fade,
  idiv,
  imod,
  isqrt,
  mul64,
  mulHigh,
  mulShift,
  qdiv,
  qexp2,
  qlog2,
  qmul,
  qacos,
  qpow,
  qsqrt,
  sincos,
  udiv,
  umod,
  wendland,
} from './fixed.js';
export { fbm, hash2, hash3, hash4, hash5, pcg, ridged, valueNoise } from './hash.js';
export { createRelief, quantizeHeights, type Relief, type ReliefOptions, type RiverLine } from './relief.js';
export { R16 } from './r16.js';
export {
  continentality,
  degreeDays,
  evapotranspiration,
  halfAmplitude,
  heatLoad,
  moistureIndex,
  quantizeClimate,
  seasonMean,
  treelineMargin,
  type Climate,
  type ClimateOptions,
} from './climate.js';
export type { HeightSource } from './height.js';
export { DEFAULT_LAYERS, LAYERS, type LayerFormat, type LayerInfo, type RasterLayer } from './layers.js';
export { distanceTransform, priorityFlood } from './region.js';
export type { BiomeSample } from './sample.js';
export { BiomeWorld, type BiomeTile, type BiomeWorldOptions, type LayerWrite, type TileRequest } from './world.js';
export {
  biotemperature,
  HOLDRIDGE_BELTS,
  HOLDRIDGE_HUMIDITY,
  holdridgeZone,
  type PaintLayer,
  type PaintMode,
  WHITTAKER,
  whittakerClass,
} from './classify.js';
export {
  type BiomeDefinition,
  type ClimateEnvelope,
  type ClusterRule,
  type ColorVariation,
  defineBiome,
  type DetailRule,
  type GroundLayer,
  type Range,
  type SizeDistribution,
  type SpeciesRule,
} from './define.js';
