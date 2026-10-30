// How far a change of a biome world's inputs can move its stored objects, shared by placement (to drop cached tiles)
// and the editor (to report dirty rectangles). Luby's rounds settle a candidate from the candidates within 2 spacings
// per round, each layer also reads earlier layers within the spacing between layers and the crowns over it, and canopy
// layers and crown cover read the trees of their 32 m cell and the crowns that overhang a cell.
import type { BiomeDefinition, SpeciesRule } from './define.js';

/** Placement layer of a plant by its crown radius: 1 canopy (2.5 m and up), 2 understory (1 to 2.5 m), 3 shrubs. */
export const STRATA = (radius: number): number => (radius >= 2.5 ? 1 : radius >= 1 ? 2 : 3);

/** The largest crown multiplier of a species' size distribution (scale 1 without one). */
export const largest = (rule: SpeciesRule): number =>
  rule.size?.kind === 'reverse-j' ? rule.size.max : rule.size?.kind === 'weibull' ? (3 * rule.size.scale) ** 0.75 : 1;

/**
 * Metres around an input change within which stored objects can change, for `rounds` Luby rounds and the default
 * spacing (0.85 of the summed crowns within a layer, 0.3 across layers); `within` and `across` override the factors.
 */
export function placementReach(
  biomes: readonly BiomeDefinition[],
  rounds: number,
  within = 0.85,
  across = 0.3,
): number {
  const crown = [0, 0, 0, 0, 0];
  for (const b of biomes)
    for (const [list, kind] of [
      [b.rocks, 0],
      [b.plants, -1],
      [b.props, 4],
    ] as const)
      for (const rule of list ?? []) {
        const layer = kind < 0 ? STRATA(rule.radius) : kind;
        crown[layer] = Math.max(crown[layer], rule.radius * largest(rule));
      }
  const reach: number[] = [];
  let widest = 0;
  for (let s = 0; s < 5; s++) {
    let before = 0;
    for (let t = 0; t < s; t++)
      if (crown[t]) before = Math.max(before, reach[t] + Math.max(across * (crown[s] + crown[t]), crown[t]));
    reach.push(crown[s] ? 2 * rounds * within * 2 * crown[s] + before : before);
    widest = Math.max(widest, crown[s]);
  }
  return Math.max(...reach) + 32 + widest;
}

/** Half width in cells of the paint feather of an ecotone `metres` wide at `resolution` metres per cell. */
export const featherCells = (metres: number, resolution: number): number => Math.floor(metres / (2 * resolution)); // float division: options to whole cells

/**
 * Cells around a user layer change that its classification can reach: the 1-cell blur, or the paint feather's box
 * and warp (twice its half width) when that is wider.
 */
export const paintReach = (metres: number, resolution: number): number =>
  Math.max(1, 2 * featherCells(metres, resolution));
