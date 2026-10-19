// A small fixed build for the deterministic views (?view=): a plank hut with glass windows, a brick and cobblestone
// roof, torches and a glowstone lamp post, so screenshots show block light, glass and cutout plants. Built on the ground
// it finds, with a cobblestone footing down to it. Only deterministic views place it (a saved world never gets it).
import type { BlockTypes, VoxelWorld } from '@margoengine/voxel';

/** Highest solid block of column (x, z) at or below `from`, or undefined while that part of the world is not loaded. */
export function groundY(world: VoxelWorld, x: number, z: number, from = 96, to = -64): number | undefined {
  const { blocks } = world;
  for (let y = from; y >= to; y--) {
    if (!world.getChunk(x >> 5, y >> 5, z >> 5)) return undefined;
    const type = blocks.get(world.getBlock(x, y, z) & 0xffff);
    if (type.solid && type.shape === 'cube' && type.name !== 'leaves' && type.name !== 'log') return y;
  }
  return undefined;
}

/** True once every chunk the hut at (x, z) can touch is loaded. */
export function showcaseReady(world: VoxelWorld, x: number, z: number): boolean {
  for (let cz = (z - 3) >> 5; cz <= (z + 9) >> 5; cz++)
    for (let cx = (x - 3) >> 5; cx <= (x + 9) >> 5; cx++)
      for (let cy = -1; cy <= 1; cy++) if (!world.getChunk(cx, cy, cz)) return false;
  return true;
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
  let base = -Infinity;
  for (let dz = -2; dz <= 8; dz++)
    for (let dx = -2; dx <= 8; dx++) base = Math.max(base, groundY(world, x + dx, z + dz) ?? -Infinity);
  base += 1;
  // Footing and a cleared yard: cobblestone under the floor down to the ground, air above the yard.
  for (let dz = -2; dz <= 8; dz++)
    for (let dx = -2; dx <= 8; dx++) {
      const ground = groundY(world, x + dx, z + dz) ?? base - 1,
        inside = dx >= 0 && dx <= 6 && dz >= 0 && dz <= 6;
      for (let y = ground + 1; y < base; y++) put(x + dx, y, z + dz, inside ? cobble : id('dirt'));
      if (!inside && ground + 1 <= base - 1) put(x + dx, base - 1, z + dz, id('grass'));
      for (let y = base; y < base + 8; y++) put(x + dx, y, z + dz, 0);
    }
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
