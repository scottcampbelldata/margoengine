// A small fixed build for the deterministic views (?view=): a plank hut with glass windows, a brick and cobblestone
// roof, torches and a glowstone lamp post, so screenshots show block light, glass and cutout plants; or, for
// ?view=shapes, slabs and stairs on the same yard. Built on the ground it finds, with a cobblestone footing down to it.
// Only deterministic views place them (a saved world never gets them).
import {
  type BlockTypes,
  connectStairs,
  doubleSlabState,
  slabState,
  stairState,
  type VoxelWorld,
  waterlogState,
} from '@margoengine/voxel';

// The cells groundY searches by default, top to bottom.
const GROUND_TOP = 96,
  GROUND_BOTTOM = -64;

/** Highest solid block of column (x, z) at or below `from`, or undefined while that part of the world is not loaded. */
export function groundY(
  world: VoxelWorld,
  x: number,
  z: number,
  from = GROUND_TOP,
  to = GROUND_BOTTOM,
): number | undefined {
  const { blocks } = world;
  for (let y = from; y >= to; y--) {
    if (!world.getChunk(x >> 5, y >> 5, z >> 5)) return undefined;
    const type = blocks.get(world.getBlock(x, y, z) & 0xffff);
    if (type.solid && type.shape === 'cube' && type.name !== 'leaves' && type.name !== 'log') return y;
  }
  return undefined;
}

/**
 * True once every chunk the hut at (x, z) can touch is loaded, including every chunk `groundY` reads under its yard
 * (cells GROUND_BOTTOM..GROUND_TOP), so the build never runs on ground that is still missing.
 */
export function showcaseReady(world: VoxelWorld, x: number, z: number): boolean {
  for (let cz = (z - 3) >> 5; cz <= (z + 9) >> 5; cz++)
    for (let cx = (x - 3) >> 5; cx <= (x + 9) >> 5; cx++)
      for (let cy = GROUND_BOTTOM >> 5; cy <= GROUND_TOP >> 5; cy++) if (!world.getChunk(cx, cy, cz)) return false;
  return true;
}

// The yard at column (x, z): returns its base level (one above the highest ground under it) and puts its footing
// (cobblestone under the 7 x 7 floor, dirt with grass on top around it) and air above it.
function yard(world: VoxelWorld, blocks: BlockTypes, x: number, z: number, put: (...cell: number[]) => void): number {
  const cobble = blocks.id('cobblestone');
  let base = -Infinity;
  for (let dz = -2; dz <= 8; dz++)
    for (let dx = -2; dx <= 8; dx++) base = Math.max(base, groundY(world, x + dx, z + dz) ?? -Infinity);
  if (base === -Infinity)
    throw new RangeError(
      `No ground under the showcase yard at (${x}, ${z}) in y ${GROUND_BOTTOM}..${GROUND_TOP}; wait for showcaseReady() and build it over land`,
    );
  base += 1;
  for (let dz = -2; dz <= 8; dz++)
    for (let dx = -2; dx <= 8; dx++) {
      const ground = groundY(world, x + dx, z + dz) ?? base - 1,
        inside = dx >= 0 && dx <= 6 && dz >= 0 && dz <= 6;
      for (let y = ground + 1; y < base; y++) put(x + dx, y, z + dz, inside ? cobble : blocks.id('dirt'));
      if (!inside && ground + 1 <= base - 1) put(x + dx, base - 1, z + dz, blocks.id('grass'));
      for (let y = base; y < base + 8; y++) put(x + dx, y, z + dz, 0);
    }
  return base;
}

/** Builds the hut with its south-west corner at column (x, z) on the highest ground under its footprint. */
export function buildShowcase(world: VoxelWorld, blocks: BlockTypes, x: number, z: number): void {
  const id = (name: string) => blocks.id(name),
    [planks, log, glass, cobble, torch, glowstone, bricks, poppy, dandelion] = [
      'planks',
      'log',
      'glass',
      'cobblestone',
      'torch',
      'glowstone',
      'bricks',
      'poppy',
      'dandelion',
    ].map(id),
    edits: number[] = [],
    put = (px: number, py: number, pz: number, state: number) => edits.push(px, py, pz, state);
  // Footing and a cleared yard: cobblestone under the floor down to the ground, air above the yard.
  const base = yard(world, blocks, x, z, put);
  for (let dz = 0; dz <= 6; dz++)
    for (let dx = 0; dx <= 6; dx++) {
      const wall = dx === 0 || dx === 6 || dz === 0 || dz === 6,
        corner = (dx === 0 || dx === 6) && (dz === 0 || dz === 6);
      put(x + dx, base - 1, z + dz, planks);
      for (let h = 0; h < 4; h++) {
        const y = base + h,
          window = h >= 1 && h <= 2 && (dx === 2 || dx === 4 || dz === 2 || dz === 4),
          door = dz === 6 && dx === 3 && h <= 1;
        if (corner) put(x + dx, y, z + dz, log);
        else if (wall && !door) put(x + dx, y, z + dz, window ? glass : planks);
      }
      put(x + dx, base + 4, z + dz, wall ? bricks : cobble);
    }
  // Light: glowstone in the floor, a torch on each side of the door (south side), a lamp post in the yard.
  put(x + 3, base - 1, z + 3, glowstone);
  put(x + 2, base, z + 7, torch);
  put(x + 4, base, z + 7, torch);
  put(x + 8, base, z + 8, log);
  put(x + 8, base + 1, z + 8, log);
  put(x + 8, base + 2, z + 8, glowstone);
  put(x - 1, base, z + 7, poppy);
  put(x + 7, base, z + 5, dandelion);
  put(x + 1, base, z + 8, poppy);
  put(x + 6, base, z + 8, dandelion);
  world.setBlocks(edits);
}

/**
 * Builds the slab and stair yard with its south-west corner at column (x, z): a plank deck on log posts under a roof
 * of top slabs with an eave of upside-down stairs, a cobblestone flight up to it whose steps face +x, a stone slab
 * terrace starting with a double slab, a brick column ringed by stairs that turn into inner and outer corners, a pool
 * holding a waterlogged slab and stair, and a torch under the deck.
 */
export function buildShapes(world: VoxelWorld, blocks: BlockTypes, x: number, z: number): void {
  const id = (name: string) => blocks.id(name),
    [planks, log, cobble, bricks, torch, slab, plankSlab, stairs, brickStairs] = [
      'planks',
      'log',
      'cobblestone',
      'bricks',
      'torch',
      'stone_slab',
      'planks_slab',
      'cobblestone_stairs',
      'brick_stairs',
    ].map(id),
    edits: number[] = [],
    put = (px: number, py: number, pz: number, state: number) => edits.push(px, py, pz, state);
  const base = yard(world, blocks, x, z, put);
  // The deck (dx 0-3, dz 0-4) at base + 2 on log posts, and its roof of top slabs at base + 5 on log posts.
  for (let dz = 0; dz <= 4; dz++)
    for (let dx = 0; dx <= 3; dx++) {
      const corner = (dx === 0 || dx === 3) && (dz === 0 || dz === 4);
      put(x + dx, base + 2, z + dz, planks);
      put(x + dx, base + 5, z + dz, slabState(plankSlab, true));
      if (corner) for (const y of [base, base + 1, base + 3, base + 4]) put(x + dx, y, z + dz, log);
    }
  // An eave of upside-down stairs along the roof's +x and +z edges, their backs against it.
  for (let dz = 0; dz <= 4; dz++) put(x + 4, base + 5, z + dz, stairState(stairs, '-x', true));
  for (let dx = 0; dx <= 3; dx++) put(x + dx, base + 5, z + 5, stairState(stairs, '-z', true));
  // The flight: three stairs climbing toward -x (backs to -x) onto the deck, on cobblestone.
  for (let dz = 1; dz <= 3; dz++)
    for (let i = 0; i < 3; i++) {
      for (let y = base; y < base + i; y++) put(x + 6 - i, y, z + dz, cobble);
      put(x + 6 - i, base + i, z + dz, stairState(stairs, '-x'));
    }
  // A stone slab terrace in front, a double slab at its start, and a slab step down from it.
  for (let dx = 2; dx <= 6; dx++) put(x + dx, base, z + 6, dx === 2 ? doubleSlabState(slab) : slabState(slab));
  for (let dx = 3; dx <= 5; dx++) put(x + dx, base, z + 7, slabState(slab));
  // The brick column with a stair of each facing round its foot and a stone slab cap.
  for (let y = base; y <= base + 2; y++) put(x, y, z + 7, bricks);
  put(x, base + 3, z + 7, slabState(slab));
  put(x - 1, base, z + 7, stairState(brickStairs, '+x'));
  put(x + 1, base, z + 7, stairState(brickStairs, '-x'));
  put(x, base, z + 6, stairState(brickStairs, '+z'));
  put(x, base, z + 8, stairState(brickStairs, '-z'));
  // Stairs in the ring's corner cells, which connectStairs turns into corners below.
  for (const [dx, dz] of [
    [-1, 6],
    [1, 6],
    [-1, 8],
    [1, 8],
  ])
    put(x + dx, base, z + dz, stairState(brickStairs, dz < 7 ? '+z' : '-z'));
  // A pool in the ground with a waterlogged slab and stair in it.
  for (let dx = 4; dx <= 6; dx++) put(x + dx, base - 1, z + 8, blocks.id('water'));
  put(x + 5, base - 1, z + 8, waterlogState(slabState(slab)));
  put(x + 6, base - 1, z + 8, waterlogState(stairState(stairs, '-x')));
  // Block light under the deck.
  put(x + 1, base, z + 2, torch);
  world.setBlocks(edits);
  for (let dx = -1; dx <= 1; dx++) for (let dz = 6; dz <= 8; dz++) connectStairs(world, x + dx, base, z + dz);
}
