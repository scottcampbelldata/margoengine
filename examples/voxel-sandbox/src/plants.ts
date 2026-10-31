// The sandbox's world generator: the built-in noiseTerrain, then plants (tall grass and flowers) on grass with open air
// above. The browser's generator worker and the multiplayer server (server.mjs) both run it, so they build one world.
import { type NoiseTerrainOptions, noiseTerrain, type VoxelGenerate } from '@margoengine/voxel/generate';
import { PLANTS, terrainOptions } from './terrain.ts';

/**
 * The generator of world `seed`; returns the column's ceiling, one higher than the terrain's for a plant. The Plaza
 * passes its own `options`; the page's worker and every deterministic view use the default.
 */
export function sandboxGenerator(seed: number, options: NoiseTerrainOptions = terrainOptions(seed)): VoxelGenerate {
  const terrain = noiseTerrain(options),
    total = PLANTS.reduce((sum, [, chance]) => sum + chance, 0);
  // An unsigned 32-bit hash of a column (different constants from the tree hash, so plants do not follow trees).
  const hash = (x: number, z: number): number => {
    let h = Math.imul(x, 0x27d4eb2f) ^ Math.imul(z, 0x165667b1) ^ Math.imul(seed, 0x2545f491);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  };
  return (chunk, cx, cy, cz, context) => {
    const ceiling = terrain(chunk, cx, cy, cz, context);
    const id = (name: string) => context.blocks.find((type) => type.name === name)?.id ?? 0,
      grass = id('grass'),
      plants = PLANTS.map(([name, chance]) => [id(name), chance] as const);
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++) {
        const roll = hash(cx * 32 + x, cz * 32 + z) / 4294967296;
        if (roll >= total) continue;
        // A plant stands on the column's grass when the cell above it is air in this chunk (grass in the top layer of
        // a chunk gets none: the cell above belongs to the next chunk).
        for (let y = 30; y >= 0; y--)
          if (chunk.get(x, y, z) === grass && chunk.get(x, y + 1, z) === 0) {
            let sum = 0;
            for (const [plant, chance] of plants)
              if (roll < (sum += chance)) {
                chunk.set(x, y + 1, z, plant);
                break;
              }
            break;
          }
      }
    return ceiling + 1;
  };
}
