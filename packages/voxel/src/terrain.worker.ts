// Worker script of VoxelStreamer's built-in generator (bundled to dist/workers/terrain.js): noiseTerrain per job, with
// the streamer's NoiseTerrainOptions in the job. The packed chunk's arrays move back to the page.
import { serve } from '../../shared/worker.js';
import type { BlockType } from './blocks.js';
import { VoxelChunk } from './chunk.js';
import { type NoiseTerrainOptions, noiseTerrain, type VoxelGenerate } from './generate.js';

let options = '',
  generate: VoxelGenerate;
serve(
  ({
    cx,
    cy,
    cz,
    blocks,
    terrain,
  }: {
    cx: number;
    cy: number;
    cz: number;
    blocks: BlockType[];
    terrain: NoiseTerrainOptions;
  }) => {
    const key = JSON.stringify(terrain);
    if (key !== options) {
      generate = noiseTerrain(terrain);
      options = key;
    }
    const chunk = new VoxelChunk();
    generate(chunk, cx, cy, cz, { blocks });
    return chunk.pack();
  },
);
