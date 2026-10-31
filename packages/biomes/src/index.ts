// @margoengine/biomes: biome maps from a heightmap and a few climate settings. Everything that decides the output is
// integer arithmetic (spec decision D9), so the same seed gives the same bytes on every platform. The integer toolkit
// itself (fixed point, hashes, noise) is the `/toolkit` entry.
export type { IslandOptions, Relief, ReliefIsland, ReliefOptions, RiverLine, ValleyOptions } from './relief.js';
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
export type { PaintLayer, PaintMode, ZoneClassifier } from './classify.js';
export {
  type BiomeDefinition,
  type ClimateEnvelope,
  type ClusterRule,
  type StandRule,
  type ColorVariation,
  defineBiome,
  type DetailRule,
  type GroundLayer,
  type Range,
  type SizeDistribution,
  type SpeciesRule,
} from './define.js';
