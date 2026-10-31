// The Plaza's public square, only in worlds whose generator URL has plaza=1 (server-generator.ts): a stone disc at the
// origin and a sign wall behind it. The deterministic views use generator.worker.ts, which never imports this, so their
// worlds and references stay as they are. Pure functions: the generator threads stamp the cells, and the shard's edit
// rule (server/shard.mjs) asks the same functions which cells are protected.
import { type BlockType, VoxelChunk } from '@margoengine/voxel';
import { noiseTerrain, type VoxelGenerate, type VoxelGenerateContext } from '@margoengine/voxel/generate';
import { terrainOptions } from './terrain.ts';

/** What the sign says, word for word. */
export const PLAZA_SIGN = 'Margo engine ❤️ made for Margie';
/** The sign's lines, top first; joined with spaces they are {@link PLAZA_SIGN}. */
export const PLAZA_SIGN_LINES: readonly string[] = ['Margo engine', '❤️ made for', 'Margie'];
/** Radius of the stone disc in blocks, around the origin. */
export const PLAZA_RADIUS = 24;
/** Cells up to this far above the floor are protected over the whole disc. */
export const PLAZA_HEADROOM = 12;
/** Stone under the floor, in blocks, so the square never floats over a valley. */
export const PLAZA_FOUNDATION = 32;

const HEART = '❤';
/** The sign's 5 x 7 glyphs, top row first; tests read the sign back with them. */
export const PLAZA_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  d: ['00001', '00001', '01101', '10011', '10001', '10001', '01111'],
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
  f: ['00110', '01001', '01000', '11100', '01000', '01000', '01000'],
  g: ['00000', '01111', '10001', '10001', '01111', '00001', '01110'],
  i: ['00100', '00000', '01100', '00100', '00100', '00100', '01110'],
  m: ['00000', '00000', '11010', '10101', '10101', '10001', '10001'],
  n: ['00000', '00000', '10110', '11001', '10001', '10001', '10001'],
  o: ['00000', '00000', '01110', '10001', '10001', '10001', '01110'],
  r: ['00000', '00000', '10110', '11001', '10000', '10000', '10000'],
  [HEART]: ['01010', '11111', '11111', '11111', '01110', '00100', '00000'],
};

const STEP = 6, // a glyph's width plus a gap
  LINE = 8, // a glyph's height plus a gap
  // The characters of a line that take space: the emoji's variation selector does not.
  charsOf = (line: string): string[] => [...line].filter((c) => c !== '️'),
  WIDEST = Math.max(...PLAZA_SIGN_LINES.map((line) => charsOf(line).length)),
  BOTTOM = 2, // first letter row above the floor
  APRON_Z = -10; // the floor before the wall reaches this far, so no hill stands in front of the letters

/** The wall's z; the letters stand one block in front of it, on the side that faces the disc. */
export const PLAZA_WALL_Z = -PLAZA_RADIUS - 1;
/** Half the wall's width: its x runs from minus this to this. */
export const PLAZA_WALL_HALF = Math.ceil((WIDEST * STEP - 1) / 2) + 2;
/** The wall's top above the floor. */
export const PLAZA_WALL_TOP = BOTTOM + PLAZA_SIGN_LINES.length * LINE - 1;

// Sign cells by 'x,height above the floor'. Text reads left to right from the disc, looking towards -z: towards +x.
const SIGN = new Map<string, 'letter' | 'heart'>();
PLAZA_SIGN_LINES.forEach((line, row) => {
  const chars = charsOf(line),
    left = -Math.floor((chars.length * STEP - 1) / 2),
    base = BOTTOM + (PLAZA_SIGN_LINES.length - 1 - row) * LINE;
  chars.forEach((char, i) => {
    if (char === ' ') return;
    const glyph = PLAZA_GLYPHS[char];
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 5; x++)
        if (glyph[y][x] === '1')
          SIGN.set(`${left + i * STEP + x},${base + 6 - y}`, char === HEART ? 'heart' : 'letter');
  });
});

const onDisc = (x: number, z: number): boolean => x * x + z * z <= PLAZA_RADIUS * PLAZA_RADIUS;
const onApron = (x: number, z: number): boolean => Math.abs(x) <= PLAZA_WALL_HALF && z >= PLAZA_WALL_Z && z <= APRON_Z;

/**
 * Whether a player may not change cell (x, y, z) in a world whose floor is at `floor`: the disc from the foundation up
 * to {@link PLAZA_HEADROOM} above the floor; the wall, the space before it and the block behind it up past the wall's
 * top. Above that, and everywhere else, players may build.
 */
export function isPlazaProtected(x: number, y: number, z: number, floor: number): boolean {
  if (y < floor - PLAZA_FOUNDATION) return false;
  if (onApron(x, z) || (Math.abs(x) <= PLAZA_WALL_HALF && z === PLAZA_WALL_Z - 1))
    return y <= floor + PLAZA_WALL_TOP + 1;
  return onDisc(x, z) && y <= floor + PLAZA_HEADROOM;
}

/** Whether a player may spawn at column (x, z): off the disc, and clear of the wall and the floor before it. */
export function isPlazaSpawnClear(x: number, z: number): boolean {
  return !onDisc(x, z) && !(Math.abs(x) <= PLAZA_WALL_HALF + 2 && z >= PLAZA_WALL_Z - 3 && z <= APRON_Z + 2);
}

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
              const cell = SIGN.get(`${wx},${up}`);
              if (cell) state = cell === 'heart' ? heart : letter;
            }
          }
          chunk.set(x, y, z, state);
        }
      }
    return Math.max(typeof ceiling === 'number' ? ceiling : 0, floor + PLAZA_WALL_TOP + 1);
  };
}
