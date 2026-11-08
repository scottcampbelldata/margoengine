// Worker script of VoxelLightWorker (bundled to dist/workers/light.js): a copy of the page's world, lit by the same
// VoxelLighting. Each batch replays the page's chunk loads and unloads, then its edits, lights everything (no budget:
// this thread has no frame to keep) and answers with the light bytes and heightmaps of the chunks that changed.
import { serve } from '../../shared/worker.js';
import { type BlockType, BlockTypes } from './blocks.js';
import { lightOf, VoxelChunk } from './chunk.js';
import { VoxelLighting } from './light.js';
import type { LightJob, LightReply } from './light-worker.js';
import { chunkKey, VoxelWorld } from './world.js';

let world: VoxelWorld | undefined, lighting: VoxelLighting | undefined, blocks: BlockTypes | undefined;
const generations = new Map<string, number>();

// The page's block types, defined again in id order with the options light reads.
const define = (types: readonly BlockType[]): void => {
  for (const t of types) {
    if (t.id === 0 || t.id < blocks!.table.length) continue;
    blocks!.define(t.name, {
      layer: t.layer,
      shape: t.shape,
      solid: t.solid,
      liquid: t.liquid,
      light: t.light,
      opacity: t.opacity,
      ...(t.waterlog ? { waterlog: t.waterlog } : {}),
    });
  }
};

serve((job: LightJob): LightReply => {
  if (job.init) {
    blocks = new BlockTypes();
    world = new VoxelWorld({ blocks, minY: job.init.minY, maxY: job.init.maxY });
    lighting = VoxelLighting.attach(world, { budget: Infinity });
  }
  if (!world || !lighting || !blocks) throw new TypeError('VoxelLightWorker batch before init; attach a new one');
  if (job.types) define(job.types);
  for (const { cx, cy, cz, generation, chunk } of job.chunks) {
    const key = chunkKey(cx, cy, cz);
    if (world.getChunk(cx, cy, cz)) world.removeChunk(cx, cy, cz);
    generations.delete(key);
    if (!chunk) continue;
    world.addChunk(cx, cy, cz, VoxelChunk.unpack(chunk));
    generations.set(key, generation);
  }
  const edits = job.edits;
  for (let i = 0; i < edits.length; i += 4) {
    // The page posts a chunk's load before any edit in it, so every edit lands in a loaded chunk.
    world.setBlock(edits[i], edits[i + 1], edits[i + 2], edits[i + 3] >>> 0);
  }
  lighting.update();
  const reply: LightReply = { batch: job.batch, chunks: [], columns: [] },
    columns = new Set<string>();
  for (const key of world.dirty) {
    const [cx, cy, cz] = key.split(',').map(Number),
      chunk = world.getChunk(cx, cy, cz);
    if (!chunk) continue;
    reply.chunks.push({ cx, cy, cz, generation: generations.get(key) ?? 0, light: lightOf(chunk) });
    const column = `${cx},${cz}`;
    if (columns.has(column)) continue;
    columns.add(column);
    const heights = world.heightmap(cx, cz);
    if (heights) reply.columns.push({ cx, cz, heights: heights.slice() });
  }
  world.dirty.clear();
  return reply;
});
