// @margoengine/voxel: block types, palette chunks and the chunked world (design: packages/voxel/DESIGN.md).
export type { BlockLayer, BlockShape, BlockType, BlockTypeOptions, StairCorner, StairFacing } from './blocks.js';
export {
  BlockTypes,
  blockData,
  blockId,
  blockState,
  connectStairs,
  doubleSlabState,
  shapeOctants,
  slabState,
  stairState,
  waterlogState,
} from './blocks.js';
export type { PackedChunk } from './chunk.js';
export { CHUNK_SIZE, VoxelChunk } from './chunk.js';
export type { VoxelWorldOptions } from './world.js';
export { chunkKey, VoxelWorld } from './world.js';
