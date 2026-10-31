// The Plaza's public square, only in worlds whose generator URL has plaza=1 (server-generator.ts): a stone disc at the
// origin and a sign wall behind it. The deterministic views use generator.worker.ts, which never imports this, so their
// worlds and references stay as they are. The layout and the protection rule live in plaza-area.ts (re-exported here);
// this file adds what needs terrain: the floor, the spawn ring and the generator.
import { type BlockType, VoxelChunk } from '@margoengine/voxel';
import { noiseTerrain, type VoxelGenerate, type VoxelGenerateContext } from '@margoengine/voxel/generate';
import {
  isPlazaSpawnClear,
  onApron,
  onDisc,
  PLAZA_FOUNDATION,
  PLAZA_RADIUS,
  PLAZA_SIGN_BOTTOM,
  PLAZA_SIGN_CELLS,
  PLAZA_WALL_HALF,
  PLAZA_WALL_TOP,
  PLAZA_WALL_Z,
} from './plaza-area.ts';
import { terrainOptions } from './terrain.ts';

export * from './plaza-area.ts';

// A reader of natural ground heights in world `seed`: the highest rock of a column (trees do not count), or undefined
// when it is under the sea. Chunks are kept, since neighbouring columns share them.
function groundReader(seed: number, blocks: readonly BlockType[]): (x: number, z: number) => number | undefined {
  const options = terrainOptions(seed),
    terrain = noiseTerrain(options),
    context: VoxelGenerateContext = { blocks },
    rock = new Set(blocks.filter((b) => b.solid && b.name !== 'log' && b.name !== 'leaves').map((b) => b.id)),
    sea = options.seaLevel ?? 0,
    chunks = new Map<string, VoxelChunk>(),
    chunkAt = (cx: number, cy: number, cz: number): VoxelChunk => {
      const key = `${cx},${cy},${cz}`;
      let chunk = chunks.get(key);
      if (!chunk) {
        chunk = new VoxelChunk();
        terrain(chunk, cx, cy, cz, context);
        chunks.set(key, chunk);
      }
      return chunk;
    },
    top = terrain(new VoxelChunk(), 0, 0, 0, context);
  return (x, z) => {
    for (let cy = (top + 64) >> 5; (cy + 1) * 32 > sea; cy--) {
      const chunk = chunkAt(x >> 5, cy, z >> 5);
      for (let y = 31; y >= 0; y--)
        if (rock.has(chunk.get(x & 31, y, z & 31) & 0xffff)) {
          const height = cy * 32 + y;
          return height > sea ? height : undefined;
        }
    }
    return undefined;
  };
}

/**
 * The floor's height in world `seed`: the natural ground at the origin, and above the sea, so the same seed always gets
 * the same square.
 */
export function plazaFloor(seed: number, blocks: readonly BlockType[]): number {
  return Math.max(groundReader(seed, blocks)(0, 0) ?? 0, (terrainOptions(seed).seaLevel ?? 0) + 2);
}

/** Candidates on the ring from which {@link plazaSpawnRing} keeps the dry ones. */
export const PLAZA_RING_CANDIDATES = 64;

/**
 * Columns where players of world `seed` spawn: on the ring 40 to 60 blocks out, clear of the sign and on dry land, since
 * a server places a player on the highest rock of a column, which in the sea is its floor. Always the same for a seed;
 * empty when the whole ring is under water.
 */
export function plazaSpawnRing(seed: number, blocks: readonly BlockType[]): [x: number, z: number][] {
  const ground = groundReader(seed, blocks),
    ring: [number, number][] = [];
  for (let i = 0; i < PLAZA_RING_CANDIDATES; i++) {
    const angle = (i / PLAZA_RING_CANDIDATES) * 2 * Math.PI,
      radius = 40 + ((i * 7) % 21), // 40 to 60, not in step with the angle
      x = Math.round(Math.cos(angle) * radius),
      z = Math.round(Math.sin(angle) * radius);
    if (isPlazaSpawnClear(x, z) && ground(x, z) !== undefined) ring.push([x, z]);
  }
  return ring;
}

/** `generate` with the square stamped on it, in world `seed`. */
export function plazaGenerator(generate: VoxelGenerate, seed: number): VoxelGenerate {
  let floor: number | undefined;
  return async (chunk, cx, cy, cz, context) => {
    const ceiling = await generate(chunk, cx, cy, cz, context),
      reach = Math.max(PLAZA_RADIUS, PLAZA_WALL_HALF),
      x0 = cx * 32,
      z0 = cz * 32;
    // Chunk columns outside the footprint keep the terrain's chunks and ceiling.
    if (x0 > reach || x0 + 31 < -reach || z0 > PLAZA_RADIUS || z0 + 31 < PLAZA_WALL_Z) return ceiling;
    floor ??= plazaFloor(seed, context.blocks);
    const id = (name: string): number => {
        const type = context.blocks.find((b) => b.name === name);
        if (!type) throw new RangeError(`plazaGenerator needs a block named ${name}; use defineBlocks from blocks.ts`);
        return type.id;
      },
      stone = id('stone'),
      planks = id('planks'),
      letter = id('glowstone'),
      heart = id('heart_red'),
      bottom = floor - PLAZA_FOUNDATION;
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++) {
        const wx = x0 + x,
          wz = z0 + z;
        if (!onDisc(wx, wz) && !onApron(wx, wz)) continue;
        for (let y = 0; y < 32; y++) {
          const wy = cy * 32 + y,
            up = wy - floor;
          if (wy < bottom) continue;
          let state = up <= 0 ? stone : 0;
          if (up > 0 && up <= PLAZA_WALL_TOP) {
            if (wz === PLAZA_WALL_Z) state = planks;
            else if (wz === PLAZA_WALL_Z + 1) {
              const cell = PLAZA_SIGN_CELLS.get(`${wx},${up}`);
              if (cell) state = cell === 'heart' ? heart : letter;
            }
          }
          chunk.set(x, y, z, state);
        }
      }
    return Math.max(typeof ceiling === 'number' ? ceiling : 0, floor + PLAZA_WALL_TOP + 1);
  };
}
