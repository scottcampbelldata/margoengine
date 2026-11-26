// Ecosystem growth (entry `@margoengine/biomes/ecosystem`): plants that grow, compete for light, seed, age and die,
// year by year, so a few founders become a forest with gaps, cohorts and a canopy of the species that suit the light.
// An individual-based model in the line of JABOWA (Botkin, Janak and Wallis 1972) and SORTIE (Pacala et al. 1996):
// crowns grow logistically toward the species' largest crown; a crown is shaded by the overlap of taller crowns only
// (size-asymmetric competition, Weiner 1990, after the zone-of-influence idea of Bella 1971); growth falls with shade
// as the species' tolerance allows; mortality has a base rate, a senescence rate past the species' age, and a
// suppression rate that rises as growth falls (Pacala et al. 1996); adults seed in proportion to crown area, at
// distances drawn from Clark's 2Dt dispersal kernel (Clark et al. 1999). Everything is integers (centimetres,
// millimetres, Q16.16 shares) decided by world-anchored hashes, so the same start gives the same forest everywhere.
import { runEcosystem } from './ecosystem-model.js';
import type { BiomePlacement, PlacedTile } from './placement.js';

/** A species of an ecosystem, in plain units. */
export interface EcoSpecies {
  /** Id the plants name (a placement palette key such as `'temperate/oak'` works). */
  readonly id: string;
  /** Largest crown radius, metres, 0.1..40. */
  readonly radius: number;
  /** Logistic crown growth rate per year in full light, 0.01..2. Default 0.15. */
  readonly growth?: number;
  /** Typical lifespan, years, 2..3000; past it, a quarter die each year. Default 200. */
  readonly age?: number;
  /** Shade tolerance 0 (needs sun) to 1 (grows at half rate in deep shade and is rarely suppressed). Default 0.5. */
  readonly shade?: number;
  /** Seedlings per year from an adult at its largest crown (crown area scales it), 0..64. Default 4. */
  readonly seeds?: number;
  /** Dispersal scale of the 2Dt kernel, metres, 0.5..2000: half the seedlings land closer than it. Default 10. */
  readonly dispersal?: number;
  /** Share of the largest crown at which a plant starts to seed, 0..1. Default 0.4. */
  readonly maturity?: number;
}

/** A plant at the start or end of a run. Positions in metres; `radius` is the crown radius in metres. */
export interface EcoPlant {
  readonly species: string;
  readonly x: number;
  readonly z: number;
  /** Default: a seedling (5 cm, or the largest crown when smaller). */
  readonly radius?: number;
  /** Years. Default 0. */
  readonly age?: number;
  /** Year it died (standing dead), on output only. */
  readonly died?: number;
}

/** Settings of {@link growEcosystem}. */
export interface EcosystemOptions {
  /** Area `[x0, z0, x1, z1]` in metres where seedlings may establish (plants outside it still grow and shade). */
  readonly bounds: readonly [number, number, number, number];
  readonly species: readonly EcoSpecies[];
  readonly plants?: readonly EcoPlant[];
  /** Years to run, 0..2000. */
  readonly years: number;
  /** Integer seed of every decision. Default 0. */
  readonly seed?: number;
  /** How well a species' seedling does at x, z: 0..1 (it establishes with that chance). Default 1 everywhere. */
  readonly where?: (x: number, z: number, species: string) => number;
  /** Years a dead plant stands before it is gone, 0..200. Default 10. */
  readonly snags?: number;
  /** Most plants (living and dead) held; seedlings past it are not added and are counted. 1..1,000,000. Default 200,000. */
  readonly limit?: number;
}

/** One year of a run. */
export interface EcoYear {
  readonly year: number;
  readonly alive: number;
  readonly born: number;
  readonly died: number;
}

/** The forest after a run. */
export interface Ecosystem {
  readonly years: number;
  /** Living plants, then standing dead ones, each in order of birth. */
  readonly plants: readonly EcoPlant[];
  /** Living plants per species id. */
  readonly counts: Readonly<Record<string, number>>;
  readonly history: readonly EcoYear[];
  /** Seedlings not added because the plant limit was reached. */
  readonly crowded: number;
}

/**
 * Runs an ecosystem for `years` years from its plants (or from nothing but what seeds in, which is nothing): each year
 * every living plant is shaded by the taller crowns it overlaps, grows by what light reaches it, may die, and, once
 * mature, scatters seedlings. Plants are decided in order of birth with hashes of the seed, the plant and the year.
 * @throws RangeError or TypeError for bad options; RangeError for a plant naming no species.
 */
export function growEcosystem(options: EcosystemOptions): Ecosystem {
  return runEcosystem(options);
}

/**
 * The stored plants of a placed tile as ecosystem founders: each object's species key (`'<biome>/<species>'`), place
 * and crown (the species' reference radius times its scale). Rocks and props are left out; dead standing trees and
 * logs too.
 */
export function plantsFromTile(placement: BiomePlacement, tile: PlacedTile): EcoPlant[] {
  const radius = new Map(placement.species.filter((s) => s.kind === 'plant').map((s) => [s.key, s.radius])),
    out: EcoPlant[] = [];
  tile.forEachInstance((o) => {
    const r = radius.get(o.key);
    if (r !== undefined && o.age < 2) out.push({ species: o.key, x: o.x, z: o.z, radius: r * o.scale });
  });
  return out;
}
