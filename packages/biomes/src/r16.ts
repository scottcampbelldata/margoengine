// The reference world R16 (spec section 1.1): the fixed scene every biomes benchmark and quality report runs on. It is
// plain data, so the same world can be rebuilt anywhere and exported to other tools for like-for-like runs. Changing
// any value changes every published number; add a new reference world beside it instead.

/** The reference world R16: 16 km x 16 km at 1 m, coast, two river valleys, four presets, about 25 M stored objects. */
export const R16 = Object.freeze({
  /** Format tag of this description. */
  format: 'margo-biomes-reference/1',
  name: 'R16',
  seed: 16,
  /** World extent in metres, centred on the origin. */
  origin: Object.freeze([-8192, -8192] as const),
  size: Object.freeze([16384, 16384] as const),
  /** Tile size and field resolution in metres (spec decision D10). */
  tileSize: 256,
  resolution: 1,
  regionResolution: 16,
  /** Height: `createRelief` settings (seeded fractal lowlands, ridges, a western coast, two river valleys). */
  relief: Object.freeze({
    seed: 16,
    origin: Object.freeze([-8192, -8192] as const),
    size: Object.freeze([16384, 16384] as const),
    base: 140,
    relief: 1500,
    coast: 'west' as const,
    rivers: 2,
    seaDepth: 40,
  }),
  /** Climate settings (`ClimateOptions`). */
  climate: Object.freeze({ latitude: 47, seaLevel: 0, lapseRate: 6.5, rainfall: 1100, rainShadow: 0.6 }),
  /** Presets used, by id (from `@margoengine/biomes/presets`). */
  biomes: Object.freeze(['temperate', 'alpine', 'wetland', 'boreal'] as const),
  /** Target stored-object densities per km2 (B5 placement): forest trees and shrubs, and the world average. */
  density: Object.freeze({ forestTrees: 50_000, forestShrubs: 100_000, average: 100_000 }),
});
