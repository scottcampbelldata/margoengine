// What a Plaza world hides under the hills: cave mouths with a way back up, glow caps on cave floors, ore veins and the
// opals, only in plaza=1 worlds (plaza.ts stamps them; generator.worker.ts never imports this). Pure: no DOM, and every
// stamp follows from the seed and the coordinates alone, so a chunk comes out the same in any order. To know the ground
// and the tunnels without generating a chunk, it evaluates the same fields as noiseTerrain (generate.ts); finds.test.js
// compares both against generated terrain, so a change there fails here.
import { fbm, Noise } from '@margoengine/procedural/noise';
import type { BlockType, VoxelChunk } from '@margoengine/voxel';
import { GEM_TOTAL, isPlazaSpawnClear, PLAZA_RING_CANDIDATES, plazaRingColumn } from './plaza-area.ts';
import { plazaTerrainOptions } from './terrain.ts';

/** Gems lie within this many blocks of the origin. */
export const GEM_RADIUS = 512;
/** How far under the surface a gem may lie, in blocks. */
export const GEM_DEPTH: readonly [min: number, max: number] = [3, 40];
/** Chunk columns this close to the origin always get a mouth, so someone new finds one near the spawn ring. */
export const MOUTH_SURE_RADIUS = 128;
const MOUTH_CHANCE = 0.64, // about 1 per 40 x 40 blocks, in chunk columns of 32 x 32
  MOUTH_TRIES = 6,
  MOUTH_SURE_TRIES = 48,
  MOUTH_DEPTH = 8,
  GLOW_CAP_CHANCE = 1 / 16;

/** A vein type: block, depth band under the surface (inclusive), chance per 4 x 4 x 4 cell group, blob radius. */
export const VEINS: readonly (readonly [name: string, min: number, max: number, chance: number, radius: number])[] = [
  ['tin_ore', 2, 24, 0.024, 2.1],
  ['silver_ore', 8, 40, 0.01, 1.7],
  ['malachite_ore', 4, 30, 0.014, 1.9],
  ['amber', 1, 6, 0.04, 1.8],
];

// A cave mouth: its centre column, the ground there and the first tunnel cell under it.
interface Mouth {
  readonly x: number;
  readonly z: number;
  readonly top: number;
  readonly bottom: number;
}

/** The rim of a 3 x 3 shaft, in walking order: a ramp climbs it one block per cell. */
const RIM: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
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

// noiseTerrain's tree rule: a column whose hash passes may grow a trunk.
const treeHash = (x: number, z: number, seed: number): number => {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};

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
  readonly #treeCut: number;
  #gems: Map<string, [x: number, y: number, z: number][]> | undefined;

  constructor(seed: number) {
    const options = plazaTerrainOptions(seed),
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
    this.#treeCut = (options.trees ?? 0) * 4294967296;
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

  /** The cave mouth of chunk column (cx, cz), or undefined: at most one, inside its chunk column. */
  mouth(cx: number, cz: number): Mouth | undefined {
    const seed = this.#seed,
      mx = cx * 32 + 16,
      mz = cz * 32 + 16,
      sure = mx * mx + mz * mz <= MOUTH_SURE_RADIUS * MOUTH_SURE_RADIUS;
    if (!sure && unit(hashCell(cx, 0, cz, seed, 0x41)) >= MOUTH_CHANCE) return undefined;
    const tries = sure ? MOUTH_SURE_TRIES : MOUTH_TRIES;
    next: for (let t = 0; t < tries; t++) {
      const h = hashCell(cx, t, cz, seed, 0x42),
        x = cx * 32 + 2 + ((h & 0xffff) % 28),
        z = cz * 32 + 2 + ((h >>> 16) % 28),
        top = this.#surface(x, z);
      if (top <= this.#sea + 3) continue;
      for (let dz = -2; dz <= 2; dz++)
        for (let dx = -2; dx <= 2; dx++) {
          const wx = x + dx,
            wz = z + dz;
          // Off the square and the ring, under no tree (a hole under a trunk leaves it hanging), and on fairly level
          // ground, so the rim reads as one rim.
          if (!isFindsClear(wx, wz) || Math.abs(this.#surface(wx, wz) - top) > 2) continue next;
          if (treeHash(wx, wz, seed) < this.#treeCut) continue next;
        }
      for (let bottom = top - 2; bottom >= top - MOUTH_DEPTH; bottom--)
        if (bottom > this.#sea + 1 && this.isTunnel(x, bottom, z)) return { x, z, top, bottom };
    }
    return undefined;
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

    this.#stampMouth(chunk, cx, cy, cz, stone, glowCap);

    const gems = this.gems.get(gemChunkKey(cx, cy, cz));
    if (gems) for (const [x, y, z] of gems) chunk.set(x & 31, y & 31, z & 31, opal);
  }

  // A 3 x 3 shaft with a ramp up its rim, a stone lip around it and glow caps on its floor and on the ramp.
  #stampMouth(chunk: VoxelChunk, cx: number, cy: number, cz: number, stone: number, glowCap: number): void {
    const mouth = this.mouth(cx, cz);
    if (!mouth) return;
    const { x, z, top, bottom } = mouth,
      y0 = cy * 32,
      lx = x - cx * 32,
      lz = z - cz * 32;
    if (top + 2 < y0 || bottom - 17 > y0 + 31) return;
    const set = (ax: number, y: number, az: number, state: number): void => {
        const ly = y - y0;
        if (ly >= 0 && ly < 32) chunk.set(ax, ly, az, state);
      },
      depth = top - bottom;
    // Clear the shaft from the tunnel up through the ground and whatever plant stands on it.
    for (let y = bottom; y <= top + 1; y++) set(lx, y, lz, 0);
    RIM.forEach(([dx, dz], i) => {
      const tread = bottom + Math.floor((i * depth) / RIM.length);
      for (let y = tread + 1; y <= top + 1; y++) set(lx + dx, y, lz + dz, 0);
      set(lx + dx, tread, lz + dz, stone);
    });
    // The lip: stone at each ring column's own ground.
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;
        const ax = x + dx,
          az = z + dz,
          ground = this.#surface(ax, az);
        set(lx + dx, ground, lz + dz, stone);
        // Two corners carry a glow cap, so the mouth shows across a hill by day and glows at night.
        set(lx + dx, ground + 1, lz + dz, dx === dz && Math.abs(dx) === 2 ? glowCap : 0);
      }
    // A light at the bottom, on whatever the tunnel's floor is, and one on the ramp, so the hole glows at night.
    let floor = bottom;
    for (let step = 0; step < 16 && this.isTunnel(x, floor - 1, z); step++) floor--;
    set(lx, floor, lz, glowCap);
    // Opposite corners of the ramp, so one faces whoever looks in from any side.
    for (const i of [2, 6]) {
      const [rx, rz] = RIM[i];
      set(lx + rx, bottom + Math.floor((i * depth) / RIM.length) + 1, lz + rz, glowCap);
    }
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
