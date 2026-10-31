// World generation settings shared by the page and the generator worker (plain data, no DOM).
import type { NoiseTerrainOptions } from '@margoengine/voxel/generate';

/** Seed of a new world when the URL names none. */
export const DEFAULT_SEED = 1;

/** The built-in noise terrain the generator worker extends with plants. */
export const terrainOptions = (seed: number): NoiseTerrainOptions => ({
  seed,
  seaLevel: 0,
  height: 8,
  amplitude: 32,
  scale: 192,
  caves: 0.3,
  trees: 0.012,
});

/**
 * The Plaza's terrain: {@link terrainOptions} with wider tunnels, only in plaza=1 worlds. The ground's heights do not
 * depend on `caves`, so a seed's square and spawn ring stay where they are.
 */
export const plazaTerrainOptions = (seed: number): NoiseTerrainOptions => ({ ...terrainOptions(seed), caves: 0.55 });

/** Plants scattered on grass: block name and chance per grass column (decided by a hash of the column). */
export const PLANTS: readonly (readonly [name: string, chance: number])[] = [
  ['tall_grass', 0.09],
  ['dandelion', 0.006],
  ['poppy', 0.006],
];
