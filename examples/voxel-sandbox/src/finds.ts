// What a Plaza world hides under the hills: glow caps on cave floors, ore veins and the
// opals, only in plaza=1 worlds (plaza.ts stamps them; generator.worker.ts never imports this). Pure: no DOM, and every
// stamp follows from the seed and the coordinates alone, so a chunk comes out the same in any order. To know the ground
// and the tunnels without generating a chunk, it evaluates the same fields as noiseTerrain (generate.ts); finds.test.js
// compares both against generated terrain, so a change there fails here.
import { fbm, Noise } from '@margoengine/procedural/noise';
import type { BlockType, VoxelChunk } from '@margoengine/voxel';
import { GEM_TOTAL, isPlazaSpawnClear, PLAZA_RING_CANDIDATES, plazaRingColumn } from './plaza-area.ts';
import { terrainOptions } from './terrain.ts';

/** Gems lie within this many blocks of the origin. */
export const GEM_RADIUS = 512;
/** How far under the surface a gem may lie, in blocks. */
export const GEM_DEPTH: readonly [min: number, max: number] = [3, 40];

const GLOW_CAP_CHANCE = 1 / 16;

/** A vein type: block, depth band under the surface (inclusive), chance per 4 x 4 x 4 cell group, blob radius. */
export const VEINS: readonly (readonly [name: string, min: number, max: number, chance: number, radius: number])[] = [
  ['tin_ore', 2, 24, 0.024, 2.1],
  ['silver_ore', 8, 40, 0.01, 1.7],
  ['malachite_ore', 4, 30, 0.014, 1.9],
  ['amber', 1, 6, 0.04, 1.8],
];

// An unsigned 32-bit hash of a cell, a seed and a salt (each use of it has its own salt).
const hashCell = (x: number, y: number, z: number, seed: number, salt: number): number => {
  let h =
    Math.imul(x, 0x2f0b4a87) ^ Math.imul(y, 0x4cf5ad43) ^ Math.imul(z, 0x7a1cd9e5) ^ Math.imul(seed ^ salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};
const unit = (h: number): number => h / 4294967296;

// mulberry32, the same small seeded generator as textures.ts.
const generator = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const lerp = (p: number, q: number, t: number): number => p + (q - p) * t;

const ringColumns = new Set(
  Array.from({ length: PLAZA_RING_CANDIDATES }, (_, i) => {
    const [x, z] = plazaRingColumn(i);
    return `${x},${z}`;
  }),
);

/** Whether finds may touch column (x, z): off the square, the sign and every spawn ring column. */
export const isFindsClear = (x: number, z: number): boolean => isPlazaSpawnClear(x, z) && !ringColumns.has(`${x},${z}`);

/** The chunk key a {@link PlazaFinds.gems} entry is stored under. */
export const gemChunkKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

/** The finds of one world. */
export class PlazaFinds {
  readonly #seed: number;
  readonly #sea: number;
  readonly #surface: (x: number, z: number) => number;
  readonly #tunnelA: Noise;
  readonly #tunnelB: Noise;
  readonly #width: number;
  #gems: Map<string, [x: number, y: number, z: number][]> | undefined;

  constructor(seed: number) {
    const options = terrainOptions(seed),
      ground = new Noise(seed),
      relief = fbm((x: number, z: number) => ground.simplex2(x, z), {
        octaves: 5,
        frequency: 1 / (options.scale ?? 192),
      }),
      height = options.height ?? 8,
      amplitude = options.amplitude ?? 32;
    this.#seed = seed;
    this.#sea = options.seaLevel ?? 0;
    this.#surface = (x, z) => Math.floor(height + amplitude * relief(x, z));
    this.#tunnelA = new Noise(seed ^ 0x5bd1e995);
    this.#tunnelB = new Noise(seed ^ 0x1b873593);
    this.#width = 0.3 * (options.caves ?? 0.3);
  }

  /** The natural ground's height at column (x, z), without generating anything. */
  surface(x: number, z: number): number {
    return this.#surface(x, z);
  }

  /** Whether the tunnel fields open cell (x, y, z), given that it lies under its column's top block. */
  isTunnel(x: number, y: number, z: number): boolean {
    return (
      Math.abs(this.#field(this.#tunnelA, x, y, z)) < this.#width &&
      Math.abs(this.#field(this.#tunnelB, x, y, z)) < this.#width
    );
  }

  // The field noiseTerrain samples every 4 cells and blends.
  #field(noise: Noise, x: number, y: number, z: number): number {
    const i = x & ~3,
      j = y & ~3,
      k = z & ~3,
      u = (x & 3) / 4,
      v = (y & 3) / 4,
      w = (z & 3) / 4,
      at = (a: number, b: number, c: number): number => noise.simplex(a / 64, b / 40, c / 64);
    return lerp(
      lerp(lerp(at(i, j, k), at(i + 4, j, k), u), lerp(at(i, j + 4, k), at(i + 4, j + 4, k), u), v),
      lerp(lerp(at(i, j, k + 4), at(i + 4, j, k + 4), u), lerp(at(i, j + 4, k + 4), at(i + 4, j + 4, k + 4), u), v),
      w,
    );
  }

  /**
   * Every opal cell by {@link gemChunkKey}, exactly {@link GEM_TOTAL} of them. Each sits on the floor of a tunnel within
   * {@link GEM_RADIUS}, so a player walking the caves can see it, on dry land, {@link GEM_DEPTH} under the surface, and
   * off the square. Worked out once from the seed, without generating a chunk.
   */
  get gems(): ReadonlyMap<string, readonly (readonly [x: number, y: number, z: number])[]> {
    if (this.#gems) return this.#gems;
    const gems = new Map<string, [number, number, number][]>(),
      used = new Set<string>(),
      random = generator(this.#seed ^ 0x6f70616c);
    let count = 0;
    while (count < GEM_TOTAL) {
      const angle = random() * 2 * Math.PI,
        radius = Math.sqrt(random()) * GEM_RADIUS,
        x = Math.floor(Math.cos(angle) * radius),
        z = Math.floor(Math.sin(angle) * radius),
        pick = random();
      if (!isFindsClear(x, z)) continue;
      const top = this.#surface(x, z);
      if (top <= this.#sea + 1) continue;
      let y = top - GEM_DEPTH[0] - Math.floor(pick * (GEM_DEPTH[1] - GEM_DEPTH[0] + 1));
      if (!this.isTunnel(x, y, z)) continue;
      // Down to the rock under this bit of tunnel: the gem is that cell.
      for (let step = 0; step < 16 && this.isTunnel(x, y, z); step++) y--;
      if (top - y > GEM_DEPTH[1] || this.isTunnel(x, y, z)) continue;
      const key = `${x},${y},${z}`;
      if (used.has(key)) continue;
      used.add(key);
      const chunk = gemChunkKey(x >> 5, y >> 5, z >> 5);
      if (!gems.has(chunk)) gems.set(chunk, []);
      gems.get(chunk)?.push([x, y, z]);
      count++;
    }
    this.#gems = gems;
    return gems;
  }

  /** Whether cell (x, y, z) holds one of the world's opals when generated. */
  isGem(x: number, y: number, z: number): boolean {
    const list = this.gems.get(gemChunkKey(x >> 5, y >> 5, z >> 5));
    return !!list?.some(([a, b, c]) => a === x && b === y && c === z);
  }

  /** Stamps the finds of chunk (cx, cy, cz) on it, over what the terrain wrote. */
  stamp(chunk: VoxelChunk, cx: number, cy: number, cz: number, blocks: readonly BlockType[]): void {
    const id = (name: string): number => {
        const type = blocks.find((b) => b.name === name);
        if (!type) throw new RangeError(`plazaFinds needs a block named ${name}; use defineBlocks from blocks.ts`);
        return type.id;
      },
      x0 = cx * 32,
      y0 = cy * 32,
      z0 = cz * 32,
      stone = id('stone'),
      dirt = id('dirt'),
      sand = id('sand'),
      glowCap = id('glow_cap'),
      opal = id('opal'),
      veinIds = VEINS.map(([name]) => id(name)),
      // A column's height once, and only for the few columns that need one.
      heights = new Map<number, number>(),
      surfaceAt = (x: number, z: number): number => {
        const key = x + z * 32;
        let h = heights.get(key);
        if (h === undefined) {
          h = this.#surface(x0 + x, z0 + z);
          heights.set(key, h);
        }
        return h;
      },
      seed = this.#seed;

    // Veins: each 4 x 4 x 4 group rolls for a type, and a blob around a shifted centre replaces rock inside the band.
    for (let gz = 0; gz < 8; gz++)
      for (let gy = 0; gy < 8; gy++)
        for (let gx = 0; gx < 8; gx++) {
          const wx = x0 + gx * 4,
            wy = y0 + gy * 4,
            wz = z0 + gz * 4,
            h = hashCell(wx, wy, wz, seed, 0x43);
          let roll = unit(h),
            type = -1;
          for (let v = 0; v < VEINS.length; v++) {
            roll -= VEINS[v][3];
            if (roll < 0) {
              type = v;
              break;
            }
          }
          if (type < 0) continue;
          const [, min, max, , radius] = VEINS[type],
            state = veinIds[type],
            amber = VEINS[type][0] === 'amber',
            mx = 1 + ((h >>> 3) & 1),
            my = 1 + ((h >>> 5) & 1),
            mz = 1 + ((h >>> 7) & 1);
          for (let lz = 0; lz < 4; lz++)
            for (let lx = 0; lx < 4; lx++)
              for (let ly = 0; ly < 4; ly++) {
                const distance = (lx - mx) ** 2 + (ly - my) ** 2 + (lz - mz) ** 2;
                if (distance > radius * radius) continue;
                const x = gx * 4 + lx,
                  y = gy * 4 + ly,
                  z = gz * 4 + lz,
                  was = chunk.get(x, y, z);
                if (amber ? was !== dirt && was !== sand : was !== stone) continue;
                if (unit(hashCell(wx + lx, wy + ly, wz + lz, seed, 0x44)) > 0.8) continue;
                const depth = surfaceAt(x, z) - (wy + ly);
                if (depth < min || depth > max || !isFindsClear(x0 + x, z0 + z)) continue;
                chunk.set(x, y, z, state);
              }
        }

    // Glow caps on tunnel floors: an air cell under its column's top, on rock.
    const floor = new Set([stone, dirt, ...veinIds]);
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++)
        for (let y = 1; y < 32; y++) {
          if (chunk.get(x, y, z) !== 0 || !floor.has(chunk.get(x, y - 1, z))) continue;
          if (unit(hashCell(x0 + x, y0 + y, z0 + z, seed, 0x45)) >= GLOW_CAP_CHANCE) continue;
          if (y0 + y < surfaceAt(x, z) && isFindsClear(x0 + x, z0 + z)) chunk.set(x, y, z, glowCap);
        }

    const gems = this.gems.get(gemChunkKey(cx, cy, cz));
    if (gems) for (const [x, y, z] of gems) chunk.set(x & 31, y & 31, z & 31, opal);
  }
}

let last: PlazaFinds | undefined,
  lastSeed = 0;

/** The finds of world `seed`; the last one is kept, since a server thread asks for one world at a time. */
export function plazaFinds(seed: number): PlazaFinds {
  if (!last || lastSeed !== seed) {
    last = new PlazaFinds(seed);
    lastSeed = seed;
  }
  return last;
}
